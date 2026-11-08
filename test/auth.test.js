// Allowlist, Google claims, and the signed session cookie. No live Google or Asana calls.
process.env.ACCESS_KEY = 'test-key';
process.env.ASANA_PAT = 'test-pat';
process.env.TODAY_STORE = 'asana_tags';
process.env.GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com';
process.env.SESSION_SECRET = 'test-secret';
delete process.env.ALLOWED_EMAILS;
delete process.env.VERCEL;
delete process.env.RENDER;
delete process.env.READ_ONLY;
const a = require('assert');
const AUTH = require('../auth');
const { handle } = require('../server');

const NOW = Date.parse('2026-11-08T12:00:00Z');
const CLIENT = 'client-id.apps.googleusercontent.com';
function claims(over) {
  return Object.assign({
    iss: 'https://accounts.google.com', aud: CLIENT, exp: String(Math.floor(NOW / 1000) + 3600),
    email: 'dm@precisegreece.gr', email_verified: 'true',
  }, over || {});
}

a.deepEqual(AUTH.allowedEmails(''), AUTH.DEFAULT_EMAILS);
a.deepEqual(AUTH.allowedEmails(undefined), AUTH.DEFAULT_EMAILS);
a.deepEqual(AUTH.allowedEmails(' A@X.com , b@y.com '), ['a@x.com', 'b@y.com']);
for (const e of AUTH.DEFAULT_EMAILS) a.ok(AUTH.emailAllowed(e.toUpperCase(), AUTH.DEFAULT_EMAILS));
a.ok(!AUTH.emailAllowed('other@precisegreece.gr', AUTH.DEFAULT_EMAILS));

a.equal(AUTH.acceptGoogleClaims(claims(), CLIENT, NOW).email, 'dm@precisegreece.gr');
a.equal(AUTH.acceptGoogleClaims(claims({ email: 'AK@PreciseGreece.gr' }), CLIENT, NOW).email, 'ak@precisegreece.gr');
a.equal(AUTH.acceptGoogleClaims(claims({ email_verified: 'false' }), CLIENT, NOW).error, 'This Google account has no verified email');
a.equal(AUTH.acceptGoogleClaims(claims({ email_verified: false }), CLIENT, NOW).ok, false);
a.equal(AUTH.acceptGoogleClaims(claims({ aud: 'other' }), CLIENT, NOW).ok, false);
a.equal(AUTH.acceptGoogleClaims(claims({ iss: 'https://evil.example' }), CLIENT, NOW).ok, false);
a.equal(AUTH.acceptGoogleClaims(claims({ exp: String(Math.floor(NOW / 1000) - 5) }), CLIENT, NOW).ok, false);
a.equal(AUTH.acceptGoogleClaims(claims({ error: 'invalid_token' }), CLIENT, NOW).ok, false);

const good = AUTH.signSession('DM@precisegreece.gr', 'test-secret', NOW);
a.equal(AUTH.readSession(good, 'test-secret', NOW + 1000, AUTH.DEFAULT_EMAILS), 'dm@precisegreece.gr');
a.equal(AUTH.readSession(good, 'other-secret', NOW + 1000, AUTH.DEFAULT_EMAILS), '');
a.equal(AUTH.readSession(good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a'), 'test-secret', NOW + 1000, AUTH.DEFAULT_EMAILS), '');
a.equal(AUTH.readSession(AUTH.signSession('dm@precisegreece.gr', 'test-secret', NOW - AUTH.SESSION_MS - 1000), 'test-secret', NOW, AUTH.DEFAULT_EMAILS), '');
a.equal(AUTH.readSession(AUTH.signSession('stranger@x.com', 'test-secret', NOW), 'test-secret', NOW, AUTH.DEFAULT_EMAILS), '');
const secure = AUTH.cookieHeader(good, true);
a.ok(secure.includes('HttpOnly') && secure.includes('SameSite=Lax') && secure.includes('Secure') && secure.includes('Max-Age=2592000'));
a.ok(!AUTH.cookieHeader(good, false).includes('Secure'));
a.equal(AUTH.cookieFrom('a=1; ' + AUTH.COOKIE + '=' + good + '; b=2'), good);

(async () => {
  function mockRes() {
    return { status: 0, headers: null, body: '', writeHead(s, h) { this.status = s; this.headers = h; }, end(b) { this.body = b == null ? '' : String(b); } };
  }
  function mockReq(method, url, headers, body) {
    const req = { method, url, headers: headers || {} };
    req[Symbol.asyncIterator] = async function* () { if (body) yield body; };
    return req;
  }
  async function call(method, url, headers, body) {
    const res = mockRes();
    await handle(mockReq(method, url, headers, body), res);
    return res;
  }
  const token = AUTH.signSession('dd@precisegreece.gr', 'test-secret', Date.now());
  const cookie = { cookie: AUTH.COOKIE + '=' + token };

  let r = await call('GET', '/healthz');
  a.equal(r.status, 200);
  r = await call('GET', '/');
  a.equal(r.status, 200);
  a.ok(r.body.includes('Sign in with Google'));
  a.ok(r.body.includes('IBM Plex Sans'));
  a.ok(r.body.includes(CLIENT));
  a.ok(!r.body.includes('id="app"'));
  a.ok(!r.body.includes('test-key'));
  r = await call('GET', '/?k=test-key');
  a.equal(r.status, 200);
  a.ok(r.body.includes('Sign in with Google'));
  a.ok(!r.body.includes('id="app"'));
  r = await call('GET', '/api/board');
  a.equal(r.status, 401);
  r = await call('POST', '/api/plan', {}, '{}');
  a.equal(r.status, 401);
  r = await call('GET', '/', cookie);
  a.equal(r.status, 200);
  a.ok(r.body.includes('id="app"'));
  a.ok(r.body.includes('Sign out'));
  a.ok(r.body.includes('content="google"'));
  a.ok(r.body.includes('dd@precisegreece.gr'));
  r = await call('GET', '/', { cookie: AUTH.COOKIE + '=' + AUTH.signSession('nope@x.com', 'test-secret', Date.now()) });
  a.ok(r.body.includes('Sign in with Google'));

  global.fetch = async (url) => {
    const u = String(url);
    if (!u.includes('tokeninfo')) throw new Error('unexpected ' + u.split('?')[0]);
    const email = decodeURIComponent(u.split('id_token=')[1]) === 'bad' ? 'nobody@example.com' : 'DC@precisegreece.gr';
    return { ok: true, json: async () => claims({ email, exp: String(Math.floor(Date.now() / 1000) + 60) }) };
  };
  r = await call('POST', '/api/session', { 'content-type': 'application/json' }, JSON.stringify({ credential: 'good' }));
  a.equal(r.status, 200);
  a.equal(JSON.parse(r.body).email, 'dc@precisegreece.gr');
  const setCookie = r.headers['Set-Cookie'];
  a.ok(setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Lax') && setCookie.includes('Max-Age=2592000'));
  const minted = setCookie.match(/plano_session=([^;]+)/)[1];
  a.equal(AUTH.readSession(minted, 'test-secret', Date.now(), AUTH.DEFAULT_EMAILS), 'dc@precisegreece.gr');
  r = await call('POST', '/api/session', {}, JSON.stringify({ credential: 'bad' }));
  a.equal(r.status, 403);
  a.equal(JSON.parse(r.body).error, "This account isn't allowed");
  r = await call('POST', '/api/logout', cookie);
  a.equal(r.status, 200);
  a.ok(r.headers['Set-Cookie'].includes('Max-Age=0'));
  console.log('auth tests: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
