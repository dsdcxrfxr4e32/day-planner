'use strict';
// Vercel serverless entry. Every route (page, /healthz, /api/*) is handled by the
// same function as `node server.js`, so Render and Vercel stay in lockstep.
// Frankfurt is set in vercel.json. The function is stateless: Asana and env hold the data.
const { handle } = require('../server');
module.exports = (req, res) => handle(req, res);
