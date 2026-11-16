'use strict';

/**
 * محرك الدمج — ffmpeg (الأهم في الخدمة)
 *
 * - ffprobe لكل مصدر: الدقة، معدل الإطارات، المدة، وجود صوت، الترميز.
 * - توحيد كل المصادر عبر filter_complex: scale + pad إلى أكبر دقة بين المدخلات
 *   (حد أقصى 1920×1080، أبعاد زوجية)، fps=30، setsar=1، format=yuv420p ثم concat.
 * - مصدر بلا صوت؟ مسار صامت anullsrc بنفس مدته (-f lavfi -t <dur> -i anullsrc=r=44100:cl=stereo)
 *   بدل أن يفشل الدمج. المسارات الصوتية تُوحَّد: aresample=44100 + aformat=stereo.
 * - الترميز النهائي: libx264 CRF 18 + AAC 192k/44100Hz + -movflags +faststart (MP4 عالي الجودة).
 * - التقدم: قراءة out_time_us من -progress pipe:1 وحساب النسبة من المدة الإجمالية
 *   (0–40 سحب المصادر، 40–90 ترميز، 92–99 حفظ الناتج، 100 اكتمال).
 * - التحقق من الحدود قبل وأثناء العمل — تجاوز أي حد = فشل واضح برسالة عربية في job.error.
 * - كل عمليات ffmpeg في /tmp/{jobId}/ مع تنظيف نهائي في finally.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { getFfmpegPaths, getLimits, envInt, sanitizeMessage } = require('./util');
const db = require('./db');
const storage = require('./storage');

class MergeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MergeError';
    this.code = code || 'MERGE_FAILED';
  }
}

/* ---------------- أدوات تنفيذ الأوامر ---------------- */

function lastMeaningfulLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

function runCommand(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!bin) {
      reject(new MergeError('ffmpeg/ffprobe غير متوفر على الخادم — اضبط FFMPEG_PATH وFFPROBE_PATH'));
      return;
    }
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill('SIGKILL'); } catch (_) { /* تجاهل */ }
        reject(new MergeError('انتهت المهلة أثناء تنفيذ أمر ffmpeg/ffprobe'));
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > 4 * 1024 * 1024) stdout = stdout.slice(-2 * 1024 * 1024);
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
    });
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new MergeError('فشل تشغيل ' + path.basename(bin) + ': ' + sanitizeMessage(err.message)));
      }
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve({ stdout, stderr });
        else reject(new MergeError('أمر ffmpeg/ffprobe فشل (رمز ' + code + '): ' + sanitizeMessage(lastMeaningfulLine(stderr))));
      }
    });
  });
}

/* ---------------- التحليل (ffprobe) ---------------- */

async function probeSource(file, timeoutMs = 30000) {
  const { ffprobe } = getFfmpegPaths();
  const { stdout } = await runCommand(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], timeoutMs);
  let json;
  try {
    json = JSON.parse(stdout);
  } catch (_) {
    throw new MergeError('تعذر تحليل بيانات الملف — قد يكون تالفًا أو ليس فيديو صالحًا');
  }
  let width = 0;
  let height = 0;
  let fps = 0;
  let hasAudio = false;
  let hasVideo = false;
  let duration = 0;
  let codec = null;
  for (const stream of json.streams || []) {
    if (stream.codec_type === 'video' && !hasVideo) {
      hasVideo = true;
      width = Math.max(width, Number(stream.width) || 0);
      height = Math.max(height, Number(stream.height) || 0);
      codec = stream.codec_name || codec;
      const rate = String(stream.avg_frame_rate || stream.r_frame_rate || '0/1');
      const parts = rate.split('/');
      const value = Number(parts[0]) / (Number(parts[1]) || 1);
      if (Number.isFinite(value) && value > fps) fps = value;
      const sd = Number(stream.duration);
      if (Number.isFinite(sd) && sd > duration) duration = sd;
    } else if (stream.codec_type === 'audio') {
      hasAudio = true;
      const sd = Number(stream.duration);
      if (Number.isFinite(sd) && sd > duration) duration = sd;
    }
  }
  const formatDuration = Number(json.format && json.format.duration);
  if (Number.isFinite(formatDuration) && formatDuration > duration) duration = formatDuration;
  return { width, height, fps, hasAudio, hasVideo, duration, codec };
}

