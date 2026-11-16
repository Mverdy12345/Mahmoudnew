'use strict';

/**
 * طبقة تخزين Blobs في Turso:
 * - الكتابة: تقسيم الملفات إلى صفوف 2MB (حد HTTP لقيمة BLOB واحدة في Turso) وإدخالها بدفعات صغيرة
 * - القراءة: تيار تدفقي بصفحات من 8 صفوف مع دعم النطاق البايتي (Range) عبر مولّد async
 * - قيم BLOB القادمة من Turso تكون Uint8Array/ArrayBuffer — تُحوَّل بأمان إلى Buffer
 */

const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { STORAGE_CHUNK_BYTES, STORAGE_PAGE_ROWS, sanitizeMessage } = require('./util');
const db = require('./db');

const WRITE_BATCH_ROWS = 4; // 4 صفوف × 2MB = 8MB كحد أقصى لكل طلب كتابة

function toBuffer(value) {
  if (value == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return Buffer.from(String(value), 'utf8');
}

/* ---------------- الكتابة ---------------- */

/** حفظ ملف كامل كصفوف output_chunks — 2MB لكل صف — مع حذف أي صفوف قديمة أولًا (إعادة محاولة نظيفة) */
async function putOutputChunks(jobId, filePath, onProgress) {
  await db.exec('DELETE FROM output_chunks WHERE job_id = ?', [jobId]);
  const size = fs.statSync(filePath).size;
  if (size === 0) throw new Error('ملف الفيديو الناتج فارغ');
  const fd = fs.openSync(filePath, 'r');
  try {
    let cursor = 0;
    let rowIndex = 0;
    while (cursor < size) {
      const statements = [];
      for (let i = 0; i < WRITE_BATCH_ROWS && cursor < size; i++) {
        const len = Math.min(STORAGE_CHUNK_BYTES, size - cursor);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, cursor);
        statements.push({
          sql: 'INSERT INTO output_chunks (job_id, chunk_index, data) VALUES (?, ?, ?)',
          args: [jobId, rowIndex, buf],
        });
        cursor += len;
        rowIndex += 1;
      }
      await db.batch(statements);
      if (onProgress) {
        try { onProgress(cursor, size); } catch (_) { /* تقدم الاختيار لا يعطل التخزين */ }
      }
    }
    return size;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * حفظ جزء رفع واحد (حتى 4MB) كصفّين بمقاس 2MB كحد أقصى:
 * chunk_index = chunk*k → صفّان 2k و 2k+1 — إعادة رفع نفس الجزء تستبدل الصفوف (INSERT بعد DELETE بنفس المفاتيح)
 */
async function putUploadChunk(jobId, seq, chunkIndex, data) {
  const buf = toBuffer(data);
  if (buf.length > STORAGE_CHUNK_BYTES * 2) {
    const err = new Error('حجم جزء الرفع أكبر من سعة التخزين المسموحة (4MB)');
    err.code = 'CHUNK_TOO_LARGE';
    throw err;
  }
  const base = chunkIndex * 2;
  const statements = [
    {
      sql: 'DELETE FROM source_chunks WHERE job_id = ? AND source_seq = ? AND chunk_index IN (?, ?)',
      args: [jobId, seq, base, base + 1],
    },
  ];
  if (buf.length > 0) {
    const first = buf.subarray(0, Math.min(STORAGE_CHUNK_BYTES, buf.length));
    statements.push({
      sql: 'INSERT INTO source_chunks (job_id, source_seq, chunk_index, data) VALUES (?, ?, ?, ?)',
      args: [jobId, seq, base, first],
    });
    if (buf.length > STORAGE_CHUNK_BYTES) {
      const second = buf.subarray(STORAGE_CHUNK_BYTES);
      statements.push({
        sql: 'INSERT INTO source_chunks (job_id, source_seq, chunk_index, data) VALUES (?, ?, ?, ?)',
        args: [jobId, seq, base + 1, second],
      });
    }
  }
  await db.batch(statements);
  return buf.length;
}

/* ---------------- القراءة التدفقيّة ---------------- */

/**
 * مولّد يمرّ على بايتات Blob داخل النطاق [start, end] الشامل (end = null يعني حتى النهاية):
 * - output_chunks: صفوف موحّدة 2MB (عدا الأخير) → ننتقل مباشرة إلى صفحة البداية دون جلب ما قبلها
 * - source_chunks: يبدأ دائمًا من الصف 0 (أحجام الصفوف غير موحّدة بالضرورة)
 * يقرأ بصفحات من 8 صفوف (LIMIT/OFFSET) ويقلم أول/آخر جزء حسب المدى المطلوب.
 */
async function* iterateBlob(options) {
  const table = options.table === 'source_chunks' ? 'source_chunks' : 'output_chunks';
  const jobId = options.jobId;
  const seq = options.seq == null ? null : Number(options.seq);
  const start = Math.max(0, Number(options.start) || 0);
  const end = options.end == null ? null : Math.max(start, Number(options.end));

  let cursor = 0;
  let pageOffset = 0;
  if (table === 'output_chunks' && start > 0) {
    const firstRow = Math.floor(start / STORAGE_CHUNK_BYTES);
    cursor = firstRow * STORAGE_CHUNK_BYTES; // كل الصفوف قبل firstRow بحجم 2MB بالضبط
    pageOffset = Math.floor(firstRow / STORAGE_PAGE_ROWS) * STORAGE_PAGE_ROWS;
  }

  const where = table === 'output_chunks' ? 'WHERE job_id = ?' : 'WHERE job_id = ? AND source_seq = ?';
  const baseArgs = table === 'output_chunks' ? [jobId] : [jobId, seq];

  for (;;) {
    const sql = `SELECT chunk_index, data FROM ${table} ${where} ORDER BY chunk_index ASC LIMIT ${STORAGE_PAGE_ROWS} OFFSET ?`;
    let rows;
    try {
      rows = await db.all(sql, baseArgs.concat([pageOffset]));
    } catch (err) {
      throw new Error('فشل قراءة بيانات الفيديو من التخزين: ' + sanitizeMessage(err && err.message));
    }
    if (!rows.length) break;
    for (const row of rows) {
      const data = toBuffer(row.data);
      const rowStart = cursor;
      const rowEnd = cursor + data.length - 1;
      cursor += data.length;
      if (data.length === 0) continue;
      if (end != null && rowStart > end) return; // تجاوزنا نهاية المدى
      const from = Math.max(rowStart, start);
      const to = Math.min(rowEnd, end == null ? rowEnd : end);
      if (from > to) continue;
      yield data.subarray(from - rowStart, to - rowStart + 1);
    }
    if (rows.length < STORAGE_PAGE_ROWS) break;
    pageOffset += STORAGE_PAGE_ROWS;
  }
}

/** تحويل Blob إلى Node ReadableStream مع دعم backpressure */
function blobToNodeStream(options) {
  return Readable.from(iterateBlob(options), { highWaterMark: 1024 * 1024 });
}

/* ---------------- أدوات مساعدة ---------------- */

/** الحجم الكلي بالبايتات لجدول معيّن */
async function blobSize(table, jobId, seq) {
  if (table === 'output_chunks') {
    const rows = await db.all('SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM output_chunks WHERE job_id = ?', [jobId]);
    return Number(rows[0].n) || 0;
  }
  const rows = await db.all('SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM source_chunks WHERE job_id = ? AND source_seq = ?', [jobId, seq]);
  return Number(rows[0].n) || 0;
}

/** عدد صفوف التخزين لجدول معيّن */
async function blobRowCount(table, jobId, seq) {
  if (table === 'output_chunks') {
    const rows = await db.all('SELECT COUNT(*) AS n FROM output_chunks WHERE job_id = ?', [jobId]);
    return Number(rows[0].n) || 0;
  }
  const rows = await db.all('SELECT COUNT(*) AS n FROM source_chunks WHERE job_id = ? AND source_seq = ?', [jobId, seq]);
  return Number(rows[0].n) || 0;
}

/** سحب مصدر مرفوع من Turso إلى ملف مؤقت في /tmp مع حد أقصى للبايتات (رفض تجاوز الحجم) */
async function extractSourceToFile(jobId, seq, destPath, maxBytes) {
  let bytes = 0;
  const limited = (async function* () {
    for await (const chunk of iterateBlob({ table: 'source_chunks', jobId, seq })) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        const err = new Error(`حجم المصدر المرفوع رقم ${seq + 1} يتجاوز الحد المسموح (${Math.round(maxBytes / (1024 * 1024))}MB)`);
        err.code = 'SOURCE_TOO_LARGE';
        throw err;
      }
      yield chunk;
    }
  })();
  await pipeline(Readable.from(limited, { highWaterMark: 1024 * 1024 }), fs.createWriteStream(destPath));
  return bytes;
}

module.exports = {
  toBuffer,
  putOutputChunks,
  putUploadChunk,
  iterateBlob,
  blobToNodeStream,
  blobSize,
  blobRowCount,
  extractSourceToFile,
};
