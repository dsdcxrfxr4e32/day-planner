'use strict';
// PRECISE GREECE · Team day planner — small server on the box.
// Holds the Asana token server-side ($ASANA_PAT), serves the board, proxies Asana.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./lib');
const CAL = require('./cal');

const DIR = __dirname;
// data/ is optional (box: access_key, cal.env, tag cache). On hosts with an ephemeral disk (Render) everything
// required comes from env; files there are only a fallback or a cache.
const DATA = process.env.DATA_DIR || path.join(DIR, 'data');
const ON_RENDER = !!process.env.RENDER; // Render sets RENDER=true in every service
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
  // 'asana_tags': moving a task to Today adds the tag TODAY-<Name>. Tomorrow and Monday are due
  // dates only — TOMORROW_PREFIX is kept so a move can remove a leftover TOMORROW-<Name>, never to create one.
  // 'file': data/today.json, data/tomorrow.json, data/monday.json on the box.
  TODAY_STORE: process.env.TODAY_STORE || 'asana_tags',
  TAG_PREFIX: 'TODAY-',
  TOMORROW_PREFIX: 'TOMORROW-',
  TASK_FIELDS: 'name,assignee,completed,completed_at,created_at,due_on,due_at,notes,projects.name,projects.archived,parent.name,tags.name,memberships.section.name',
  READ_ONLY: process.env.READ_ONLY === '1', // test mode: refuse any write to Asana
};

// Shared-link key: ?k=<key>. Env ACCESS_KEY wins; else data/access_key (generated once on the box).
// On Render a generated key would change on every restart, so ACCESS_KEY is required there.
const KEY_FILE = path.join(DATA, 'access_key');
function loadAccessKey() {
  const env = String(process.env.ACCESS_KEY || '').trim();
  if (env) return env;
  try { const f = fs.readFileSync(KEY_FILE, 'utf8').trim(); if (f) return f; } catch { /* no file */ }
  if (ON_RENDER) { console.error('FATAL: ACCESS_KEY is not set (required on Render)'); process.exit(1); }
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
const TAGS_FILE = path.join(DATA, 'tag_gids.json');
const TOMORROW_FILE = path.join(DATA, 'tomorrow.json');
const MONDAY_FILE = path.join(DATA, 'monday.json');
// Tomorrow and Monday are due dates, not tags. `prefix` is only for the Today tag (and for
// recognising a leftover TOMORROW-<Name> so a move can remove it). Never create those tags.
const SLOT = {
  t: { prefix: () => CFG.TAG_PREFIX, file: TODAY_FILE },
  w: { prefix: () => CFG.TOMORROW_PREFIX, file: TOMORROW_FILE },
  mo: { prefix: () => null, file: MONDAY_FILE },
};
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const writeJson = (f, v) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(v, null, 1)); fs.renameSync(tmp, f); };
const personByKey = (k) => CFG.PEOPLE.find((p) => p.k === k);

const tagMem = {}; // tag name -> gid; data/tag_gids.json is just a cache, Asana is the source of truth
async function todayTagGid(k, create, prefix) {
  const p = personByKey(k);
  if (!p) throw Object.assign(new Error('Unknown person ' + k), { status: 400 });
  const name = (prefix || CFG.TAG_PREFIX) + p.name;
  if (tagMem[name]) return tagMem[name];
  const cache = readJson(TAGS_FILE);
  if (cache[name]) return (tagMem[name] = cache[name]);
  const tags = await listAll('/workspaces/' + CFG.WORKSPACE + '/tags?opt_fields=name');
  let gid = (tags.find((t) => t.name === name) || {}).gid;
  if (!gid && create) gid = (await asana('POST', '/tags', { data: { name, workspace: CFG.WORKSPACE, color: 'light-green' } })).data.gid;
  if (gid) { tagMem[name] = gid; cache[name] = gid; try { writeJson(TAGS_FILE, cache); } catch { /* cache only */ } }
  return gid || null;
}

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
    // Columns follow the due date. TODAY-/TOMORROW- tags are not read: a leftover tag cannot move a card.
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
async function updateTask(i, edits) {
  if (!gidOk(i)) throw Object.assign(new Error('bad task id'), { status: 400 });
  const cur = (await asana('GET', '/tasks/' + i + '?opt_fields=name,notes,html_notes,due_on,tags.name')).data;
  const body = L.buildTaskUpdate(cur, edits);
  if (!Object.keys(body).length) return { ...(await getTask(i)), changed: [] };
  const t = (await asana('PUT', '/tasks/' + i + '?opt_fields=' + EDIT_FIELDS, { data: body })).data;
  if ('due_on' in body) await clearPlan(i, cur.tags || []);
  return { ...taskView(t), changed: Object.keys(body) };
}