/* ---------------- بناء أمر الدمج ---------------- */

/** أكبر دقة بين المدخلات بحد أقصى 1920×1080 وأبعاد زوجية */
function computeTargetSize(probes) {
  let width = 0;
  let height = 0;
  for (const p of probes) {
    width = Math.max(width, p.width);
    height = Math.max(height, p.height);
  }
  width = Math.min(width || 1280, 1920);
  height = Math.min(height || 720, 1080);
  width -= width % 2;
  height -= height % 2;
  if (width < 2 || height < 2) throw new MergeError('تعذر تحديد دقة صالحة للدمج');
  return { width, height };
}

function buildFfmpegArgs({ files, probes, target, outPath, preset }) {
  const W = target.width;
  const H = target.height;
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];

  // مدخلات ملفات المصادر بالترتيب
  for (const f of files) args.push('-i', f);

  // مدخلات صامتة (lavfi) للمصادر بلا صوت — خيارات الإدخال (-t) قبل -i
  const lavfiIndexOf = new Map();
  probes.forEach((p, i) => {
    if (!p.hasAudio) {
      const dur = Math.max(0.2, p.duration || 1);
      args.push('-f', 'lavfi', '-t', dur.toFixed(3), '-i', 'anullsrc=r=44100:cl=stereo');
      lavfiIndexOf.set(i, files.length + lavfiIndexOf.size);
    }
  });

  // سلسلة الفلاتر: توحيد كل مدخل ثم concat
  const parts = [];
  const refs = [];
  probes.forEach((p, i) => {
    parts.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`);
    if (p.hasAudio) {
      parts.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    } else {
      const lavfiIdx = lavfiIndexOf.get(i);
      parts.push(`[${lavfiIdx}:a]aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    }
    refs.push(`[v${i}][a${i}]`);
  });
  parts.push(`${refs.join('')}concat=n=${probes.length}:v=1:a=1[vcat][acat]`);
  args.push('-filter_complex', parts.join(';'));

  args.push('-map', '[vcat]', '-map', '[acat]');
  args.push('-c:v', 'libx264', '-preset', String(preset || process.env.FFMPEG_PRESET || 'medium'), '-crf', '18');
  args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '44100');
  args.push('-movflags', '+faststart');
  args.push('-progress', 'pipe:1', '-nostats');
  args.push(outPath);
  return args;
}

/* ---------------- الترميز مع قراءة التقدم ---------------- */

async function encode(args, totalDuration, onProgress, timeoutMs) {
  const { ffmpeg } = getFfmpegPaths();
  if (!ffmpeg) throw new MergeError('ffmpeg غير متوفر على الخادم — اضبط FFMPEG_PATH');
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '';
    let settled = false;
    let lastPct = -1;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill('SIGKILL'); } catch (_) { /* تجاهل */ }
        reject(new MergeError('انتهت المهلة أثناء ترميز الفيديو — جرّب سرعة أعلى عبر FFMPEG_PRESET=veryfast'));
      }
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      const text = d.toString();
      let seconds = -1;
      let match;
      const reUs = /out_time_us=(\d+)/g;
      while ((match = reUs.exec(text)) !== null) seconds = Number(match[1]) / 1e6;
      if (seconds < 0) {
        const reMs = /out_time_ms=(\d+)/g; // ملاحظة: out_time_ms في ffmpeg بوحدات الميكروثانية
        while ((match = reMs.exec(text)) !== null) seconds = Number(match[1]) / 1e6;
      }
      if (seconds < 0) {
        const reTime = /out_time=(\d+):(\d+):(\d+)/g;
        while ((match = reTime.exec(text)) !== null) {
          seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
        }
      }
      if (seconds >= 0 && totalDuration > 0) {
        const pct = Math.max(0, Math.min(50, Math.round((seconds / totalDuration) * 50)));
        if (pct !== lastPct && onProgress) {
          lastPct = pct;
          try { onProgress(pct); } catch (_) { /* تجاهل */ }
        }
      }
    });
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new MergeError('فشل تشغيل ffmpeg: ' + sanitizeMessage(err.message)));
      }
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new MergeError('فشل ترميز الفيديو: ' + sanitizeMessage(lastMeaningfulLine(stderrTail))));
      }
    });
  });
}

