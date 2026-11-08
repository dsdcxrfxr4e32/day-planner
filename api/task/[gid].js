'use strict';
// /api/task/:gid is two path segments. The optional catch-all under api/ is not
// reached for that shape on a static Vercel output, so the platform 404s before
// the handler. This file is the same handler; Render does not use it.
const { handle } = require('../../server');
module.exports = (req, res) => {
  const gid = req.query && req.query.gid;
  const raw = req.url || '';
  if (gid && !/\/api\/task\/\d/.test(raw.split('?')[0])) {
    const q = raw.includes('?') ? raw.slice(raw.indexOf('?')) : '';
    req.url = '/api/task/' + gid + q;
  }
  return handle(req, res);
};
