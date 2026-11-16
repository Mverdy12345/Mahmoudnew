'use strict';

/**
 * GET /api/config — الحدود العامة + version
 */

const { sendJson, sendError, handleOptions, getLimits } = require('../lib/util');

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== 'GET') {
    return sendError(res, 405, 'الطريقة غير مسموحة، استخدم GET', { Allow: 'GET, OPTIONS' });
  }
  return sendJson(res, 200, getLimits());
};
