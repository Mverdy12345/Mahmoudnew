'use strict';

/**
 * GET  /api/jobs/<id> — حالة المهمة + التقدم (0–100) + الرابط عند الاكتمال
 * DELETE /api/jobs/<id> — حذف فوري شامل (jobs + sources + source_chunks + output_chunks + /tmp)
 */

const { sendJson, sendError, handleOptions, getBaseUrl, isValidJobId } = require('../../lib/util');
const db = require('../../lib/db');
const cleanup = require('../../lib/cleanup');

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  const id = String((req.query && req.query.id) || '');
  try {
    if (!isValidJobId(id)) return sendError(res, 400, 'معرّف المهمة غير صالح');
    await db.ensureSchema();

    if (req.method === 'GET') {
      const job = await db.getJob(id);
      if (!job) return sendError(res, 404, 'المهمة غير موجودة أو انتهت صلاحيتها');
      const base = getBaseUrl(req);
      const done = job.status === 'done';
      return sendJson(res, 200, {
        jobId: job.id,
        status: job.status,
        progress: Number(job.progress) || 0,
        videoUrl: done ? (job.video_url || `${base}/api/jobs/${id}/video`) : null,
        downloadUrl: done ? (job.download_url || `${base}/api/jobs/${id}/video?download=1`) : null,
        error: job.error || null,
        size: job.size == null ? null : Number(job.size),
        duration: job.duration == null ? null : Number(job.duration),
        resolution: job.resolution || null,
        expiresAt: job.expires_at || null,
        createdAt: job.created_at || null,
      });
    }

    if (req.method === 'DELETE') {
      const job = await db.getJob(id);
      if (!job) return sendError(res, 404, 'المهمة غير موجودة أو انتهت صلاحيتها');
      await cleanup.deleteJobEverywhere(id);
      return sendJson(res, 200, { ok: true, deleted: id });
    }

    return sendError(res, 405, 'الطريقة غير مسموحة، استخدم GET أو DELETE', { Allow: 'GET, DELETE, OPTIONS' });
  } catch (err) {
    console.error('[api/jobs/:id]', err && err.message);
    return sendError(res, 500, 'خطأ داخلي في الخادم — أعد المحاولة');
  }
};
