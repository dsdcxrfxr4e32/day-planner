'use strict';
// PRECISE GREECE · Team day planner — small server on the box.
// Holds the Asana token server-side ($ASANA_PAT), serves the board, proxies Asana.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./lib');
const CAL = require('./cal');
const AUTH = require('./auth');
const DUP = require('./duplicate');

const DIR = __dirname;
// data/ is optional (box: access_key, cal.env). On hosts with an ephemeral disk (Render) everything
// required comes from env; files there are only a fallback or a cache.
const DATA = process.env.DATA_DIR || path.join(DIR, 'data');
const ON_RENDER = !!process.env.RENDER; // Render sets RENDER=true in every service
const ON_VERCEL = !!process.env.VERCEL; // Vercel sets VERCEL=1; functions are stateless and the disk is read-only
try { fs.mkdirSync(DATA, { recursive: true }); } catch (e) { console.error('data dir not writable:', e.message); }

const CFG = {
  PORT: Number(process.env.PORT || 8787),
  HOST: process.env.HOST || '0.0.0.0',
  WORKSPACE: '1213289283868810',
  API: 'https://app.asana.com/api/1.0',
  CAP_MIN: 480,
  DONE_DAYS: 14,
  PEOPLE: [
    { k: 'dm', name: 'Dimitris', gid: '1213289276153981' },
    { k: 'ak', name: 'Antonia', gid: '1213448855148301' },
    { k: 'dd', name: 'Dimitra', gid: '1213448798749941' },
    { k: 'un', name: 'Unassigned', gid: null },
  ],
  EXCLUDE_UNASSIGNED_PROJECTS: ['012a AMK', 'Private Dimitris', 'Precise Private'],
  PRIVATE_PROJECT_RE: /private/i,
  PRIVATE_OWNER: 'dm',
  // Columns are the Asana due date only (Europe/Athens). This server never creates, adds, or removes a tag.
  // 'file': data/today.json, data/tomorrow.json and data/monday.json on the box. The board does not read them.
  TODAY_STORE: process.env.TODAY_STORE || 'asana_tags',
  TASK_FIELDS: 'name,assignee,completed,completed_at,created_at,due_on,due_at,notes,projects.name,projects.archived,parent.name,memberships.section.name',
  READ_ONLY: process.env.READ_ONLY === '1', // test mode: refuse any write to Asana
};

// Shared-link key: ?k=<key>. Used only while GOOGLE_CLIENT_ID is unset.
// Env ACCESS_KEY wins; else data/access_key (generated once on the box).
// On Render or Vercel a generated key would change on every cold start, so ACCESS_KEY is required
// until Google login is configured.
const KEY_FILE = path.join(DATA, 'access_key');
function loadAccessKey() {
  const env = String(process.env.ACCESS_KEY || '').trim();
  if (env) return env;
  try { const f = fs.readFileSync(KEY_FILE, 'utf8').trim(); if (f) return f; } catch { /* no file */ }
  if ((ON_RENDER || ON_VERCEL) && !String(process.env.GOOGLE_CLIENT_ID || '').trim()) { console.error('FATAL: ACCESS_KEY is not set (required on Render and Vercel until Google login is configured)'); process.exit(1); }
  if (String(process.env.GOOGLE_CLIENT_ID || '').trim()) return '';
  const k = crypto.randomBytes(18).toString('base64url');
  try { fs.writeFileSync(KEY_FILE, k, { mode: 0o600 }); } catch (e) { console.error('access key not persisted:', e.message); }
  return k;
}
const ACCESS_KEY = loadAccessKey();

