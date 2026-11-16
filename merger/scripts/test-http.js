'use strict';

/**
 * اختبارات HTTP — ضد http://127.0.0.1:3010 (dev-server)
 * يشغّل الخادم تلقائيًا إن لم يكن يعمل، ويعيد إيقافه إن كان قد شغّله بنفسه.
 *
 * السيناريو:
 * 1) إنشاء مهمة من روابط → process → بث مع Range يتوقع 206
 * 2) مهمة مختلطة (رابط + ملف مرفوع عبر chunks)
 * 3) حذف → 404 بعد الحذف
 * 4) JSON تالف → 400
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

require('../lib/util');
const util = require('../lib/util');

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3010';
const STATIC_PORT = 3199;

let passed = 0;
let failed = 0;
const failures = [];
let spawnedChild = null;

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

async function jfetch(url, options) {
  const resp = await fetch(url, options);
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* ليس JSON */ }
  return { status: resp.status, headers: resp.headers, json, text, ok: resp.ok };
}

async function waitUntilReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await jfetch(url + '/api/config');
      if (res.status === 200) return true;
    } catch (_) { /* الخادم لم يجهز بعد */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function ensureServer() {
  return waitUntilReady(BASE, 2000).then((running) => {
    if (running) {
      console.log('dev-server يعمل مسبقًا على 3010 — استخدام مباشر');
      return false;
    }
    const logFd = fs.openSync('/tmp/merger-dev.log', 'a');
    spawnedChild = spawn('node', ['dev-server.js'], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', logFd, logFd],
    });
    spawnedChild.on('exit', (code) => { spawnedChild = null; console.log('[dev-server exit]', code); });
    return waitUntilReady(BASE, 20000).then((ready) => {
      if (!ready) throw new Error('dev-server لم يجهز على 3010');
      console.log('dev-server شُغّل تلقائيًا للاختبار');
      return true;
    });
  });
}