/* ---------------- الدمج الأساسي (يُستخدم أيضًا من اختبارات الوحدة) ---------------- */

/**
 * دمج ملفات محلية إلى ملف واحد:
 * يقود الحدود (مجموع المدد)، يبني الأمر، يرمّز مع تقدم، ثم يفحص الناتج.
 */
async function mergeFiles({ files, outPath, preset, timeoutMs, onProgress }) {
  const limits = getLimits();
  const timeout = timeoutMs || envInt('FFMPEG_TIMEOUT_MS', 270000);
  const probes = [];
  for (const f of files) probes.push(await probeSource(f));
  probes.forEach((p, i) => {
    if (!p.hasVideo) throw new MergeError(`المصدر رقم ${i + 1} لا يحتوي على مسار فيديو صالح`);
    if (!p.duration || p.duration <= 0) throw new MergeError(`تعذر تحديد مدة المصدر رقم ${i + 1}`);
  });
  const totalDuration = probes.reduce((sum, p) => sum + p.duration, 0);
  if (limits.maxTotalDurationSec > 0 && totalDuration > limits.maxTotalDurationSec + 0.5) {
    throw new MergeError(`مجموع مدد المصادر (${Math.round(totalDuration)} ثانية) يتجاوز الحد المسموح (${limits.maxTotalDurationSec} ثانية)`);
  }
  const target = computeTargetSize(probes);
  const args = buildFfmpegArgs({ files, probes, target, outPath, preset });
  await encode(args, totalDuration, (pct) => onProgress && onProgress({ phase: 'encode', pct, totalDuration }), timeout);
  const output = await probeSource(outPath, 60000);
  const size = fs.statSync(outPath).size;
  return { probes, totalDuration, target, output, size };
}

/* ---------------- تنزيل روابط المصادر ---------------- */

/** تنزيل رابط إلى ملف مؤقت مع تدفق + عدّ بايتات + حد حجم + إعادة محاولة واحدة للأخطاء العابرة */
async function downloadToFile(url, destPath, maxBytes, onBytes) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    throw new MergeError('رابط المصدر غير صالح');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new MergeError('رابط المصدر يجب أن يستخدم بروتوكول http أو https');
  }

  const attempt = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), envInt('DOWNLOAD_TIMEOUT_MS', 120000));
    try {
      const resp = await fetch(parsed, { signal: controller.signal, redirect: 'follow' });
      if (!resp.ok) throw new MergeError(`فشل تنزيل المصدر — استجابة الخادم ${resp.status}`);
      const contentLength = Number(resp.headers.get('content-length') || 0);
      if (contentLength > maxBytes) {
        throw new MergeError(`حجم المصدر (${Math.round(contentLength / (1024 * 1024))}MB) يتجاوز الحد المسموح (${Math.round(maxBytes / (1024 * 1024))}MB)`);
      }
      if (!resp.body) throw new MergeError('المصدر لا يحتوي على بيانات قابلة للتنزيل');
      let bytes = 0;
      const out = fs.createWriteStream(destPath);
      for await (const chunk of resp.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buf.length;
        if (bytes > maxBytes) {
          out.destroy();
          throw new MergeError(`حجم المصدر يتجاوز الحد المسموح (${Math.round(maxBytes / (1024 * 1024))}MB) أثناء التنزيل`);
        }
        if (!out.write(buf)) {
          await new Promise((resolve) => out.once('drain', resolve));
        }
        if (onBytes) {
          try { onBytes(bytes); } catch (_) { /* تجاهل */ }
        }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      if (bytes === 0) throw new MergeError('المصدر فارغ أو غير قابل للتنزيل');
      return bytes;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await attempt();
  } catch (err) {
    if (err && err.name === 'MergeError') throw err; // أخطاء منطقية/حدود — لا إعادة
    return attempt(); // خطأ شبكة عابر — إعادة محاولة واحدة بسيطة
  }
}

/* ---------------- تنفيذ المهمة كاملة (سحب → ترميز → تخزين) ---------------- */

