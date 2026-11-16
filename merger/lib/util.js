'use strict';

/**
 * أدوات مشتركة لخدمة دمج الفيديوهات (Video Merger API v2)
 * - تحميل .env يدويًا (بدون أي اعتماديات خارجية)
 * - ردود JSON موحدة مع CORS مفتوح + دعم OPTIONS preflight
 * - حدود الخدمة من متغيرات البيئة
 * - توليد المعرفات وقراءة جسم الطلب
 * - تحديد مسارات ffmpeg/ffprobe مع تجاوزات FFMPEG_PATH/FFPROBE_PATH
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

/* ---------------- تحميل .env يدويًا (parser بسيط) ---------------- */
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (_) {
    /* تجاهل أخطاء قراءة .env بصمت — لا نطبع أي شيء يتعلق بمحتواه */
  }
})();

/* ---------------- CORS وردود JSON ---------------- */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition, ETag',
  'Access-Control-Max-Age': '86400',
};

function applyCors(res) {
  for (const key of Object.keys(CORS_HEADERS)) res.setHeader(key, CORS_HEADERS[key]);
}

/** يعالج OPTIONS preflight ويعيد true إذا تمت المعالجة */
function handleOptions(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res);
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

function sendJson(res, status, payload, extraHeaders) {
  applyCors(res);
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  }
  res.end(body);
}

/** كل الأخطاء بصيغة {"error":"..."} برسائل عربية واضحة */
function sendError(res, status, message, extraHeaders) {
  sendJson(res, status, { error: message }, extraHeaders);
}

/* ---------------- الحدود والإعدادات ---------------- */
function envInt(name, defaultValue) {
  const raw = parseInt(process.env[name], 10);
  return Number.isFinite(raw) && raw > 0 ? raw : defaultValue;
}

/** الحدود العامة — تُعاد أيضًا عبر GET /api/config */
function getLimits() {
  return {
    version: '1.0.0',
    maxSources: envInt('MAX_SOURCES', 10),
    sourceMaxMB: envInt('SOURCE_MAX_MB', 200),
    outputMaxMB: envInt('OUTPUT_MAX_MB', 150),
    maxTotalDurationSec: envInt('MAX_TOTAL_DURATION_SEC', 600),
    uploadChunkBytes: envInt('UPLOAD_CHUNK_BYTES', 4 * 1024 * 1024),
    expiresHours: envInt('EXPIRES_HOURS', 24),
  };
}

/* حجم صف التخزين الواحد في Turso (2MB — حد HTTP لقيمة BLOB الواحدة) وعدد صفوف صفحة القراءة */
const STORAGE_CHUNK_BYTES = 2 * 1024 * 1024;
const STORAGE_PAGE_ROWS = 8;

/* ---------------- المعرفات ---------------- */
const JOB_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** معرف مهمة قصير فريد: 10 أحرف صغيرة/أرقام */
function newJobId(length = 10) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += JOB_ID_ALPHABET[crypto.randomInt(0, JOB_ID_ALPHABET.length)];
  }
  return out;
}

/** معرف تتبع داخلي (للملفات المؤقتة وسجلات التشخيص) */
function newTraceId() {
  return crypto.randomUUID();
}

function isValidJobId(id) {
  return typeof id === 'string' && /^[a-z0-9]{4,40}$/.test(id);
}