let fileLock = Promise.resolve();
const withPlan = (fn) => (fileLock = fileLock.then(() => { const p = readJson(TODAY_FILE); fn(p); writeJson(TODAY_FILE, p); }));

async function setToday({ i, t, prev }) {
  if (!gidOk(i)) throw Object.assign(new Error('bad task id'), { status: 400 });
  if (t && !personByKey(t)) throw Object.assign(new Error('bad person'), { status: 400 });
  if (CFG.TODAY_STORE === 'file') { await withPlan((p) => { if (t) p[i] = t; else delete p[i]; }); return { i, t: t || '' }; }
  if (prev && prev !== t) {
    const old = await todayTagGid(prev, false);
    if (old) await asana('POST', '/tasks/' + i + '/removeTag', { data: { tag: old } });
  }
  if (t) await asana('POST', '/tasks/' + i + '/addTag', { data: { tag: await todayTagGid(t, true) } });
  return { i, t: t || '' };
}

// A due-date edit drops Today/Tomorrow plan tags so the date alone decides the column
// (today -> Today, next calendar day -> Tomorrow, next Monday -> Monday, else Backlog).
async function clearPlan(i, tags) {
  if (CFG.TODAY_STORE === 'file') {
    for (const s of Object.keys(SLOT)) { const f = SLOT[s].file; await (fileLock = fileLock.then(() => { const p = readJson(f); if (p[i]) { delete p[i]; writeJson(f, p); } })); }
    return;
  }
  const pfx = [CFG.TAG_PREFIX, CFG.TOMORROW_PREFIX];
  for (const tg of tags || []) if (pfx.some((x) => x && (tg.name || '').startsWith(x)) && CFG.PEOPLE.some((p) => pfx.some((x) => tg.name === x + p.name)))
    await asana('POST', '/tasks/' + i + '/removeTag', { data: { tag: tg.gid } });
}

// Remove TODAY-<Name> and TOMORROW-<Name> from this one task. Does not delete the tag
// itself and does not scan the workspace. Never creates a tag.
async function stripPlanTags(i) {
  if (CFG.TODAY_STORE === 'file') return;
  const tags = ((await asana('GET', '/tasks/' + i + '?opt_fields=tags.name')).data || {}).tags || [];
  await clearPlan(i, tags);
}

// Move a task between Backlog / Today / Tomorrow / Monday. from/to: {s:'t'|'w'|'mo', k} or null (Backlog).
// Due date (Europe/Athens): Today -> today, Tomorrow -> the next calendar day, Monday -> the next Monday.
function slotDate(s) { return L.slotDue(s, L.athensDate(new Date())); }
// A move also sets the due date in the same call: into a column = that day (date only, replaces any
// due time); back to Backlog = no due date. Re-dropping in the same slot changes nothing.
// Tomorrow and Monday never add a tag. Any TODAY-/TOMORROW- plan tags already on the task are removed
// so they cannot outvote the date. Today still adds TODAY-<Name> (its existing tag).
async function movePlan({ i, from, to }) {
  const out = await movePlanTags({ i, from, to });
  const same = from && to && from.s === to.s && from.k === to.k;
  if (same || (!from && !to)) return out;
  const data = to ? { due_on: slotDate(to.s) } : { due_on: null, due_at: null };
  const t = (await asana('PUT', '/tasks/' + i + '?opt_fields=due_on,due_at', { data })).data;
  out.d = t.due_on || '';
  return out;
}
async function movePlanTags({ i, from, to }) {
  if (!gidOk(i)) throw Object.assign(new Error('bad task id'), { status: 400 });
  const ok = (x) => !x || (SLOT[x.s] && personByKey(x.k));
  if (!ok(from) || !ok(to)) throw Object.assign(new Error('bad slot'), { status: 400 });
  const same = from && to && from.s === to.s && from.k === to.k;
  if (CFG.TODAY_STORE === 'file') {
    for (const s of Object.keys(SLOT)) {
      const f = SLOT[s].file;
      await (fileLock = fileLock.then(() => { const p = readJson(f); if (to && to.s === s) p[i] = to.k; else delete p[i]; writeJson(f, p); }));
    }
    return { i, to: to || null };
  }
  if (same) return { i, to: to || null };
  await stripPlanTags(i);
  // Only Today keeps a plan tag. Tomorrow and Monday are the due date alone — do not add TOMORROW-* or MONDAY-*.
  if (to && to.s === 't') await asana('POST', '/tasks/' + i + '/addTag', { data: { tag: await todayTagGid(to.k, true, CFG.TAG_PREFIX) } });
  return { i, to: to || null };
}

