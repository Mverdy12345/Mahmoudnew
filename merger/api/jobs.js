'use strict';

/**
 * POST /api/jobs — إنشاء مهمة دمج جديدة
 * يقبل {"videos":["رابط1","رابط2"]} أو {"sources":[{"kind":"url","url":...},{"kind":"file","name":...,"size":...,"mime":...}]}
 * يرجع 201: {jobId, status, statusUrl, processUrl, expiresAt} + uploads[] إن وُجدت ملفات
 */

const { sendJson, sendError, handleOptions, getLimits, newJobId, getBaseUrl, readJsonBody } = require('../lib/util');
const db = require('../lib/db');
const cleanup = require('../lib/cleanup');

/** توليد معرف قصير فريد مع فحص التعارض في القاعدة */
async function allocateJobId() {
  for (let i = 0; i < 5; i++) {
    const id = newJobId(10);
    const rows = await db.all('SELECT id FROM jobs WHERE id = ?', [id]);
    if (!rows.length) return id;
  }
  return newJobId(16);
}

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  try {
    if (req.method !== 'POST') {
      return sendError(res, 405, 'الطريقة غير مسموحة، استخدم POST', { Allow: 'POST, OPTIONS' });
    }
    await db.ensureSchema();
    await cleanup.lazyCleanup(); // تنظيف كسول للمهام المنتهية

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err.code === 'BAD_JSON') return sendError(res, 400, 'صيغة JSON غير صالحة في جسم الطلب');
      if (err.code === 'BODY_TOO_LARGE') return sendError(res, 413, 'حجم جسم الطلب كبير جدًا');
      throw err;
    }

    // تطبيع المصادر من الصيغتين المدعومتين
    let raw = [];
    if (Array.isArray(body.videos)) {
      raw = body.videos.map((v) => ({ kind: 'url', url: typeof v === 'string' ? v.trim() : '' }));
    } else if (Array.isArray(body.sources)) {
      raw = body.sources.map((s) => {
        if (!s || typeof s !== 'object') return null;
        return { kind: String(s.kind || 'url').trim(), url: s.url, name: s.name, size: Number(s.size), mime: s.mime };
      });
    } else {
      return sendError(res, 400, 'يجب إرسال "videos" كمصفوفة روابط أو "sources" كمصفوفة كائنات');
    }

    if (raw.length === 0) return sendError(res, 400, 'قائمة المصادر فارغة — أضف رابطًا واحدًا على الأقل');
    if (raw.some((x) => !x)) return sendError(res, 400, 'عنصر غير صالح في قائمة المصادر');

    const limits = getLimits();
    if (raw.length > limits.maxSources) {
      return sendError(res, 400, `عدد المصادر (${raw.length}) يتجاوز الحد المسموح (${limits.maxSources})`);
    }

    const sources = [];
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      if (r.kind === 'url') {
        if (!/^https?:\/\/.+/i.test(r.url || '')) {
          return sendError(res, 400, `المصدر رقم ${i + 1}: رابط غير صالح — يجب أن يبدأ بـ http أو https`);
        }
        sources.push({ seq: i, kind: 'url', url: r.url, name: null, size: null, mime: null });
      } else if (r.kind === 'file') {
        const size = Number(r.size);
        if (!r.name || !Number.isFinite(size) || size <= 0) {
          return sendError(res, 400, `المصدر رقم ${i + 1}: بيانات الملف ناقصة — name وsize مطلوبان`);
        }
        if (size > limits.sourceMaxMB * 1024 * 1024) {
          return sendError(res, 413, `المصدر رقم ${i + 1}: حجم الملف يتجاوز الحد المسموح (${limits.sourceMaxMB}MB)`);
        }
        sources.push({
          seq: i,
          kind: 'file',
          url: null,
          name: String(r.name).slice(0, 200),
          size: Math.round(size),
          mime: r.mime ? String(r.mime).slice(0, 100) : null,
        });
      } else {
        return sendError(res, 400, `المصدر رقم ${i + 1}: النوع غير مدعوم — استخدم "url" أو "file"`);
      }
    }

    const hasFiles = sources.some((s) => s.kind === 'file');
    const status = hasFiles ? 'uploading' : 'queued';
    const id = await allocateJobId();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + limits.expiresHours * 3600 * 1000).toISOString();

    await db.insertJob(
      { id, status, sourcesJson: JSON.stringify(sources), createdAt, expiresAt },
      sources
    );

    const base = getBaseUrl(req);
    const payload = {
      jobId: id,
      status,
      statusUrl: `${base}/api/jobs/${id}`,
      processUrl: `${base}/api/jobs/${id}/process`,
      expiresAt,
    };
    if (hasFiles) {
      payload.uploadChunkBytes = limits.uploadChunkBytes;
      payload.uploads = sources
        .filter((s) => s.kind === 'file')
        .map((s) => ({
          seq: s.seq,
          name: s.name,
          size: s.size,
          chunks: Math.ceil(s.size / limits.uploadChunkBytes),
          uploadUrl: `${base}/api/upload?job=${id}&seq=${s.seq}`,
        }));
    }
    return sendJson(res, 201, payload);
  } catch (err) {
    console.error('[api/jobs]', err && err.message);
    return sendError(res, 500, 'خطأ داخلي أثناء إنشاء المهمة — أعد المحاولة');
  }
};