function generateTestVideos() {
  const bins = util.getFfmpegPaths();
  if (!bins.ffmpeg) throw new Error('ffmpeg غير متوفر');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmerge-http-'));
  const aPath = path.join(tmp, 'a.mp4'); // 320x240 مع صوت
  const bPath = path.join(tmp, 'b.mp4'); // 640x360 بلا صوت
  const genA = spawnSync(bins.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', aPath], { timeout: 120000 });
  const genB = spawnSync(bins.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', bPath], { timeout: 120000 });
  if (genA.status !== 0 || genB.status !== 0) {
    throw new Error('فشل توليد فيديوهات الاختبار: ' + ((genA.stderr || genB.stderr) || '').toString().slice(-200));
  }
  return { tmp, aBuf: fs.readFileSync(aPath), bBuf: fs.readFileSync(bPath), cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

function startStaticServer(files) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://x').pathname;
      const body = files[pathname];
      if (!body) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(body.length) });
      res.end(body);
    });
    server.listen(STATIC_PORT, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  console.log('== اختبارات HTTP ضد ' + BASE + ' ==\n');

  const serverWasRunning = await ensureServer();

  const tv = generateTestVideos();
  const staticServer = await startStaticServer({
    '/a.mp4': tv.aBuf,
    '/b.mp4': tv.bBuf,
  });
  const urlA = `http://127.0.0.1:${STATIC_PORT}/a.mp4`;
  const urlB = `http://127.0.0.1:${STATIC_PORT}/b.mp4`;

  try {
    /* ---------- 0) config ---------- */
    await tryCheck('GET /api/config يعيد الحدود والإصدار', async () => {
      const res = await jfetch(BASE + '/api/config');
      return res.status === 200
        && res.json.version === '1.0.0'
        && res.json.maxSources === 10
        && res.json.uploadChunkBytes === 4194304
        && res.json.sourceMaxMB === 200;
    });
    await tryCheck('OPTIONS preflight يعيد 204 مع CORS مفتوح', async () => {
      const res = await jfetch(BASE + '/api/jobs', { method: 'OPTIONS' });
      return res.status === 204 && res.headers.get('access-control-allow-origin') === '*';
    });
    await tryCheck('POST /api/config يرفض 405', async () => {
      const res = await jfetch(BASE + '/api/config', { method: 'POST', body: '{}' });
      return res.status === 405;
    });

    /* ---------- 1) مهمة من روابط → process → Range ---------- */
    let job1 = null;
    await tryCheck('POST /api/jobs بروابط يعيد 201 مع الروابط', async () => {
      const res = await jfetch(BASE + '/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videos: [urlA, urlB] }),
      });
      job1 = res.json;
      return res.status === 201 && job1.jobId && job1.statusUrl && job1.processUrl && job1.expiresAt && job1.status === 'queued';
    });

    await tryCheck('GET حالة المهمة الجديدة يعيد التقدم', async () => {
      const res = await jfetch(job1.statusUrl);
      return res.status === 200 && typeof res.json.progress === 'number' && res.json.status === 'queued';
    });

    await tryCheck('POST process ينفذ الدمج ويعيد النتيجة (done)', async () => {
      const res = await jfetch(job1.processUrl, { method: 'POST' });
      const j = res.json || {};
      return res.status === 200 && j.status === 'done'
        && j.videoUrl && j.downloadUrl && j.size > 0 && j.duration > 0
        && j.resolution === '640x360'
        && !!j.expiresAt;
    });

    await tryCheck('بث الفيديو مع Range: bytes=0-1023 يعيد 206 + Content-Range + طول صحيح', async () => {
      const res = await fetch(BASE + `/api/jobs/${job1.jobId}/video`, { headers: { Range: 'bytes=0-1023' } });
      const ab = await res.arrayBuffer();
      return res.status === 206
        && res.headers.get('accept-ranges') === 'bytes'
        && (res.headers.get('content-range') || '').startsWith('bytes 0-1023/')
        && ab.byteLength === 1024;
    });

    await tryCheck('بث مع Range وسط الملف يعيد 206 بالطول الصحيح', async () => {
      // نحسب النطاق من الحجم الفعلي للناتج بدل إزاحة ثابتة قد تتجاوز حجم ملف صغير
      const statusRes = await jfetch(BASE + `/api/jobs/${job1.jobId}`);
      const size = Number(statusRes.json.size);
      if (!size || size < 2000) return false;
      const mid = Math.floor(size / 2);
      const res = await fetch(BASE + `/api/jobs/${job1.jobId}/video`, { headers: { Range: `bytes=${mid}-${mid + 999}` } });
      const ab = await res.arrayBuffer();
      return res.status === 206 && ab.byteLength === 1000
        && (res.headers.get('content-range') || '').startsWith(`bytes ${mid}-${mid + 999}/`);
    });

    await tryCheck('بث مع Range غير منطقي يعيد 416', async () => {
      const res = await fetch(BASE + `/api/jobs/${job1.jobId}/video`, { headers: { Range: 'bytes=999999999-' } });
      await res.arrayBuffer().catch(() => null);
      return res.status === 416;
    });

    await tryCheck('بث كامل بدون Range يعيد 200 بالحجم الكامل', async () => {
      const res = await fetch(BASE + `/api/jobs/${job1.jobId}/video`);
      const ab = await res.arrayBuffer();
      const statusRes = await jfetch(BASE + `/api/jobs/${job1.jobId}`);
      return res.status === 200 && Number(res.headers.get('content-length')) === statusRes.json.size && ab.byteLength === statusRes.json.size;
    });

    await tryCheck('?download=1 يضيف Content-Disposition: attachment', async () => {
      const res = await fetch(BASE + `/api/jobs/${job1.jobId}/video?download=1`, { headers: { Range: 'bytes=0-99' } });
      await res.arrayBuffer().catch(() => null);
      return (res.headers.get('content-disposition') || '').startsWith('attachment');
    });

    /* ---------- 2) مهمة مختلطة (رابط + ملف مرفوع عبر chunks) ---------- */
    let job2 = null;
    await tryCheck('POST /api/jobs مختلطة يعيد 201 مع خطة الرفع uploads[]', async () => {
      const res = await jfetch(BASE + '/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sources: [
            { kind: 'url', url: urlA },
            { kind: 'file', name: 'clip.mp4', size: tv.bBuf.length, mime: 'video/mp4' },
          ],
        }),
      });
      job2 = res.json;
      return res.status === 201 && job2.status === 'uploading'
        && Array.isArray(job2.uploads) && job2.uploads.length === 1
        && job2.uploadChunkBytes === 4194304
        && job2.uploads[0].chunks === Math.ceil(tv.bBuf.length / 4194304);
    });

    await tryCheck('رفع كل أجزاء الملف عبر /api/upload (مع إعادة محاولة ×3)', async () => {
      const up = job2.uploads[0];
      const chunkBytes = job2.uploadChunkBytes;
      for (let k = 0; k < up.chunks; k++) {
        const blob = tv.bBuf.subarray(k * chunkBytes, Math.min((k + 1) * chunkBytes, tv.bBuf.length));
        let done = false;
        let lastErr = null;
        for (let attempt = 0; attempt < 3 && !done; attempt++) {
          try {
            const res = await jfetch(up.uploadUrl + '&chunk=' + k, {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: blob,
            });
            if (res.status === 200 && res.json.ok && res.json.received === blob.length) done = true;
            else lastErr = `رمز ${res.status}: ${res.text.slice(0, 120)}`;
          } catch (err) { lastErr = err.message; }
          if (!done) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
        if (!done) return false;
      }
      return true;
    });

    await tryCheck('رفع فهرس جزء خارج النطاق يرفض 400', async () => {
      const up = job2.uploads[0];
      const res = await jfetch(up.uploadUrl + '&chunk=' + up.chunks, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.alloc(1024),
      });
      return res.status === 400;
    });

    await tryCheck('process للمهمة المختلطة ينجح (رابط + ملف)', async () => {
      const res = await jfetch(job2.processUrl, { method: 'POST' });
      const j = res.json || {};
      return res.status === 200 && j.status === 'done'
        && j.resolution === '640x360'
        && Math.abs((j.duration || 0) - 5) <= 1;
    });

    /* ---------- 3) حذف → 404 بعد الحذف ---------- */
    await tryCheck('DELETE /api/jobs/<id> يحذف فورًا', async () => {
      const res = await jfetch(BASE + `/api/jobs/${job2.jobId}`, { method: 'DELETE' });
      return res.status === 200 && res.json.ok === true;
    });
    await tryCheck('GET بعد الحذف يعيد 404', async () => {
      const res = await jfetch(BASE + `/api/jobs/${job2.jobId}`);
      return res.status === 404;
    });
    await tryCheck('GET video بعد الحذف يعيد 404', async () => {
      const res = await jfetch(BASE + `/api/jobs/${job2.jobId}/video`);
      return res.status === 404;
    });
    await tryCheck('DELETE مرة أخرى يعيد 404', async () => {
      const res = await jfetch(BASE + `/api/jobs/${job2.jobId}`, { method: 'DELETE' });
      return res.status === 404;
    });

    /* ---------- 4) أخطاء المدخلات ---------- */
    await tryCheck('JSON تالف يعيد 400', async () => {
      const res = await jfetch(BASE + '/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{هذا ليس JSON',
      });
      return res.status === 400;
    });
    await tryCheck('مصادر فارغة تعيد 400', async () => {
      const res = await jfetch(BASE + '/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videos: [] }),
      });
      return res.status === 400;
    });
    await tryCheck('رابط غير صالح يعيد 400', async () => {
      const res = await jfetch(BASE + '/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videos: ['ftp://bad.example/video.mp4'] }),
      });
      return res.status === 400;
    });
    await tryCheck('مهمة غير موجودة تعيد 404', async () => {
      const res = await jfetch(BASE + '/api/jobs/zz9zz9zz9z');
      return res.status === 404;
    });
    await tryCheck('رفع لمهمة غير موجودة يعيد 404', async () => {
      const res = await jfetch(BASE + '/api/upload?job=zz9zz9zz9z&seq=0&chunk=0', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.alloc(1024),
      });
      return res.status === 404;
    });
    await tryCheck('جزء أكبر من 4MB يرفض 413', async () => {
      const create = await jfetch(BASE + '/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: [{ kind: 'file', name: 'big.mp4', size: 5 * 1024 * 1024, mime: 'video/mp4' }] }),
      });
      if (create.status !== 201) return false;
      const up = create.json.uploads[0];
      const res = await jfetch(up.uploadUrl + '&chunk=0', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.alloc(4 * 1024 * 1024 + 1024),
      });
      await jfetch(BASE + `/api/jobs/${create.json.jobId}`, { method: 'DELETE' });
      return res.status === 413;
    });
    await tryCheck('مسار غير موجود يعيد 404', async () => {
      const res = await jfetch(BASE + '/api/nonexistent');
      return res.status === 404;
    });
    await tryCheck('GET /api/cron يعمل', async () => {
      const res = await jfetch(BASE + '/api/cron');
      return res.status === 200 && res.json.ok === true && typeof res.json.deleted === 'number';
    });
  } finally {
    staticServer.close();
    tv.cleanup();
    if (spawnedChild) {
      spawnedChild.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 800));
      console.log('dev-server الذي شغّله الاختبار أُوقف — شغّله بنفسك عبر: node dev-server.js');
    }
  }

  console.log('\n=== نتيجة اختبار HTTP: نجح ' + passed + ' / فشل ' + failed + ' ===');
  if (failures.length) failures.forEach((f) => console.log('  فشل: ' + f));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('خطأ غير متوقع في اختبار HTTP:', err && err.message);
  process.exit(1);
});