/* ---------------- أساس الروابط من ترويسات الطلب ---------------- */
function getBaseUrl(req) {
  const hostHeader = req.headers['x-forwarded-host'] || req.headers['host'] || '127.0.0.1:3010';
  const host = String(hostHeader).split(',')[0].trim();
  const protoHeader = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const proto = protoHeader || (req.socket && req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${host}`;
}

/* ---------------- قراءة جسم الطلب ---------------- */

/** قراءة جسم ثنائي خام حتى حد أقصى — يرفع خطأ code=BODY_TOO_LARGE عند التجاوز */
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (maxBytes > 0 && total > maxBytes) {
        settled = true;
        const err = new Error('حجم جسم الطلب يتجاوز الحد المسموح');
        err.code = 'BODY_TOO_LARGE';
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        req.resume();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

/** قراءة جسم JSON — يرفع code=BAD_JSON عند صيغة تالفة */
async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const raw = await readRawBody(req, maxBytes);
  if (!raw || raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (_) {
    const err = new Error('صيغة JSON غير صالحة في جسم الطلب');
    err.code = 'BAD_JSON';
    throw err;
  }
}

/* ---------------- تنقية الرسائل (منع تسرّب روابط/رموز قاعدة البيانات في المخرجات) ---------------- */
function sanitizeMessage(message) {
  let text = String(message == null ? 'خطأ غير معروف' : message);
  text = text.replace(/(libsql|https?):\/\/[^\s'"<>)\]]+/gi, '[URL]');
  text = text.replace(/[A-Za-z0-9_-]{40,}/g, '[TOKEN]');
  return text.slice(0, 300);
}

/* ---------------- حالات المهمة بالعربية ---------------- */
function statusLabel(status) {
  const map = {
    queued: 'في الانتظار',
    uploading: 'بانتظار/أثناء رفع الأجزاء',
    processing: 'قيد المعالجة',
    done: 'مكتملة',
    failed: 'فاشلة',
  };
  return map[status] || String(status || 'غير معروفة');
}

/* ---------------- ثنائيات ffmpeg / ffprobe ---------------- */
let cachedBins = null;

/**
 * الثنائي قد يفقد صلاحية التنفيذ في بعض الاستضافات:
 * نتحقق، وإن فُقدت ننسخه إلى /tmp بصلاحية 755 ونستخدم النسخة.
 */
function ensureExecutable(binPath) {
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    return binPath;
  } catch (_) {
    /* لا صلاحية تنفيذ — ننسخ إلى /tmp */
  }
  try {
    const dir = path.join(os.tmpdir(), 'merger-bins');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${path.basename(binPath)}-${newTraceId().slice(0, 8)}`);
    fs.copyFileSync(binPath, target);
    fs.chmodSync(target, 0o755);
    return target;
  } catch (_) {
    return binPath; // محاولة أخيرة كما هو
  }
}

function findSystemBin(name) {
  const candidates = [name, `/usr/bin/${name}`, `/usr/local/bin/${name}`, `/usr/sbin/${name}`, `/opt/homebrew/bin/${name}`];
  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate, ['-version'], { timeout: 8000 });
      if (result.status === 0) return candidate;
    } catch (_) { /* نتابع المرشح التالي */ }
  }
  return null;
}

/**
 * ترتيب الأولوية:
 * 1) متغيرات البيئة FFMPEG_PATH / FFPROBE_PATH
 * 2) حزم ffmpeg-static / ffprobe-static
 * 3) ثنائيات النظام (which المكافئ يدويًا)
 */
function getFfmpegPaths() {
  if (cachedBins) return cachedBins;
  let ffmpeg = process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH) ? process.env.FFMPEG_PATH : null;
  let ffprobe = process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH) ? process.env.FFPROBE_PATH : null;
  if (!ffmpeg) {
    try {
      const p = require('ffmpeg-static');
      if (typeof p === 'string' && p && fs.existsSync(p)) ffmpeg = p;
    } catch (_) { /* الحزمة غير مثبتة */ }
  }
  if (!ffprobe) {
    try {
      const mod = require('ffprobe-static');
      const p = mod && (mod.path || mod);
      if (typeof p === 'string' && p && fs.existsSync(p)) ffprobe = p;
    } catch (_) { /* الحزمة غير مثبتة */ }
  }
  if (!ffmpeg) ffmpeg = findSystemBin('ffmpeg');
  if (!ffprobe) ffprobe = findSystemBin('ffprobe');
  if (ffmpeg) ffmpeg = ensureExecutable(ffmpeg);
  if (ffprobe) ffprobe = ensureExecutable(ffprobe);
  cachedBins = { ffmpeg, ffprobe };
  return cachedBins;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  CORS_HEADERS,
  applyCors,
  handleOptions,
  sendJson,
  sendError,
  envInt,
  getLimits,
  STORAGE_CHUNK_BYTES,
  STORAGE_PAGE_ROWS,
  newJobId,
  newTraceId,
  isValidJobId,
  getBaseUrl,
  readRawBody,
  readJsonBody,
  sanitizeMessage,
  statusLabel,
  ensureExecutable,
  getFfmpegPaths,
  sleep,
};