function token() {
  const t = process.env.ASANA_PAT;
  if (!t) throw Object.assign(new Error('ASANA_PAT is not set on the server'), { status: 500 });
  return t;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function asana(method, p, body) {
  if (CFG.READ_ONLY && method !== 'GET') throw new Error('READ_ONLY mode: refused ' + method + ' ' + p.split('?')[0]);
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(CFG.API + p, {
      method,
      headers: { Authorization: 'Bearer ' + token(), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 || res.status >= 500) {
      const wait = Number(res.headers.get('retry-after') || 2);
      await sleep(Math.min(30, Math.max(1, wait)) * 1000);
      continue;
    }
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : {};
    let msg = text;
    try { msg = JSON.parse(text).errors.map((e) => e.message).join('; '); } catch { /* raw */ }
    throw Object.assign(new Error('Asana ' + res.status + ' on ' + method + ' ' + p.split('?')[0] + ': ' + msg), { status: 502 });
  }
  throw Object.assign(new Error('Asana kept rate-limiting; try Refresh in a minute'), { status: 503 });
}

const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

// Search has no next_page: page by created_at ascending + created_at.after.
async function searchAll(q) {
  let after = null, rows = [];
  for (let i = 0; i < 60; i++) {
    const p = { ...q, sort_by: 'created_at', sort_ascending: 'true', limit: 100, opt_fields: CFG.TASK_FIELDS };
    if (after) p['created_at.after'] = after;
    const d = (await asana('GET', '/workspaces/' + CFG.WORKSPACE + '/tasks/search?' + qs(p))).data || [];
    rows = rows.concat(d);
    if (d.length < 100) break;
    const last = d[d.length - 1].created_at;
    if (!last || last === after) break;
    after = last;
  }
  return rows;
}

async function listAll(p) {
  let offset = null, out = [];
  for (let i = 0; i < 30; i++) {
    const d = await asana('GET', p + (p.includes('?') ? '&' : '?') + qs({ limit: 100, offset }));
    out = out.concat(d.data || []);
    if (!d.next_page || !d.next_page.offset) break;
    offset = d.next_page.offset;
  }
  return out;
}

let projectCache = null;
async function excludedProjectGids() {
  if (!projectCache || Date.now() - projectCache.at > 3600e3) {
    // archived=false: only active projects (for + new-task picker and unassigned excludes)
    const ps = await listAll('/workspaces/' + CFG.WORKSPACE + '/projects?archived=false&opt_fields=name,archived');
    projectCache = { at: Date.now(), all: ps, gids: ps.filter((p) => CFG.EXCLUDE_UNASSIGNED_PROJECTS.includes(p.name)).map((p) => p.gid) };
  }
  return projectCache.gids;
}
// Projects a '+' section can fall back to when none of its tasks carries the project: client codes and PRE general.
const NEW_TASK_PROJECT_RE = /^(?:\d{3}[a-z]?\s|PRE general$)/;
function sectionProjects() {
  return ((projectCache && projectCache.all) || []).filter((p) => NEW_TASK_PROJECT_RE.test(p.name)).map((p) => ({ g: p.gid, n: p.name }));
}

/* ---------- Today store ---------- */
const TODAY_FILE = path.join(DATA, 'today.json');
const TOMORROW_FILE = path.join(DATA, 'tomorrow.json');
const MONDAY_FILE = path.join(DATA, 'monday.json');
// Local slot files for TODAY_STORE=file. Asana mode does not use them, and neither mode uses tags.
const SLOT = {
  t: { file: TODAY_FILE },
  w: { file: TOMORROW_FILE },
  mo: { file: MONDAY_FILE },
};
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const writeJson = (f, v) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(v, null, 1)); fs.renameSync(tmp, f); };
const personByKey = (k) => CFG.PEOPLE.find((p) => p.k === k);

