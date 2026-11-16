'use strict';

/**
 * GET /api/cron — حذف المهام المنتهية الصلاحية (تنظيف دوري)
 * مجدول في vercel.json كل يوم 03:00 UTC، ويعمل أيضًا كتنظيف كسول عند الإنشاء/الدمج.
 */

const { sendJson, sendError, handleOptions } = require('../lib/util');
const db = require('../lib/db');
const cleanup = require('../lib/cleanup');

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') {
    return sendError(res, 405, 'الطريقة غير مسموحة، استخدم GET', { Allow: 'GET, OPTIONS' });
  }
  try {
    await db.ensureSchema();
    const deleted = await cleanup.removeExpiredJobs();
    return sendJson(res, 200, { ok: true, deleted });
  } catch (err) {
    console.error('[api/cron]', err && err.message);
    return sendError(res, 500, 'فشل التنظيف الدوري — تحقق من قاعدة البيانات');
  }
};