async function processJob(jobId) {
  await db.ensureSchema();
  const job = await db.getJob(jobId);
  if (!job) throw new MergeError('المهمة غير موجودة', 'NOT_FOUND');
  const sources = await db.getSources(jobId);
  const limits = getLimits();
  if (!sources.length) throw new MergeError('لا توجد مصادر في هذه المهمة');
  if (sources.length > limits.maxSources) {
    throw new MergeError(`عدد المصادر (${sources.length}) يتجاوز الحد المسموح (${limits.maxSources})`);
  }

  const dir = path.join(os.tmpdir(), 'vmerge-' + jobId);
  await fsp.mkdir(dir, { recursive: true });
  let lastDbWrite = 0;

  // كاتب تقدم مقيد التردد (تجنب ضرب قاعدة البيانات عند كل تحديث)
  const setProgress = async (value, force) => {
    const now = Date.now();
    if (!force && now - lastDbWrite < 500) return;
    lastDbWrite = now;
    const progress = Math.max(0, Math.min(100, Math.round(value)));
    try { await db.updateJob(jobId, { progress }); } catch (_) { /* التقدم اختياري */ }
  };

  try {
    const files = [];
    const maxBytes = limits.sourceMaxMB * 1024 * 1024;
    const n = sources.length;

    // المرحلة 0–40: سحب المصادر
    for (let i = 0; i < n; i++) {
      const s = sources[i];
      const dest = path.join(dir, 'src_' + i);
      await setProgress(4 + Math.round((i / n) * 30), true);
      if (s.kind === 'url') {
        await downloadToFile(s.url, dest, maxBytes, () => {
          setProgress(4 + Math.round(((i + 0.9) / n) * 30));
        });
      } else {
        const bytes = await storage.extractSourceToFile(jobId, s.seq, dest, maxBytes);
        const declared = Number(s.size) || 0;
        if (declared > 0 && bytes !== declared) {
          throw new MergeError(`أجزاء الملف المرفوع "${s.name || 'مصدر ' + (i + 1)}" غير مكتملة (المتوقع ${declared} بايت والمستلم ${bytes})`);
        }
      }
      files.push(dest);
    }
    await setProgress(38, true);

    // المرحلة 40–90: الترميز
    const outPath = path.join(dir, 'output.mp4');
    const result = await mergeFiles({
      files,
      outPath,
      onProgress: ({ pct }) => setProgress(40 + pct),
    });

    // فحص حد حجم الناتج قبل التخزين
    if (limits.outputMaxMB > 0 && result.size > limits.outputMaxMB * 1024 * 1024) {
      throw new MergeError(`حجم الفيديو الناتج (${Math.round(result.size / (1024 * 1024))}MB) يتجاوز الحد المسموح (${limits.outputMaxMB}MB)`);
    }

    // المرحلة 92–99: حفظ الناتج في Turso
    await setProgress(92, true);
    await storage.putOutputChunks(jobId, outPath, (done, total) => setProgress(92 + (done / total) * 7));

    const duration = result.output.duration > 0 ? result.output.duration : result.totalDuration;
    await db.updateJob(jobId, {
      status: 'done',
      progress: 100,
      error: null,
      size: result.size,
      duration: Math.round(duration * 100) / 100,
      resolution: `${result.output.width}x${result.output.height}`,
      completed_at: new Date().toISOString(),
    });

    // بعد نجاح الدمج نحذف أجزاء المصادر — الناتج فقط هو المطلوب
    await db.exec('DELETE FROM source_chunks WHERE job_id = ?', [jobId]).catch(() => {});

    return {
      ok: true,
      size: result.size,
      duration: Math.round(duration * 100) / 100,
      resolution: `${result.output.width}x${result.output.height}`,
    };
  } catch (err) {
    const message = err && err.name === 'MergeError' ? err.message : sanitizeMessage(err && err.message);
    try { await db.updateJob(jobId, { status: 'failed', error: message }); } catch (_) { /* تجاهل */ }
    throw err;
  } finally {
    // تنظيف /tmp/{jobId} نهائيًا مهما كانت النتيجة
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  MergeError,
  probeSource,
  computeTargetSize,
  buildFfmpegArgs,
  mergeFiles,
  downloadToFile,
  processJob,
};