// Reassign: a = person key ('un' = unassign). The card stays in its column because the due date
// did not change. A Today tag, if the task is in Today, moves to the new person. Tomorrow and
// Monday never gain a tag (that would recreate TOMORROW-<Name>).
async function assignTask({ i, a, from }) {
  if (!gidOk(i)) throw Object.assign(new Error('bad task id'), { status: 400 });
  const p = personByKey(a);
  if (!p) throw Object.assign(new Error('bad person'), { status: 400 });
  if (from && !(SLOT[from.s] && personByKey(from.k))) throw Object.assign(new Error('bad slot'), { status: 400 });
  const d = (await asana('PUT', '/tasks/' + i + '?opt_fields=assignee.name', { data: { assignee: p.gid } })).data;
  let moved = null;
  if (from && from.k !== a) {
    if (from.s === 't') await movePlanTags({ i, from, to: { s: 't', k: a } });
    moved = { s: from.s, k: a };
  }
  return { i, a, assignee: d.assignee ? d.assignee.name : '', slot: moved || from || null };
}

async function clearToday({ entries }) {
  entries = (entries || []).filter((e) => gidOk(e.i) && personByKey(e.t));
  if (CFG.TODAY_STORE === 'file') { await withPlan((p) => entries.forEach((e) => delete p[e.i])); return { cleared: entries.length, failed: [] }; }
  const failed = [];
  let cleared = 0;
  for (let j = 0; j < entries.length; j += 10) {
    await Promise.all(entries.slice(j, j + 10).map(async (e) => {
      try { const tag = await todayTagGid(e.t, false); if (tag) await asana('POST', '/tasks/' + e.i + '/removeTag', { data: { tag } }); cleared++; }
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
  let planned = null;
  if (slot && slot.s === 't') {
    try { await movePlanTags({ i: t.gid, from: null, to: slot }); planned = slot; }
    catch (e) { console.error(new Date().toISOString(), 'create: tag failed', e.message); }
  } else if (slot) planned = slot; // Tomorrow/Monday: the due date places the card; no plan tag
  const m = L.minutesFromNotes(t.notes);
  return {
    i: t.gid, a, n: t.name || '', p: (t.projects || []).map((x) => x.name).join(', '), pg: String(body.project), par: '', d: t.due_on || '',
    m: m === null ? L.DEFAULT_MIN : m, e: m === null ? 0 : 1, c: '', t: planned && planned.s === 't' ? planned.k : '', w: planned && planned.s === 'w' ? planned.k : '', mo: planned && planned.s === 'mo' ? planned.k : '',
    tagged: !slot || !!planned,
  };
}

/* ---------- HTTP ---------- */
const ROUTES = { '/api/completed': setCompleted, '/api/minutes': setMinutes, '/api/today': setToday, '/api/clear-today': clearToday, '/api/plan': movePlan, '/api/assign': assignTask, '/api/task': createTask };

// Build id: the deployed commit on Render, else the process start. The page carries it and reloads
// itself when /api/board reports a different one (a tab left open across a deploy).
const BUILD = String(process.env.RENDER_GIT_COMMIT || Date.now().toString(36)).slice(0, 12);
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (!keyOk(req, url)) return send(res, 403, '<h1>403</h1><p>This link needs its access key.</p>', 'text/html; charset=utf-8', HTML_HEADERS);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(DIR, 'public', 'index.html'), 'utf8').replace('__BUILD__', BUILD), 'text/html; charset=utf-8', HTML_HEADERS);
    }
    if (req.method === 'GET' && url.pathname === '/api/board') return send(res, 200, { ...(await getBoard(url.searchParams.get('refresh') === '1')), build: BUILD });
    const tm = /^\/api\/task\/(\d{5,25})$/.exec(url.pathname);
    if (tm && req.method === 'GET') return send(res, 200, await getTask(tm[1]));
    if (req.method === 'POST' && (ROUTES[url.pathname] || tm)) {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) throw Object.assign(new Error('too large'), { status: 413 }); }
      const body = raw ? JSON.parse(raw) : {};
      const out = tm ? await updateTask(tm[1], body) : await ROUTES[url.pathname](body);
      console.log(new Date().toISOString(), url.pathname, tm ? 'changed=' + out.changed.join(',') : JSON.stringify(out).slice(0, 200));
      return send(res, 200, out);
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(new Date().toISOString(), url.pathname, e.message);
    return send(res, e.status || 500, { error: e.message });
  }
});

if (require.main === module) {
  if (ON_RENDER && CFG.TODAY_STORE === 'file') console.error('WARNING: TODAY_STORE=file on an ephemeral disk; Today/Tomorrow will be lost on restart. Use asana_tags.');
  if (!process.env.ASANA_PAT) console.error('WARNING: ASANA_PAT is not set; /api/board will fail');
  server.listen(CFG.PORT, CFG.HOST, () => console.log('day planner on', CFG.HOST + ':' + CFG.PORT, 'store=' + CFG.TODAY_STORE, CFG.READ_ONLY ? 'READ_ONLY' : ''));
}
module.exports = { createTask, getBoard, getTask, updateTask, movePlan, assignTask, CFG };
