// Routing shared by `node server.js` and the Vercel function. No Asana calls.
process.env.ACCESS_KEY = 'test-key';
process.env.ASANA_PAT = 'test-pat';
process.env.TODAY_STORE = 'asana_tags';
delete process.env.VERCEL;
delete process.env.RENDER;
delete process.env.READ_ONLY;
const a = require('assert');
const { handle, incomingUrl } = require('../server');

function mockRes() {
  return { status: 0, headers: null, body: '', writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b == null ? '' : String(b); } };
}
function mockReq(method, url, headers) {
  const req = { method, url, headers: headers || {} };
  req[Symbol.asyncIterator] = async function* () {};
  return req;
}
async function call(method, url, headers) {
  const res = mockRes();
  await handle(mockReq(method, url, headers), res);
  return res;
}

(async () => {
  a.equal(incomingUrl({ url: '/healthz', headers: {} }), '/healthz');
  a.equal(incomingUrl({ url: '/api/healthz', headers: {} }), '/healthz');
  a.equal(incomingUrl({ url: '/api/page?k=abc', headers: {} }), '/?k=abc');
  a.equal(incomingUrl({ url: '/api/board?refresh=1', headers: {} }), '/api/board?refresh=1');
  a.equal(incomingUrl({ url: '/api/task/123456789', headers: {} }), '/api/task/123456789');
  a.equal(incomingUrl({ url: '/api', headers: { 'x-invoke-path': '/healthz' } }), '/healthz');
  a.equal(incomingUrl({ url: '/api', headers: { 'x-invoke-path': '/', 'x-invoke-query': 'k=abc' } }), '/?k=abc');

  let r = await call('GET', '/healthz');
  a.equal(r.status, 200); a.deepEqual(JSON.parse(r.body), { ok: true });
  r = await call('GET', '/api/healthz');
  a.equal(r.status, 200);
  r = await call('GET', '/');
  a.equal(r.status, 403);
  r = await call('GET', '/?k=nope');
  a.equal(r.status, 403);
  r = await call('GET', '/api/board');
  a.equal(r.status, 403);
  r = await call('GET', '/?k=test-key');
  a.equal(r.status, 200);
  a.ok(r.body.includes('Plano'));
  a.ok(!r.body.includes('__BUILD__'));
  r = await call('GET', '/api/page?k=test-key');
  a.equal(r.status, 200); a.ok(r.body.includes('Plano'));
  r = await call('GET', '/api', { 'x-invoke-path': '/', 'x-invoke-query': 'k=test-key' });
  a.equal(r.status, 200);
  r = await call('GET', '/nope?k=test-key');
  a.equal(r.status, 404);
  console.log('http routing tests: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
