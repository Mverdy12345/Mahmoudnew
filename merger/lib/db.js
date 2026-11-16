'use strict';

/**
 * طبقة قاعدة البيانات — Turso (libSQL) عبر @libsql/client
 * - ensureSchema: CREATE TABLE IF NOT EXISTS للمفاتيح المركبة
 * - عمليات المهام والمصادر + حذف شامل عبر client.batch
 * - إعادة محاولة واحدة بسيطة على أخطاء الشبكة الداخلية
 */

const { createClient } = require('@libsql/client');
const { sanitizeMessage } = require('./util');

let client = null;
let schemaPromise = null;

function getClient() {
  if (client) return client;
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error('متغير البيئة TURSO_DATABASE_URL غير مضبوط');
  const authToken = process.env.TURSO_AUTH_TOKEN;
  client = createClient({ url, authToken: authToken || undefined });
  return client;
}

/** تنفيذ استعلام واحد مع إعادة محاولة واحدة بسيطة */
async function exec(sql, args = []) {
  const c = getClient();
  try {
    return await c.execute({ sql, args });
  } catch (firstError) {
    try {
      return await c.execute({ sql, args });
    } catch (secondError) {
      throw new Error('فشل الاتصال بقاعدة البيانات: ' + sanitizeMessage(secondError && secondError.message));
    }
  }
}

async function all(sql, args = []) {
  const result = await exec(sql, args);
  return Array.from(result.rows);
}

/** دفعة أوامر ذرّية (write) مع إعادة محاولة واحدة */
async function batch(statements) {
  const c = getClient();
  try {
    return await c.batch(statements, 'write');
  } catch (firstError) {
    try {
      return await c.batch(statements, 'write');
    } catch (secondError) {
      throw new Error('فشل تنفيذ دفعة الأوامر في قاعدة البيانات: ' + sanitizeMessage(secondError && secondError.message));
    }
  }
}

async function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await batch([
        { sql: `CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          status TEXT DEFAULT 'queued',
          progress INTEGER DEFAULT 0,
          error TEXT,
          sources_json TEXT,
          video_url TEXT,
          download_url TEXT,
          size INTEGER,
          duration REAL,
          resolution TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          expires_at TEXT,
          completed_at TEXT
        )` },
        { sql: `CREATE TABLE IF NOT EXISTS sources (
          job_id TEXT,
          seq INTEGER,
          kind TEXT,
          url TEXT,
          name TEXT,
          size INTEGER,
          mime TEXT,
          PRIMARY KEY(job_id, seq)
        )` },
        { sql: `CREATE TABLE IF NOT EXISTS source_chunks (
          job_id TEXT,
          source_seq INTEGER,
          chunk_index INTEGER,
          data BLOB,
          PRIMARY KEY(job_id, source_seq, chunk_index)
        )` },
        { sql: `CREATE TABLE IF NOT EXISTS output_chunks (
          job_id TEXT,
          chunk_index INTEGER,
          data BLOB,
          PRIMARY KEY(job_id, chunk_index)
        )` },
      ]);
    })().catch((err) => {
      schemaPromise = null; // نسمح بإعادة المحاولة في الطلب التالي
      throw err;
    });
  }
  return schemaPromise;
}

/* ---------------- عمليات المهام ---------------- */

/** إدراج المهمة مع كل صفوف المصادر في دفعة واحدة */
async function insertJob(job, sources) {
  const statements = [
    {
      sql: `INSERT INTO jobs (id, status, progress, error, sources_json, video_url, download_url, size, duration, resolution, created_at, expires_at, completed_at)
            VALUES (?, ?, 0, NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
      args: [job.id, job.status, job.sourcesJson || null, job.createdAt, job.expiresAt],
    },
  ];
  for (const s of sources) {
    statements.push({
      sql: 'INSERT INTO sources (job_id, seq, kind, url, name, size, mime) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [job.id, s.seq, s.kind, s.url || null, s.name || null, s.size == null ? null : s.size, s.mime || null],
    });
  }
  await batch(statements);
}

async function getJob(id) {
  const rows = await all('SELECT * FROM jobs WHERE id = ?', [id]);
  return rows.length ? rows[0] : null;
}

async function getSources(jobId) {
  return all('SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC', [jobId]);
}

async function getSource(jobId, seq) {
  const rows = await all('SELECT * FROM sources WHERE job_id = ? AND seq = ?', [jobId, seq]);
  return rows.length ? rows[0] : null;
}

const JOB_COLUMNS = new Set([
  'status', 'progress', 'error', 'sources_json', 'video_url', 'download_url',
  'size', 'duration', 'resolution', 'expires_at', 'completed_at',
]);

/** تحديث ديناميكي آمن لأعمدة المهمة المسموحة فقط */
async function updateJob(id, patch) {
  const keys = Object.keys(patch).filter((k) => JOB_COLUMNS.has(k));
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const args = keys.map((k) => (patch[k] === undefined ? null : patch[k]));
  args.push(id);
  await exec(`UPDATE jobs SET ${sets} WHERE id = ?`, args);
}

/** حجز المهمة للمعالجة ذرّيًا — تنجح مرة واحدة فقط حتى مع طلبات متوازية */
async function tryMarkProcessing(id) {
  const result = await exec(
    `UPDATE jobs SET status = 'processing', progress = 0, error = NULL
     WHERE id = ? AND status IN ('queued', 'uploading', 'failed')`,
    [id]
  );
  return Number(result.rowsAffected) === 1;
}

async function getExpiredJobIds(nowIso) {
  const rows = await all('SELECT id FROM jobs WHERE expires_at IS NOT NULL AND expires_at <= ?', [nowIso]);
  return rows.map((r) => r.id);
}

/** حذف شامل لكل صفوف المهمة (jobs + sources + source_chunks + output_chunks) في batch واحد */
async function deleteJobRows(id) {
  await batch([
    { sql: 'DELETE FROM jobs WHERE id = ?', args: [id] },
    { sql: 'DELETE FROM sources WHERE job_id = ?', args: [id] },
    { sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [id] },
    { sql: 'DELETE FROM output_chunks WHERE job_id = ?', args: [id] },
  ]);
}

/** عدّ صفوف جدول مرتبط بمهمة (للاختبارات والتشخيص) */
async function countRows(table, jobId) {
  const columnByTable = { jobs: 'id', sources: 'job_id', source_chunks: 'job_id', output_chunks: 'job_id' };
  const column = columnByTable[table];
  if (!column) throw new Error('جدول غير معروف: ' + table);
  const rows = await all(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, [jobId]);
  return Number(rows[0].n) || 0;
}

module.exports = {
  getClient,
  exec,
  all,
  batch,
  ensureSchema,
  insertJob,
  getJob,
  getSources,
  getSource,
  updateJob,
  tryMarkProcessing,
  getExpiredJobIds,
  deleteJobRows,
  countRows,
};
