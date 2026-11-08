'use strict';
// Google sign-in helpers. Sessions are a signed cookie (no server store).
// The ID token is checked with Google's tokeninfo endpoint, which verifies the signature.
const crypto = require('crypto');

const DEFAULT_EMAILS = ['dm@precisegreece.gr', 'ak@precisegreece.gr', 'dd@precisegreece.gr', 'dc@precisegreece.gr'];
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE = 'plano_session';

function allowedEmails(raw) {
  const s = raw == null ? '' : String(raw);
  if (!s.trim()) return DEFAULT_EMAILS.slice();
  return s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
}

function emailAllowed(email, list) {
  return list.includes(String(email || '').trim().toLowerCase());
}

// Claims from Google tokeninfo (or a test double). email_verified must be true.
function acceptGoogleClaims(info, clientId, now) {
  info = info || {};
  if (info.error) return { ok: false, error: 'Google sign-in was rejected' };
  const iss = String(info.iss || '');
  if (iss !== 'accounts.google.com' && iss !== 'https://accounts.google.com') return { ok: false, error: 'Google sign-in was rejected' };
  if (String(info.aud || '') !== String(clientId || '')) return { ok: false, error: 'Google sign-in was rejected' };
  const exp = Number(info.exp);
  if (!exp || exp * 1000 <= now) return { ok: false, error: 'Google sign-in was rejected' };
  const verified = info.email_verified === true || info.email_verified === 'true';
  if (!verified) return { ok: false, error: 'This Google account has no verified email' };
  const email = String(info.email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: 'Google sign-in was rejected' };
  return { ok: true, email };
}

async function verifyGoogleIdToken(token, clientId, now, fetchFn) {
  token = String(token || '');
  if (!token || token.length > 8000) return { ok: false, error: 'Google sign-in was rejected' };
  const fetchImpl = fetchFn || fetch;
  let res;
  try {
    res = await fetchImpl('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token));
  } catch {
    return { ok: false, error: 'Could not verify the Google sign-in' };
  }
  if (!res.ok) return { ok: false, error: 'Google sign-in was rejected' };
  let info;
  try { info = await res.json(); } catch { return { ok: false, error: 'Google sign-in was rejected' }; }
  return acceptGoogleClaims(info, clientId, now == null ? Date.now() : now);
}

function signSession(email, secret, now) {
  const payload = Buffer.from(JSON.stringify({ e: String(email).trim().toLowerCase(), exp: now + SESSION_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', String(secret)).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function readSession(token, secret, now, emails) {
  if (!token || !secret) return '';
  const parts = String(token).split('.');
  if (parts.length !== 2) return '';
  const expected = crypto.createHmac('sha256', String(secret)).update(parts[0]).digest('base64url');
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return '';
  let data;
  try { data = JSON.parse(Buffer.from(parts[0], 'base64url').toString()); } catch { return ''; }
  if (!data || !data.e || typeof data.exp !== 'number' || data.exp <= now) return '';
  const email = String(data.e).trim().toLowerCase();
  if (!emailAllowed(email, emails)) return '';
  return email;
}

function cookieHeader(token, secure) {
  const bits = [COOKIE + '=' + token, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=' + Math.floor(SESSION_MS / 1000)];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

function clearCookieHeader(secure) {
  const bits = [COOKIE + '=', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

function cookieFrom(header) {
  const raw = String(header || '');
  for (const part of raw.split(';')) {
    const s = part.trim();
    const i = s.indexOf('=');
    if (i <= 0) continue;
    if (s.slice(0, i) === COOKIE) return s.slice(i + 1);
  }
  return '';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function loginPage(clientId) {
  const id = esc(clientId);
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex"><title>Plano</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">' +
    '<script src="https://accounts.google.com/gsi/client" async defer></script>' +
    '<style>' +
    'body{margin:0;background:#fff;color:#111418;font:400 14px/20px "IBM Plex Sans",sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}' +
    '.card{width:min(400px,calc(100% - 32px));border:1px solid #e2e5e9;border-radius:12px;padding:28px 24px;text-align:center}' +
    'h1{font-size:24px;line-height:30px;margin:0 0 8px;font-weight:600}' +
    'p{color:#4a5059;margin:0 0 20px}' +
    '.err{background:#fdecea;color:#8a1c12;border:1px solid #f5c2bd;border-radius:8px;padding:8px 10px;font-size:13px;margin:0 0 16px;display:none}' +
    '.btnwrap{display:flex;justify-content:center}' +
    '</style></head><body><div class="card" id="login">' +
    '<h1>Plano</h1><p>Sign in with your Precise Greece Google account.</p>' +
    '<div class="err" id="msg" role="alert"></div>' +
    '<div id="g_id_onload" data-client_id="' + id + '" data-callback="onPlanoGoogle" data-auto_prompt="false" data-context="signin"></div>' +
    '<div class="btnwrap"><div class="g_id_signin" aria-label="Sign in with Google" data-type="standard" data-theme="outline" data-size="large" data-text="signin_with" data-shape="rectangular" data-logo_alignment="left"></div></div>' +
    '</div><script>' +
    'if(/[?&]k=/.test(location.search))history.replaceState(null,"",location.pathname);' +
    'window.onPlanoGoogle=function(resp){' +
    'var msg=document.getElementById("msg");msg.style.display="none";' +
    'fetch("/api/session",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({credential:resp&&resp.credential})})' +
    '.then(function(r){return r.json().catch(function(){return {};}).then(function(j){return {ok:r.ok,j:j};});})' +
    '.then(function(x){if(x.ok){location.replace("/");return;}msg.textContent=(x.j&&x.j.error)||"Sign-in failed";msg.style.display="block";})' +
    '.catch(function(){msg.textContent="Sign-in failed";msg.style.display="block";});};' +
    '</script></body></html>';
}

module.exports = {
  DEFAULT_EMAILS, SESSION_MS, COOKIE, allowedEmails, emailAllowed, acceptGoogleClaims, verifyGoogleIdToken,
  signSession, readSession, cookieHeader, clearCookieHeader, cookieFrom, loginPage,
};