/* ---------- calendars (client meetings) ---------- */
// Secret iCal URLs: env CAL_ICS_<NAME> (e.g. CAL_ICS_DIMITRIS), or the same KEY=VALUE lines in data/cal.env
// (read on every refresh, so a new person can be connected without a restart). URLs are never logged or sent.
const CAL_ENV_FILE = path.join(DATA, 'cal.env');
const CAL_TTL_MS = 5 * 60e3;
const KNOWN_EMAILS = { dm: ['dm@precisegreece.gr'] };
const calCache = {}; // url -> { at, cal, err }
// Every feed for a person: CAL_ICS_<NAME> plus CAL_ICS_<NAME>_<ANY> (e.g. CAL_ICS_DIMITRIS_PERSONAL for a
// second Google calendar), from env or data/cal.env. Sorted by key so the primary feed comes first.
function calUrls(p) {
  const base = 'CAL_ICS_' + p.name.toUpperCase(), vals = {};
  const take = (k, v) => { if ((k === base || k.startsWith(base + '_')) && String(v || '').trim()) vals[k] = String(v).trim(); };
  try {
    for (const line of fs.readFileSync(CAL_ENV_FILE, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*['"]?(.*?)['"]?\s*$/.exec(line);
      if (m) take(m[1], m[2]);
    }
  } catch { /* no file */ }
  for (const [k, v] of Object.entries(process.env)) take(k, v); // env wins
  return Object.keys(vals).sort().map((k) => vals[k]);
}
// The calendar id (an email or c_…@group.calendar.google.com) is the path segment of a Google iCal URL.
function calIdFromUrl(url) {
  try { const m = /\/calendar\/ical\/([^/]+)\//.exec(new URL(url).pathname); return m ? decodeURIComponent(m[1]).toLowerCase() : ''; } catch { return ''; }
}
async function asanaEmail(gid) {
  try { return ((await asana('GET', '/users/' + gid + '?opt_fields=email')).data.email || '').toLowerCase(); } catch { return ''; }
}
async function loadFeed(url, force) {
  const c = calCache[url];
  if (c && !force && Date.now() - c.at < CAL_TTL_MS) return c;
  const next = { at: Date.now(), cal: c ? c.cal : null, err: '' };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    next.cal = CAL.parse(await res.text());
  } catch (e) {
    next.err = 'calendar fetch failed (' + (/^HTTP \d+$/.test(e.message) ? e.message : e.name || 'error') + ')';
    console.error(new Date().toISOString(), 'calendar feed', next.err); // no URL in logs
  }
  calCache[url] = next;
  return next;
}
const emailCache = {};
async function loadCal(p, force) {
  const urls = calUrls(p);
  if (!urls.length) return null;
  const feeds = await Promise.all(urls.map(async (url) => ({ ...(await loadFeed(url, force)), calId: calIdFromUrl(url) })));
  if (!emailCache[p.k]) {
    const em = new Set(KNOWN_EMAILS[p.k] || []);
    if (p.gid) { const ae = await asanaEmail(p.gid); if (ae) em.add(ae); }
    for (const f of feeds) {
      const cn = f.cal ? CAL.calName(f.cal).toLowerCase() : '';
      if (/^[^\s@]+@[^\s@]+$/.test(cn) && !/calendar\.google\.com$/.test(cn)) em.add(cn);
      if (/^[^\s@]+@[^\s@]+$/.test(f.calId) && !/calendar\.google\.com$/.test(f.calId)) em.add(f.calId);
    }
    emailCache[p.k] = [...em];
  }
  return { feeds, emails: emailCache[p.k] };
}
// { k: { today, tomorrow, monday } | { nc: true } | { err } } for every person with a calendar slot.
// All the person's feeds are combined. Tomorrow is the next calendar day; monday is the next Monday.
async function getMeetings(today, force) {
  const { tomorrow, monday } = L.boardDates(today), out = {};
  await Promise.all(CFG.PEOPLE.filter((p) => p.gid).map(async (p) => {
    const c = await loadCal(p, force);
    if (!c) { out[p.k] = { nc: true }; return; }
    const ok = c.feeds.filter((f) => f.cal), errs = c.feeds.filter((f) => f.err).map((f) => f.err);
    if (!ok.length) { out[p.k] = { err: errs[0] || 'calendar unavailable' }; return; }
    try {
      const day = (ymd) => CAL.combineDays(ok.map((f) => CAL.dayMeetings(f.cal, ymd, c.emails, f.calId || c.emails[0])));
      const todayMeet = day(today);
      // Today's total is what is left now, not the original block. The list still has every event.
      const now = Date.now();
      todayMeet.min = CAL.remainingMinutes((todayMeet.list || []).map((m) => [Date.parse(m.s), Date.parse(m.e)]), now);
      out[p.k] = { today: todayMeet, tomorrow: day(tomorrow), monday: day(monday), ...(errs.length ? { stale: errs[0] } : {}) };
    } catch (e) { out[p.k] = { err: 'calendar parse failed' }; console.error(new Date().toISOString(), 'calendar parse', p.name, e.message); }
  }));
  return out;
}

/* ---------- API ---------- */
async function getBoard(force) {
  const today = L.athensDate(new Date());
  const assigned = CFG.PEOPLE.filter((p) => p.gid).map((p) => p.gid).join(',');
  const exclude = (await excludedProjectGids()).join(',');
  const since = L.addDays(today, -(CFG.DONE_DAYS + 1));
  const queries = [
    { 'assignee.any': assigned, completed: 'false' },
    { 'assignee.any': 'null', completed: 'false', is_subtask: 'false', 'projects.not': exclude },
    { 'assignee.any': assigned, completed: 'true', 'completed_on.after': since },
    { 'assignee.any': 'null', completed: 'true', is_subtask: 'false', 'projects.not': exclude, 'completed_on.after': since },
  ];
  const meetP = getMeetings(today, force).catch((e) => { console.error('meetings', e.message); return {}; });
  const results = await Promise.all(queries.map(searchAll));
  const meet = await meetP;
  const keyByGid = Object.fromEntries(CFG.PEOPLE.filter((p) => p.gid).map((p) => [p.gid, p.k]));
  const dates = L.boardDates(today);
  const oldest = L.addDays(today, -CFG.DONE_DAYS);
  const seen = new Set(), tasks = [];
  results.forEach((rows, qi) => rows.forEach((t) => {
    if (seen.has(t.gid)) return;
    const a = t.assignee ? keyByGid[t.assignee.gid] : 'un';
    if (!a) return; // assigned outside the team lanes
    const projObjs = t.projects || [];
    const activeProjs = projObjs.filter((p) => !p.archived);
    // Hide tasks that only live in archived Asana projects
    if (projObjs.length && !activeProjs.length) return;
    const projects = activeProjs.map((p) => p.name);
    if (a === 'un' && !projects.length) return;
    if ((t.memberships || []).some((m) => m.section && /notes/i.test(m.section.name || ''))) return; // skip any section whose name contains notes
    if (projects.some((n) => CFG.PRIVATE_PROJECT_RE.test(n)) && a !== CFG.PRIVATE_OWNER) return;
    const c = t.completed ? L.athensDate(t.completed_at) : '';
    if (t.completed && c < oldest) return;
    const m = L.minutesFromNotes(t.notes);
    // The column is the due date alone. Tags are not read and are not written.
    const d = L.dueDay(t), pl = L.placeByDate({ lane: a, due: d, today });
    seen.add(t.gid);
    tasks.push({ i: t.gid, a, n: t.name || '', p: projects.join(', '), pg: activeProjs[0] ? activeProjs[0].gid : '', par: t.parent ? t.parent.name : '', d, m: m === null ? L.DEFAULT_MIN : m, e: m === null ? 0 : 1, c, t: pl.t, w: pl.w, mo: pl.mo, ...(pl.src ? { src: pl.src } : {}) });
  }));
  return { today, tomorrow: dates.tomorrow, monday: dates.monday, meet, cap: CFG.CAP_MIN, store: CFG.TODAY_STORE, workspace: CFG.WORKSPACE, people: CFG.PEOPLE.map(({ k, name }) => ({ k, name, cap: L.dayCap(k) })), projects: sectionProjects(), loadedAt: new Date().toISOString(), tasks };
}

const gidOk = (g) => /^\d{5,25}$/.test(String(g || ''));

async function setCompleted({ i, completed }) {
  if (!gidOk(i)) throw Object.assign(new Error('bad task id'), { status: 400 });
  const d = (await asana('PUT', '/tasks/' + i + '?opt_fields=completed,completed_at', { data: { completed: !!completed } })).data;
  return { i, completed: d.completed, c: d.completed ? L.athensDate(d.completed_at) : '' };
}

async function setMinutes({ i, m }) {
  if (!gidOk(i)) throw Object.assign(new Error('bad task id'), { status: 400 });
  const minutes = L.clampMinutes(m, CFG.CAP_MIN);
  const t = (await asana('GET', '/tasks/' + i + '?opt_fields=notes,html_notes')).data;
  const body = L.isPlainHtml(t.notes, t.html_notes) ? { notes: L.rewritePlainNotes(t.notes, minutes) } : { html_notes: L.rewriteHtmlNotes(t.html_notes, minutes) };
  const d = (await asana('PUT', '/tasks/' + i + '?opt_fields=notes', { data: body })).data;
  return { i, m: L.minutesFromNotes(d.notes) };
}


/* ---------- task editor ---------- */
const EDIT_FIELDS = 'name,notes,html_notes,due_on,due_at,completed,assignee.name,assignee.gid,projects.name,parent.name,permalink_url';
function taskView(t) {
  const m = L.minutesFromNotes(t.notes);
  return {
    i: t.gid, n: t.name || '', notes: t.notes || '', d: t.due_on || '', due_at: t.due_at || '',
    assignee: t.assignee && t.assignee.name ? t.assignee.name.split(/\s+/)[0] : '',
    a: t.assignee ? ((CFG.PEOPLE.find((x) => x.gid === t.assignee.gid) || {}).k || 'other') : 'un',
    p: (t.projects || []).map((x) => x.name).join(', '), par: t.parent ? t.parent.name : '',
    link: t.permalink_url || '', rich: !L.isPlainHtml(t.notes, t.html_notes), completed: !!t.completed,
    m: m === null ? L.DEFAULT_MIN : m, e: m === null ? 0 : 1,
  };
}
async function getTask(i) {
  if (!gidOk(i)) throw Object.assign(new Error('bad task id'), { status: 400 });
  return taskView((await asana('GET', '/tasks/' + i + '?opt_fields=' + EDIT_FIELDS)).data);
}
// Body: any of {name, notes, due_on}. Only fields that differ from Asana's current value are sent.
// A new due date is stored as due_on. Existing tags are left as they are.
async function updateTask(i, edits) {
  if (!gidOk(i)) throw Object.assign(new Error('bad task id'), { status: 400 });
  const cur = (await asana('GET', '/tasks/' + i + '?opt_fields=name,notes,html_notes,due_on')).data;
  const body = L.buildTaskUpdate(cur, edits);
  if (!Object.keys(body).length) return { ...(await getTask(i)), changed: [] };
  const t = (await asana('PUT', '/tasks/' + i + '?opt_fields=' + EDIT_FIELDS, { data: body })).data;
  if ('due_on' in body) await clearPlanFiles(i);
  return { ...taskView(t), changed: Object.keys(body) };
}

let fileLock = Promise.resolve();
const withPlan = (fn) => (fileLock = fileLock.then(() => { const p = readJson(TODAY_FILE); fn(p); writeJson(TODAY_FILE, p); }));

// Due date of a column (Europe/Athens): Today -> today, Tomorrow -> the next calendar day, Monday -> the next Monday.
function slotDate(s) { return L.slotDue(s, L.athensDate(new Date())); }

// Box fallback only. Writes the local slot files and never calls Asana.
async function writeSlots(i, to) {
  for (const s of Object.keys(SLOT)) {
    const f = SLOT[s].file;
    await (fileLock = fileLock.then(() => { const p = readJson(f); if (to && to.s === s) p[i] = to.k; else delete p[i]; writeJson(f, p); }));
  }
}
async function clearPlanFiles(i) {
  if (CFG.TODAY_STORE !== 'file') return;
  for (const s of Object.keys(SLOT)) { const f = SLOT[s].file; await (fileLock = fileLock.then(() => { const p = readJson(f); if (p[i]) { delete p[i]; writeJson(f, p); } })); }
}
function dueWrite(s) { return s ? { due_on: slotDate(s) } : { due_on: null, due_at: null }; }

async function setToday({ i, t }) {
  if (!gidOk(i)) throw Object.assign(new Error('bad task id'), { status: 400 });
  if (t && !personByKey(t)) throw Object.assign(new Error('bad person'), { status: 400 });
  if (CFG.TODAY_STORE === 'file') { await withPlan((p) => { if (t) p[i] = t; else delete p[i]; }); return { i, t: t || '' }; }
  const d = (await asana('PUT', '/tasks/' + i + '?opt_fields=due_on,due_at', { data: dueWrite(t ? 't' : '') })).data;
  return { i, t: t || '', d: d.due_on || '' };
}

// Move a task between Backlog / Today / Tomorrow / Monday. from/to: {s:'t'|'w'|'mo', k} or null (Backlog).
// The only Asana write is due_on (date only, so a due time is replaced; Backlog clears due_on and due_at).
// Re-dropping in the same slot changes nothing. Tags are not created, added, or removed.
async function movePlan({ i, from, to }) {
  if (!gidOk(i)) throw Object.assign(new Error('bad task id'), { status: 400 });
  const ok = (x) => !x || (SLOT[x.s] && personByKey(x.k));
  if (!ok(from) || !ok(to)) throw Object.assign(new Error('bad slot'), { status: 400 });
  const same = from && to && from.s === to.s && from.k === to.k;
  if (CFG.TODAY_STORE === 'file') await writeSlots(i, to);
  if (same || (!from && !to)) return { i, to: to || null };
  const d = (await asana('PUT', '/tasks/' + i + '?opt_fields=due_on,due_at', { data: dueWrite(to && to.s) })).data;
  return { i, to: to || null, d: d.due_on || '' };
}

// Reassign: a = person key ('un' = unassign). The card stays in its column because the due date
// did not change. No tag is added or removed.
async function assignTask({ i, a, from }) {
  if (!gidOk(i)) throw Object.assign(new Error('bad task id'), { status: 400 });
  const p = personByKey(a);
  if (!p) throw Object.assign(new Error('bad person'), { status: 400 });
  if (from && !(SLOT[from.s] && personByKey(from.k))) throw Object.assign(new Error('bad slot'), { status: 400 });
  const d = (await asana('PUT', '/tasks/' + i + '?opt_fields=assignee.name', { data: { assignee: p.gid } })).data;
  let moved = null;
  if (from && from.k !== a) {
    if (CFG.TODAY_STORE === 'file') await writeSlots(i, { s: from.s, k: a });
    moved = { s: from.s, k: a };
  }
  return { i, a, assignee: d.assignee ? d.assignee.name : '', slot: moved || from || null };
}

// Take the listed tasks out of Today by clearing their due date. Does not touch tags.
async function clearToday({ entries }) {
  entries = (entries || []).filter((e) => gidOk(e.i) && personByKey(e.t));
  if (CFG.TODAY_STORE === 'file') { await withPlan((p) => entries.forEach((e) => delete p[e.i])); return { cleared: entries.length, failed: [] }; }
  const failed = [];
  let cleared = 0;
  for (let j = 0; j < entries.length; j += 10) {
    await Promise.all(entries.slice(j, j + 10).map(async (e) => {
      try { await asana('PUT', '/tasks/' + e.i + '?opt_fields=due_on,due_at', { data: { due_on: null, due_at: null } }); cleared++; }
      catch { failed.push(e.i); }
    }));
  }
  return { cleared, failed };
}

// '+' on a section: create a task in that section's project. Body: {name, notes, due_on, project, a, slot:{s:'t'|'w', k}|null}
async function createTask(body) {
  body = body || {};
  const data = L.buildNewTask(body);
  await excludedProjectGids(); // fills projectCache
  if (!gidOk(body.project) || !projectCache.all.some((p) => p.gid === String(body.project))) throw Object.assign(new Error('unknown project'), { status: 400 });
  const a = body.a && body.a !== 'un' ? body.a : 'un', p = personByKey(a);
  if (!p) throw Object.assign(new Error('bad person'), { status: 400 });
  const slot = body.slot || null;
  if (slot && !(SLOT[slot.s] && personByKey(slot.k))) throw Object.assign(new Error('bad slot'), { status: 400 });
  if (slot) data.due_on = slotDate(slot.s); // created in Today/Tomorrow/Monday: due that day
  data.projects = [String(body.project)];
  data.workspace = CFG.WORKSPACE;
  if (p.gid) data.assignee = p.gid;
  const t = (await asana('POST', '/tasks?opt_fields=' + CFG.TASK_FIELDS, { data })).data;
  if (slot && CFG.TODAY_STORE === 'file') await writeSlots(t.gid, slot);
  const m = L.minutesFromNotes(t.notes);
  return {
    i: t.gid, a, n: t.name || '', p: (t.projects || []).map((x) => x.name).join(', '), pg: String(body.project), par: '', d: t.due_on || '',
    m: m === null ? L.DEFAULT_MIN : m, e: m === null ? 0 : 1, c: '', t: slot && slot.s === 't' ? slot.k : '', w: slot && slot.s === 'w' ? slot.k : '', mo: slot && slot.s === 'mo' ? slot.k : '',
  };
}

/* ---------- HTTP ---------- */
const ROUTES = { '/api/completed': setCompleted, '/api/minutes': setMinutes, '/api/today': setToday, '/api/clear-today': clearToday, '/api/plan': movePlan, '/api/assign': assignTask, '/api/task': createTask };

// Build id: the deployed commit. Stable across instances so a Vercel cold start does not
// look like a new deploy. The page reloads itself when /api/board reports a different one.
const BUILD = String(process.env.VERCEL_GIT_COMMIT_SHA || process.env.RENDER_GIT_COMMIT || 'dev').slice(0, 12);
const HTML_HEADERS = { 'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0', Pragma: 'no-cache', Expires: '0' };
function send(res, status, body, type, extra) {
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', ...(extra || {}) });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function keyOk(req, url) {
  const k = url.searchParams.get('k') || req.headers['x-access-key'] || '';
  const a = Buffer.from(String(k)), b = Buffer.from(ACCESS_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const hdr = (req, name) => {
  const v = req.headers && req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

// Path the app routes on. Render passes the client path in req.url. Vercel may pass the
// function path (/api/...) plus the original path in x-invoke-path / x-invoke-query.
// / and /healthz are rewritten to /api/page and /api/healthz; map those back.
function incomingUrl(req) {
  let raw = req.url || '/';
  const invoked = hdr(req, 'x-invoke-path');
  if (typeof invoked === 'string' && invoked.startsWith('/') && invoked !== '/api' && !invoked.startsWith('/api/')) {
    const q = hdr(req, 'x-invoke-query');
    raw = q ? invoked + '?' + String(q) : invoked;
  }
  const u = new URL(raw, 'http://x');
  if (u.pathname === '/api/page') u.pathname = '/';
  else if (u.pathname === '/api/healthz') u.pathname = '/healthz';
  else if (u.pathname === '/api/index.html') u.pathname = '/index.html';
  return u.pathname + u.search;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
  let raw = '';
  if (req[Symbol.asyncIterator]) {
    for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) throw Object.assign(new Error('too large'), { status: 413 }); }
  }
  return raw ? JSON.parse(raw) : {};
}

function googleOn() { return !!String(process.env.GOOGLE_CLIENT_ID || '').trim(); }
function sessionSecret() { return String(process.env.SESSION_SECRET || ''); }
function allowList() { return AUTH.allowedEmails(process.env.ALLOWED_EMAILS); }
function cookieSecure(req) { return hdr(req, 'x-forwarded-proto') === 'https' || ON_VERCEL || ON_RENDER; }
function sessionEmail(req) {
  return AUTH.readSession(AUTH.cookieFrom(hdr(req, 'cookie')), sessionSecret(), Date.now(), allowList());
}
function pageHtml(email) {
  const user = email ? String(email).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) : '';
  return fs.readFileSync(path.join(DIR, 'public', 'index.html'), 'utf8')
    .replace(/__BUILD__/g, BUILD)
    .replace(/__AUTH__/g, email ? 'google' : 'key')
    .replace(/__USER__/g, user);
}

async function handle(req, res) {
  const url = new URL(incomingUrl(req), 'http://x');
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (googleOn()) {
      if (req.method === 'POST' && url.pathname === '/api/session') {
        if (!sessionSecret()) return send(res, 500, { error: 'SESSION_SECRET is not set' });
        const body = await readBody(req);
        const checked = await AUTH.verifyGoogleIdToken(body && body.credential, String(process.env.GOOGLE_CLIENT_ID).trim(), Date.now());
        if (!checked.ok) return send(res, 400, { error: checked.error });
        if (!AUTH.emailAllowed(checked.email, allowList())) return send(res, 403, { error: "This account isn't allowed" });
        const token = AUTH.signSession(checked.email, sessionSecret(), Date.now());
        return send(res, 200, { ok: true, email: checked.email }, 'application/json; charset=utf-8', { 'Set-Cookie': AUTH.cookieHeader(token, cookieSecure(req)) });
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        return send(res, 200, { ok: true }, 'application/json; charset=utf-8', { 'Set-Cookie': AUTH.clearCookieHeader(cookieSecure(req)) });
      }
      const email = sessionEmail(req);
      if (!email) {
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
          return send(res, 200, AUTH.loginPage(String(process.env.GOOGLE_CLIENT_ID).trim()), 'text/html; charset=utf-8', HTML_HEADERS);
        }
        return send(res, 401, { error: 'Sign in required' });
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, pageHtml(email), 'text/html; charset=utf-8', HTML_HEADERS);
      }
    } else if (!keyOk(req, url)) {
      return send(res, 403, '<h1>403</h1><p>This link needs its access key.</p>', 'text/html; charset=utf-8', HTML_HEADERS);
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, pageHtml(''), 'text/html; charset=utf-8', HTML_HEADERS);
    }
    if (req.method === 'GET' && url.pathname === '/api/board') return send(res, 200, { ...(await getBoard(url.searchParams.get('refresh') === '1')), build: BUILD });
    const dup = /^\/api\/tasks\/(\d{5,25})\/duplicate$/.exec(url.pathname);
    if (dup && req.method === 'POST') {
      const out = await DUP.runDuplicate(asana, dup[1], sleep);
      console.log(new Date().toISOString(), url.pathname, 'duplicate', out.i);
      return send(res, 200, out);
    }
    const tm = /^\/api\/task\/(\d{5,25})$/.exec(url.pathname);
    if (tm && req.method === 'GET') return send(res, 200, await getTask(tm[1]));
    if (req.method === 'POST' && (ROUTES[url.pathname] || tm)) {
      const body = await readBody(req);
      const out = tm ? await updateTask(tm[1], body) : await ROUTES[url.pathname](body);
      console.log(new Date().toISOString(), url.pathname, tm ? 'changed=' + out.changed.join(',') : JSON.stringify(out).slice(0, 200));
      return send(res, 200, out);
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(new Date().toISOString(), url.pathname, e.message);
    return send(res, e.status || 500, { error: e.message });
  }
}

if ((ON_RENDER || ON_VERCEL) && CFG.TODAY_STORE === 'file') console.error('WARNING: TODAY_STORE=file on an ephemeral disk; Today/Tomorrow will be lost on restart. Use asana_tags.');

if (require.main === module) {
  if (!process.env.ASANA_PAT) console.error('WARNING: ASANA_PAT is not set; /api/board will fail');
  http.createServer(handle).listen(CFG.PORT, CFG.HOST, () => console.log('day planner on', CFG.HOST + ':' + CFG.PORT, 'store=' + CFG.TODAY_STORE, CFG.READ_ONLY ? 'READ_ONLY' : ''));
}
module.exports = { createTask, getBoard, getTask, updateTask, movePlan, assignTask, setToday, clearToday, handle, incomingUrl, CFG };
