'use strict';

/**
 * GET /api/jobs/<id>/video — بث الفيديو الناتج من output_chunks في Turso:
 * - ReadableStream مع دعم Range (206 + Content-Range + Accept-Ranges: bytes) للتقديم/الترجيع
 * - ?download=1 يضيف Content-Disposition: attachment
 * - ?download=1 اختيار على GET فقط؛ HEAD مدعوم للمشغلات
 */

const { sendError, handleOptions, applyCors, isValidJobId, statusLabel } = require('../../../lib/util');
const db = require('../../../lib/db');
const storage = require('../../../lib/storage');
const { pipeline } = require('stream/promises');

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  const id = String((req.query && req.query.id) || '');
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendError(res, 405, 'الطريقة غير مسموحة، استخدم GET', { Allow: 'GET, HEAD, OPTIONS' });
    }
    if (!isValidJobId(id)) return sendError(res, 400, 'معرّف المهمة غير صالح');
    await db.ensureSchema();

    const job = await db.getJob(id);
    if (!job) return sendError(res, 404, 'المهمة غير موجودة أو انتهت صلاحيتها');
    if (job.status !== 'done') {
      return sendError(res, 409, `الفيديو غير جاهز بعد — الحالة الحالية: ${statusLabel(job.status)}`);
    }

    let total = Number(job.size) || 0;
    if (!total) total = await storage.blobSize('output_chunks', id);
    if (!total) return sendError(res, 404, 'الفيديو غير متوفر — انتهت صلاحيته أو حُذف');

    const wantsDownload = req.query && (req.query.download === '1' || req.query.download === 'true');
    const headers = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=300',
      'Content-Disposition': `${wantsDownload ? 'attachment' : 'inline'}; filename="merger-${id}.mp4"`,
      ETag: `"${id}-${total}"`,
    };

    // تحليل ترويسة Range
    let start = 0;
    let end = total - 1;
    let partial = false;
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
      if (match && (match[1] !== '' || match[2] !== '')) {
        if (match[1] === '' && match[2] !== '') {
          // صيغة اللاحقة: آخر N بايت
          const suffix = Math.min(parseInt(match[2], 10), total);
          start = total - suffix;
          end = total - 1;
          partial = true;
        } else {
          start = parseInt(match[1], 10);
          end = match[2] === '' ? total - 1 : Math.min(parseInt(match[2], 10), total - 1);
          partial = true;
        }
        if (start >= total || (partial && start > end)) {
          applyCors(res);
          res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' });
          return res.end();
        }
        if (end < start) end = total - 1;
      }
    }

    const length = end - start + 1;
    headers['Content-Length'] = String(length);
    if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;

    applyCors(res);
    res.writeHead(partial ? 206 : 200, headers);
    if (req.method === 'HEAD') return res.end();

    // بث الناتج من Turso كسلسلة ReadableStream مع تقليم أول/آخر جزء حسب المدى
    const stream = storage.blobToNodeStream({ table: 'output_chunks', jobId: id, start, end });
    res.on('close', () => stream.destroy());
    try {
      await pipeline(stream, res);
    } catch (_) {
      /* انقطع العميل أثناء البث — لا شيء يمكن فعله بعد إرسال الترويسات */
    }
  } catch (err) {
    console.error('[api/jobs/:id/video]', err && err.message);
    if (res.headersSent) {
      res.destroy();
    } else {
      return sendError(res, 500, 'خطأ داخلي أثناء بث الفيديو — أعد المحاولة');
    }
  }
};
