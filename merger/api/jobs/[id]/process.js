'use strict';

/**
 * POST /api/jobs/<id>/process — تنفيذ الدمج كاملًا بشكل متزامن:
 * سحب/سحب المصادر ← الترميز ← حفظ الناتج، ويرجع مباشرة النتيجة النهائية.
 * - المهمة قيد المعالجة فعله → 202 {"status":"processing"}
 * - المهمة منتهية → 200 مع النتيجة مرة أخرى
 * - المهمة فاشلة → يُسمح بإعادة المحاولة (حجز ذرّي)
 */

const { sendJson, sendError, handleOptions, getBaseUrl, isValidJobId } = require('../../../lib/util');
const db = require('../../../lib/db');
const cleanup = require('../../../lib/cleanup');
const merge = require('../../../lib/merge');

function doneResult(id, job, base) {
  return {
    status: 'done',
    jobId: id,
    videoUrl: job.video_url || `${base}/api/jobs/${id}/video`,
    downloadUrl: job.download_url || `${base}/api/jobs/${id}/video?download=1`,
    size: Number(job.size) || 0,
    duration: job.duration == null ? null : Number(job.duration),
    resolution: job.resolution || null,
    expiresAt: job.expires_at || null,
  };
}

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  const id = String((req.query && req.query.id) || '');
  try {
    if (req.method !== 'POST') {
      return sendError(res, 405, 'الطريقة غير مسموحة، استخدم POST', { Allow: 'POST, OPTIONS' });
    }
    if (!isValidJobId(id)) return sendError(res, 400, 'معرّف المهمة غير صالح');
    await db.ensureSchema();
    await cleanup.lazyCleanup();

    const job = await db.getJob(id);
    if (!job) return sendError(res, 404, 'المهمة غير موجودة أو انتهت صلاحيتها');

    const base = getBaseUrl(req);

    if (job.status === 'done') {
      return sendJson(res, 200, doneResult(id, job, base));
    }
    if (job.status === 'processing') {
      return sendJson(res, 202, { status: 'processing', jobId: id });
    }

    // حجز ذرّي — يفشل لو سبقنا طلب آخر
    const claimed = await db.tryMarkProcessing(id);
    if (!claimed) {
      return sendJson(res, 202, { status: 'processing', jobId: id });
    }

    // تنفيذ متزامن: سحب المصادر ← الترميز ← حفظ الناتج في Turso
    const result = await merge.processJob(id);

    const videoUrl = `${base}/api/jobs/${id}/video`;
    const downloadUrl = `${base}/api/jobs/${id}/video?download=1`;
    await db.updateJob(id, { video_url: videoUrl, download_url: downloadUrl });

    const fresh = await db.getJob(id);
    const payload = doneResult(id, fresh || job, base);
    payload.progress = 100;
    return sendJson(res, 200, payload);
  } catch (err) {
    if (err && err.name === 'MergeError' && err.code === 'NOT_FOUND') {
      return sendError(res, 404, err.message);
    }
    console.error('[api/jobs/:id/process]', err && (err.message || err));
    const message = err && err.name === 'MergeError'
      ? err.message
      : 'فشلت عملية الدمج بسبب خطأ داخلي — أعد المحاولة';
    return sendError(res, 500, message);
  }
};
