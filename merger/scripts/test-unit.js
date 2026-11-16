'use strict';

/**
 * اختبارات وحدة — التشغيل: node scripts/test-unit.js
 * 1) توليد فيديوهين محليين بأوضاع مختلفة (الأول مع صوت tone، الثاني بلا صوت) ودمجهما عبر lib/merge مباشرة
 * 2) التحقق: اكتمال الدمج، الدقة = أكبر دقة مدخل، المدة ≈ مجموع المدد، وجود مسار صوتي
 * 3) اختبار Turso: تخزين Blob واسترجاعه بتطابق sha256، تقسيم/قراءة الأجزاء، النطاق (Range)
 * 4) رفض تجاوز حدود الحجم + الحذف الشامل
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

require('../lib/util'); // تحميل .env مبكرًا
const util = require('../lib/util');
const db = require('../lib/db');
const storage = require('../lib/storage');
const cleanup = require('../lib/cleanup');
const merge = require('../lib/merge');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, extra) {
  if (condition) {
    passed += 1;
    console.log('  [PASS] ' + name);
  } else {
    failed += 1;
    failures.push(name);
    console.log('  [FAIL] ' + name + (extra ? ' — ' + String(extra).slice(0, 300) : ''));
  }
}

async function tryCheck(name, fn) {
  try {
    const result = await fn();
    check(name, result === undefined ? true : result, typeof result === 'string' ? result : '');
  } catch (err) {
    check(name, false, err && err.message);
  }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function streamToBuffer(streamOrIterable) {
  const chunks = [];
  for await (const chunk of streamOrIterable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function finish() {
  console.log('\n=== نتيجة اختبار الوحدة: نجح ' + passed + ' / فشل ' + failed + ' ===');
  if (failures.length) {
    failures.forEach((f) => console.log('  فشل: ' + f));
  }
  process.exit(failed > 0 ? 1 : 0);
}

async function main() {
  console.log('== اختبارات وحدة Video Merger ==\n');

  /* ---------- 0) توفر الثنائيات ---------- */
  const bins = util.getFfmpegPaths();
  check('توفر ffmpeg', !!bins.ffmpeg, 'ffmpeg غير موجود');
  check('توفر ffprobe', !!bins.ffprobe, 'ffprobe غير موجود');
  if (!bins.ffmpeg || !bins.ffprobe) {
    finish();
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmerge-unit-'));
  const aPath = path.join(tmp, 'a.mp4'); // 320x240 مع صوت tone
  const bPath = path.join(tmp, 'b.mp4'); // 640x360 بلا صوت
  const outPath = path.join(tmp, 'merged.mp4');

  try {
    /* ---------- 1) توليد الفيديوهين ---------- */
    const genA = spawnSync(
      bins.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=2',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
        '-c:a', 'aac', '-shortest', aPath],
      { timeout: 120000 }
    );
    const genB = spawnSync(
      bins.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15:duration=3',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', bPath],
      { timeout: 120000 }
    );
    check('توليد الفيديو الأول (320x240 مع صوت tone)', genA.status === 0 && fs.existsSync(aPath), genA.stderr && genA.stderr.toString().slice(-200));
    check('توليد الفيديو الثاني (640x360 بلا صوت)', genB.status === 0 && fs.existsSync(bPath), genB.stderr && genB.stderr.toString().slice(-200));

    /* ---------- 2) الدمج عبر lib/merge مباشرة ---------- */
    const progressSteps = [];
    let merged = null;
    await tryCheck('اكتمال الدمج', async () => {
      merged = await merge.mergeFiles({
        files: [aPath, bPath],
        outPath,
        onProgress: (p) => progressSteps.push(p.pct),
      });
      return fs.existsSync(outPath) && merged.size > 0;
    });
    if (merged) {
      check('الدقة الناتجة = أكبر دقة مدخل (640x360)', merged.output.width === 640 && merged.output.height === 360, `${merged.output.width}x${merged.output.height}`);
      check('المدة ≈ مجموع المدد (≈5 ثوان)', Math.abs(merged.output.duration - 5) <= 0.8, String(merged.output.duration));
      check('وجود مسار صوتي في الناتج (تعويض الصمت للثاني)', merged.output.hasAudio === true);
      check('ترميز الناتج h264/mp4', merged.output.codec === 'h264', String(merged.output.codec));
      check('تحديثات تقدم الترميز (0-50)', progressSteps.some((p) => p > 0), JSON.stringify(progressSteps.slice(0, 5)));
    }

    /* ---------- 3) اختبارات Turso ---------- */
    await tryCheck('تهيئة مخطط قاعدة البيانات (Turso)', async () => {
      await db.ensureSchema();
      return true;
    });

    const jobId = 'ut' + util.newJobId(8);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

    await tryCheck('إدراج مهمة + مصدر في القاعدة', async () => {
      await db.insertJob(
        { id: jobId, status: 'uploading', sourcesJson: '[]', createdAt, expiresAt },
        [{ seq: 0, kind: 'file', name: 'unit-test.mp4', size: 4 * 1024 * 1024, mime: 'video/mp4' }]
      );
      const job = await db.getJob(jobId);
      return !!job && job.status === 'uploading';
    });

    // تخزين blob (5MB + 137 بايت → 3 صفوف) واسترجاعه بتطابق sha256
    const oneMB = crypto.randomBytes(1024 * 1024);
    const blob = Buffer.concat([oneMB, oneMB, oneMB, oneMB, oneMB, crypto.randomBytes(137)]);
    const blobPath = path.join(tmp, 'blob.bin');
    fs.writeFileSync(blobPath, blob);
    await tryCheck('تقسيم Blob إلى صفوف 2MB وتخزينه في Turso', async () => {
      const written = await storage.putOutputChunks(jobId, blobPath);
      return written === blob.length;
    });
    await tryCheck('عدد الصفوف صحيح (3 صفوف) وكل صف ≤ 2MB', async () => {
      const rows = await storage.blobRowCount('output_chunks', jobId);
      const maxLen = await db.all('SELECT MAX(LENGTH(data)) AS m FROM output_chunks WHERE job_id = ?', [jobId]);
      return rows === 3 && Number(maxLen[0].m) <= util.STORAGE_CHUNK_BYTES;
    });
    await tryCheck('استرجاع Blob كاملًا بتطابق sha256', async () => {
      const back = await streamToBuffer(storage.iterateBlob({ table: 'output_chunks', jobId }));
      return sha256(back) === sha256(blob);
    });
    await tryCheck('قراءة نطاق بايتي (Range) بتطابق sha256', async () => {
      const start = 1000000;
      const end = start + 999999;
      const slice = await streamToBuffer(storage.iterateBlob({ table: 'output_chunks', jobId, start, end }));
      return slice.length === 1000000 && sha256(slice) === sha256(blob.subarray(start, end + 1));
    });
    await tryCheck('حجم Blob المخزّن يطابق الأصل', async () => {
      return (await storage.blobSize('output_chunks', jobId)) === blob.length;
    });

    // تقسيم/قراءة أجزاء الرفع (4MB → صفّان 2MB)
    const uploadChunk = Buffer.concat([oneMB, oneMB, oneMB, oneMB]);
    await tryCheck('تقسيم جزء رفع 4MB إلى صفّين وقراءته بتطابق sha256', async () => {
      const received = await storage.putUploadChunk(jobId, 0, 0, uploadChunk);
      if (received !== uploadChunk.length) return false;
      const back = await streamToBuffer(storage.iterateBlob({ table: 'source_chunks', jobId, seq: 0 }));
      return sha256(back) === sha256(uploadChunk);
    });

    // رفض تجاوز حدود الحجم
    await tryCheck('رفض سحب مصدر يتجاوز حد الحجم (SOURCE_TOO_LARGE)', async () => {
      let rejected = false;
      try {
        await storage.extractSourceToFile(jobId, 0, path.join(tmp, 'capped.bin'), 1024 * 1024); // حد 1MB < 4MB
      } catch (err) {
        rejected = err && err.code === 'SOURCE_TOO_LARGE';
      }
      return rejected;
    });
    await tryCheck('رفض جزء رفع أكبر من 4MB', async () => {
      let rejected = false;
      try {
        await storage.putUploadChunk(jobId, 0, 1, Buffer.alloc(4 * 1024 * 1024 + 1));
      } catch (err) {
        rejected = err && err.code === 'CHUNK_TOO_LARGE';
      }
      return rejected;
    });
    await tryCheck('رفض مصادر تتجاوز الحد عبر getLimits/processJob (مجموع المدد)', async () => {
      // فيديو طويل اصطناعي 12 ثانية ×2 → مجموع 24 ث... نستخدم فحص الحد مباشرة عبر mergeFiles على ملف واحد طويل؟
      // أسرع: التحقق من منطق الحد عبر دمج ملفين قصيرين مع حد مضبوط بيئةً مؤقتة
      const old = process.env.MAX_TOTAL_DURATION_SEC;
      process.env.MAX_TOTAL_DURATION_SEC = '3';
      let rejected = false;
      try {
        await merge.mergeFiles({ files: [aPath, bPath], outPath: path.join(tmp, 'x.mp4') });
      } catch (err) {
        rejected = err && err.name === 'MergeError' && /يتجاوز الحد/.test(err.message);
      } finally {
        if (old === undefined) delete process.env.MAX_TOTAL_DURATION_SEC;
        else process.env.MAX_TOTAL_DURATION_SEC = old;
      }
      return rejected;
    });

    /* ---------- 4) الحذف الشامل ---------- */
    await tryCheck('الحذف الشامل يفرغ الجداول الأربعة', async () => {
      await cleanup.deleteJobEverywhere(jobId);
      const counts = await Promise.all([
        db.countRows('jobs', jobId),
        db.countRows('sources', jobId),
        db.countRows('source_chunks', jobId),
        db.countRows('output_chunks', jobId),
      ]);
      return counts.every((n) => n === 0);
    });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* تجاهل */ }
  }

  finish();
}

main().catch((err) => {
  console.error('خطأ غير متوقع في الاختبار:', err && err.message);
  finish();
});
