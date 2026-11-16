'use strict';

/**
 * خادم تطوير محلي يحاكي بيئة Vercel للـ Serverless Functions:
 * - يستمع على المنفذ 3010 (يمكن تجاوزه عبر MERGER_PORT)
 * - يحلّل المسارات الديناميكية (/api/jobs/<id>/...) ويضعها في req.query مثل Vercel
 * - يقدّم public/index.html على /
 * - لا إطار عمل — http خالص
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

require('./lib/util'); // تحميل .env مبكرًا (بدون طباعة أي محتوى)

const PORT = Number(process.env.MERGER_PORT || 3010);
const PUBLIC_DIR = path.join(__dirname, 'public');

const routes = {
  jobs: require('./api/jobs.js'),
  jobItem: require('./api/jobs/[id].js'),
  process: require('./api/jobs/[id]/process.js'),
  video: require('./api/jobs/[id]/video.js'),
  upload: require('./api/upload.js'),
  config: require('./api/config.js'),
  cron: require('./api/cron.js'),
};

function sendNotFound(res) {
  res.writeHead(404, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({ error: 'المسار غير موجود' }));
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsed.pathname;
    const query = {};
    for (const [key, value] of parsed.searchParams.entries()) query[key] = value;
    req.query = query;

    // الواجهة الثابتة
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    if (req.method === 'GET' && pathname === '/favicon.ico') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      return res.end();
    }

    // توجيه الـ API مع استخراج الأجزاء الديناميكية إلى req.query (سلوك Vercel)
    let handler = null;
    if (pathname === '/api/jobs') {
      handler = routes.jobs;
    } else if (pathname === '/api/upload') {
      handler = routes.upload;
    } else if (pathname === '/api/config') {
      handler = routes.config;
    } else if (pathname === '/api/cron') {
      handler = routes.cron;
    } else {
      const nested = pathname.match(/^\/api\/jobs\/([^/]+)\/(process|video)$/);
      if (nested) {
        req.query.id = decodeURIComponent(nested[1]);
        handler = nested[2] === 'process' ? routes.process : routes.video;
      } else {
        const single = pathname.match(/^\/api\/jobs\/([^/]+)$/);
        if (single) {
          req.query.id = decodeURIComponent(single[1]);
          handler = routes.jobItem;
        }
      }
    }

    if (!handler) return sendNotFound(res);
    await handler(req, res);
  } catch (err) {
    console.error('[dev-server]', err && (err.message || err));
    if (!res.headersSent) {
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ error: 'خطأ داخلي في خادم التطوير' }));
    } else {
      res.end();
    }
  }
});

process.on('unhandledRejection', (err) => console.error('[dev-server] unhandledRejection:', err && (err.message || err)));
process.on('uncaughtException', (err) => console.error('[dev-server] uncaughtException:', err && (err.message || err)));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[dev-server] Video Merger API v2 يعمل على http://127.0.0.1:${PORT}`);
});
