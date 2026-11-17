'use strict';
// /api/tasks/:gid/duplicate is three path segments. On a static Vercel output the
// catch-all does not receive that shape, so this file is the same handler.
const { handle } = require('../../../server');
module.exports = (req, res) => {
  const gid = req.query && req.query.gid;
  const raw = req.url || '';
  if (gid && !/\/api\/tasks\/\d+\/duplicate/.test(raw.split('?')[0])) {
    const q = raw.includes('?') ? raw.slice(raw.indexOf('?')) : '';
    req.url = '/api/tasks/' + gid + '/duplicate' + q;
  }
  return handle(req, res);
};
