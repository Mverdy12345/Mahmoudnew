'use strict';

/**
 * POST /api/upload?job=<id>&seq=<n>&chunk=<k>
 * رفع أجزاء الملفات — جسم ثنائي خام (application/octet-stream) حتى 4MB.
 * يخزن الجزء في source_chunks (صفّان 2MB كحد أقصى) ويرفض المهمة غير الموجودة/غير المقبولة للرفع.
 */

const { sendJson, sendError, handleOptions, getLimits, isValidJobId, readRawBody, statusLabel } = require('../lib/util');
const db = require('../lib/db');
const storage = require('../lib/storage');

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  try {
    if (req.method !== 'POST') {
      return sendError(res, 405, 'الطريقة غير مسموحة، استخدم POST', { Allow: 'POST, OPTIONS' });
    }

    const query = req.query || {};
    const jobId = String(query.job || '');
    const seq = Number.parseInt(query.seq, 10);
    const chunk = Number.parseInt(query.chunk, 10);
    if (!isValidJobId(jobId)) return sendError(res, 400, 'معرّف المهمة غير صالح');
    if (!Number.isInteger(seq) || seq < 0 || !Number.isInteger(chunk) || chunk < 0) {
      return sendError(res, 400, 'المعلمات seq وchunk يجب أن تكون أرقامًا صحيحة غير سالبة');
    }

    await db.ensureSchema();
    const job = await db.getJob(jobId);
    if (!job) return sendError(res, 404, 'المهمة غير موجودة أو انتهت صلاحيتها');
    if (job.status !== 'queued' && job.status !== 'uploading') {
      return sendError(res, 409, `المهمة لا تقبل الرفع في الحالة الحالية: ${statusLabel(job.status)}`);
    }

    const limits = getLimits();
    const maxChunkBytes = limits.uploadChunkBytes;

    const source = await db.getSource(jobId, seq);
    if (!source) return sendError(res, 404, `لا يوجد مصدر بالتسلسل ${seq} في هذه المهمة`);
    if (source.kind !== 'file') return sendError(res, 409, 'هذا المصدر رابط تنزيل وليس ملفًا مرفوعًا');

    // جسم ثنائي خام حتى 4MB
    let body;
    try {
      body = await readRawBody(req, maxChunkBytes);
    } catch (err) {
      if (err.code === 'BODY_TOO_LARGE') {
        return sendError(res, 413, `حجم الجزء يتجاوز الحد المسموح (${Math.round(maxChunkBytes / (1024 * 1024))}MB)`);
      }
      throw err;
    }
    if (!body.length) return sendError(res, 400, 'جسم الطلب فارغ — أرسل البيانات الثنائية الخام (application/octet-stream)');

    const declared = Number(source.size) || 0;
    const expected = Math.ceil(declared / maxChunkBytes);
    if (chunk >= expected) {
      return sendError(res, 400, `فهرس الجزء ${chunk} خارج النطاق المسموح (0–${Math.max(0, expected - 1)})`);
    }

    const received = await storage.putUploadChunk(jobId, seq, chunk, body);

    if (job.status === 'queued') {
      await db.updateJob(jobId, { status: 'uploading' }).catch(() => {});
    }
    return sendJson(res, 200, { ok: true, received });
  } catch (err) {
    console.error('[api/upload]', err && err.message);
    return sendError(res, 500, 'خطأ داخلي أثناء تخزين الجزء — أعد المحاولة');
  }
};
