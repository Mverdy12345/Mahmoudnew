'use strict';

/**
 * التنظيف:
 * - deleteJobEverywhere: حذف شامل لصفوف المهمة من الجداول الأربعة في batch واحد + مجلد /tmp
 * - removeExpiredJobs: حذف كل المهام المنتهية الصلاحية (expires_at + 24 ساعة)
 * - lazyCleanup: تنظيف كسول غير حاجز يُستدعى عند كل طلب إنشاء/دمج
 */

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const db = require('./db');

async function deleteJobEverywhere(jobId) {
  await db.deleteJobRows(jobId);
  await fsp.rm(path.join(os.tmpdir(), 'vmerge-' + jobId), { recursive: true, force: true }).catch(() => {});
}

async function removeExpiredJobs(nowIso) {
  const ids = await db.getExpiredJobIds(nowIso || new Date().toISOString());
  let deleted = 0;
  for (const id of ids) {
    try {
      await deleteJobEverywhere(id);
      deleted += 1;
    } catch (_) { /* تجاهل المهمة الفاشلة وواصل البقية */ }
  }
  return deleted;
}

/** التنظيف الكسول لا يعطل الطلب الأساسي أبدًا */
async function lazyCleanup() {
  try {
    await removeExpiredJobs();
  } catch (_) { /* تجاهل */ }
}

module.exports = { deleteJobEverywhere, removeExpiredJobs, lazyCleanup };
