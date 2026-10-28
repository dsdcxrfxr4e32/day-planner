/**
 * PRECISE GREECE · Team day planner (Google Apps Script web app)
 * Server side: every Asana call happens here, with the personal access token
 * kept in Script Properties (ASANA_PAT). The browser never sees the token.
 */

var CFG = {
  WORKSPACE: '1213289283868810',
  API: 'https://app.asana.com/api/1.0',
  TZ: 'Europe/Athens',
  CAP_MIN: 480,
  DONE_DAYS: 14,
  // Lanes. gid null = Unassigned.
  PEOPLE: [
    { k: 'dm', name: 'Dimitris', gid: '1213289276153981' },
    { k: 'ak', name: 'Antonia', gid: '1213448855148301' },
    { k: 'dd', name: 'Dimitra', gid: '1213448798749941' },
    { k: 'un', name: 'Unassigned', gid: null }
  ],
  // Unassigned tasks in these projects are never shown (by name, resolved to gids at load).
  EXCLUDE_UNASSIGNED_PROJECTS: ['012a AMK', 'Private Dimitris', 'Precise Private'],
  // Tasks in a project matching this are shown only when assigned to Dimitris.
  PRIVATE_PROJECT_RE: /private/i,
  PRIVATE_OWNER: 'dm',
  // Where the planned "Today" state lives: 'asana_tags' (tags TODAY-<Name> on the task)
  // or 'properties' (Script Properties JSON, shared by everyone using this deployment).
  TODAY_STORE: 'asana_tags',
  TAG_PREFIX: 'TODAY-',
  TASK_FIELDS: 'name,assignee,completed,completed_at,created_at,due_on,notes,projects.name,parent.name,tags.name'
};

var DCODE_RE = /^\s*D\s?(?:(\d+(?:[.,]\d+)?)\s*H)?\s*(?:(\d+)\s*M)?(?![A-Za-z0-9])/i;

/* ------------------------------------------------------------------ web entry */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Team day planner')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ------------------------------------------------------------------ helpers */

function pat_() {
  var t = PropertiesService.getScriptProperties().getProperty('ASANA_PAT');
  if (!t) throw new Error('ASANA_PAT is not set. Project Settings > Script Properties > add ASANA_PAT.');
  return t;
}

function todayStr_() {
  return Utilities.formatDate(new Date(), CFG.TZ, 'yyyy-MM-dd');
}

function athensDate_(iso) {
  if (!iso) return '';
  return Utilities.formatDate(new Date(iso), CFG.TZ, 'yyyy-MM-dd');
}

function addDays_(ymd, n) {
  var p = ymd.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
  return d.toISOString().slice(0, 10);
}

function qs_(params) {
  return Object.keys(params).filter(function (k) { return params[k] !== undefined && params[k] !== null && params[k] !== ''; })
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
}

function req_(method, path, body) {
  var o = {
    method: method,
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + pat_(), Accept: 'application/json' }
  };
  if (body !== undefined) { o.contentType = 'application/json'; o.payload = JSON.stringify(body); }
  return { url: CFG.API + path, params: o };
}

function parse_(resp, label) {
  var code = resp.getResponseCode();
  var text = resp.getContentText();
  if (code >= 200 && code < 300) return text ? JSON.parse(text) : {};
  var msg = text;
  try { msg = JSON.parse(text).errors.map(function (e) { return e.message; }).join('; '); } catch (e) { /* raw */ }
  var err = new Error('Asana ' + code + ' on ' + label + ': ' + msg);
  err.code = code;
  throw err;
}

/** One call with 429/5xx retry. */
function call_(method, path, body) {
  for (var attempt = 0; attempt < 4; attempt++) {
    var r = req_(method, path, body);
    var resp = UrlFetchApp.fetch(r.url, r.params);
    var code = resp.getResponseCode();
    if (code === 429 || code >= 500) {
      var h = resp.getHeaders() || {};
      var wait = Number(h['Retry-After'] || h['retry-after'] || 2);
      Utilities.sleep(Math.min(30, Math.max(1, wait)) * 1000);
      continue;
    }
    return parse_(resp, method + ' ' + path.split('?')[0]);
  }
  throw new Error('Asana kept rate-limiting ' + path.split('?')[0] + '; try Refresh in a minute.');
}

/** Many calls in parallel (UrlFetchApp.fetchAll), each retried individually on 429/5xx. */
function callAll_(reqs) {
  var out = new Array(reqs.length);
  var todo = reqs.map(function (r, i) { return i; });
  for (var attempt = 0; attempt < 4 && todo.length; attempt++) {
    var built = todo.map(function (i) { var r = req_(reqs[i][0], reqs[i][1], reqs[i][2]); r.params.url = r.url; return r.params; });
    var resps = UrlFetchApp.fetchAll(built);
    var again = [];
    resps.forEach(function (resp, j) {
      var i = todo[j];
      var code = resp.getResponseCode();
      if (code === 429 || code >= 500) { again.push(i); return; }
      try { out[i] = { ok: true, data: parse_(resp, reqs[i][0] + ' ' + reqs[i][1].split('?')[0]) }; }
      catch (e) { out[i] = { ok: false, error: e.message }; }
    });
    todo = again;
    if (todo.length) Utilities.sleep(2000);
  }
  todo.forEach(function (i) { out[i] = { ok: false, error: 'rate limited' }; });
  return out;
}

/**
 * Run several task searches to completion. Search has no next_page, so each stream
 * pages by sort_by=created_at ascending + created_at.after=<last seen>. All streams
 * advance together, one fetchAll per round.
 */
function searchAll_(queries) {
  var streams = queries.map(function (q) { return { q: q, after: null, done: false, rows: [] }; });
  for (var round = 0; round < 60; round++) {
    var live = streams.filter(function (s) { return !s.done; });
    if (!live.length) break;
    var res = callAll_(live.map(function (s) {
      var p = {};
      Object.keys(s.q).forEach(function (k) { p[k] = s.q[k]; });
      p.sort_by = 'created_at'; p.sort_ascending = 'true'; p.limit = 100; p.opt_fields = CFG.TASK_FIELDS;
      if (s.after) p['created_at.after'] = s.after;
      return ['get', '/workspaces/' + CFG.WORKSPACE + '/tasks/search?' + qs_(p)];
    }));
    res.forEach(function (r, i) {
      var s = live[i];
      if (!r.ok) throw new Error(r.error);
      var d = r.data.data || [];
      s.rows = s.rows.concat(d);
      if (d.length < 100) { s.done = true; return; }
      var last = d[d.length - 1].created_at;
      if (!last || last === s.after) { s.done = true; return; }
      s.after = last;
    });
  }
  return streams.map(function (s) { return s.rows; });
}

function projectGids_(names) {
  var want = {};
  names.forEach(function (n) { want[n] = true; });
  var gids = [], offset = null;
  for (var i = 0; i < 20; i++) {
    var d = call_('get', '/workspaces/' + CFG.WORKSPACE + '/projects?' + qs_({ limit: 100, opt_fields: 'name', offset: offset }));
    (d.data || []).forEach(function (p) { if (want[p.name]) gids.push(p.gid); });
    if (!d.next_page || !d.next_page.offset) break;
    offset = d.next_page.offset;
  }
  return gids;
}

/* ------------------------------------------------------------------ D-code (minutes) */

function minutesFromNotes(notes) {
  var first = String(notes || '').split('\n')[0];
  var m = DCODE_RE.exec(first);
  if (!m || (!m[1] && !m[2])) return null;
  var h = m[1] ? parseFloat(m[1].replace(',', '.')) : 0;
  return Math.round(h * 60 + (m[2] ? parseInt(m[2], 10) : 0));
}

function formatDCode(min) {
  min = Math.max(0, Math.round(min));
  var h = Math.floor(min / 60), r = min % 60;
  return 'D' + (h ? h + 'H' : '') + (r || !h ? r + 'M' : '');
}

/** Plain notes: replace the first-line D-code, or prepend one. Rest of the text untouched. */
function rewritePlainNotes(notes, min) {
  notes = String(notes || '');
  var code = formatDCode(min);
  var nl = notes.indexOf('\n');
  var first = nl < 0 ? notes : notes.slice(0, nl);
  var m = DCODE_RE.exec(first);
  if (m && (m[1] || m[2])) return code + notes.slice(m[0].length);
  return notes ? code + '\n' + notes : code;
}

/** Rich notes (<body>…</body>): replace the D-code at the start of the text (it may sit inside
 *  leading inline tags such as <strong>), or insert one as the first line. */
function rewriteHtmlNotes(html, min) {
  var code = formatDCode(min);
  var m = /^<body>([\s\S]*)<\/body>$/.exec(String(html || ''));
  var inner = m ? m[1] : '';
  var re = /^((?:<[^>]+>)*)(\s*D\s?(?:(\d+(?:[.,]\d+)?)\s*H)?\s*(?:(\d+)\s*M)?)(?=$|[\s<])/i;
  var mm = re.exec(inner);
  if (mm && (mm[3] || mm[4])) inner = mm[1] + code + inner.slice(mm[0].length);
  else inner = inner ? code + '\n' + inner : code;
  return '<body>' + inner + '</body>';
}

function unescapeHtml_(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/** True when html_notes carries no formatting beyond the plain text in notes. */
function isPlainHtml_(notes, html) {
  var m = /^<body>([\s\S]*)<\/body>$/.exec(String(html || ''));
  if (!m) return !html;
  return m[1].indexOf('<') < 0 && unescapeHtml_(m[1]) === String(notes || '');
}

/* ------------------------------------------------------------------ Today state */

function tagKeyByName_() {
  var m = {};
  CFG.PEOPLE.forEach(function (p) { m[CFG.TAG_PREFIX + p.name] = p.k; });
  return m;
}

function personByKey_(k) {
  for (var i = 0; i < CFG.PEOPLE.length; i++) if (CFG.PEOPLE[i].k === k) return CFG.PEOPLE[i];
  return null;
}

/** gid of tag TODAY-<Name>; looked up once, created on first use, cached in Script Properties. */
function todayTagGid_(k, create) {
  var p = personByKey_(k);
  if (!p) throw new Error('Unknown person ' + k);
  var name = CFG.TAG_PREFIX + p.name;
  var props = PropertiesService.getScriptProperties();
  var cached = props.getProperty('TAG_GID_' + name);
  if (cached) return cached;
  var offset = null, found = null;
  for (var i = 0; i < 30 && !found; i++) {
    var d = call_('get', '/workspaces/' + CFG.WORKSPACE + '/tags?' + qs_({ limit: 100, opt_fields: 'name', offset: offset }));
    (d.data || []).forEach(function (t) { if (t.name === name) found = t.gid; });
    if (!d.next_page || !d.next_page.offset) break;
    offset = d.next_page.offset;
  }
  if (!found && create) {
    found = call_('post', '/tags', { data: { name: name, workspace: CFG.WORKSPACE, color: 'light-green' } }).data.gid;
  }
  if (found) props.setProperty('TAG_GID_' + name, found);
  return found;
}

function readTodayProps_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('TODAY_PLAN') || '{}'); }
  catch (e) { return {}; }
}

function writeTodayProps_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var plan = readTodayProps_();
    fn(plan);
    PropertiesService.getScriptProperties().setProperty('TODAY_PLAN', JSON.stringify(plan));
    return plan;
  } finally { lock.releaseLock(); }
}

/* ------------------------------------------------------------------ API for the page */

/** Fresh board from Asana. */
function getBoard() {
  var today = todayStr_();
  var assigned = CFG.PEOPLE.filter(function (p) { return p.gid; }).map(function (p) { return p.gid; }).join(',');
  var exclude = projectGids_(CFG.EXCLUDE_UNASSIGNED_PROJECTS).join(',');
  var since = addDays_(today, -(CFG.DONE_DAYS + 1));
  var results = searchAll_([
    { 'assignee.any': assigned, completed: 'false' },
    { 'assignee.any': 'null', completed: 'false', is_subtask: 'false', 'projects.not': exclude },
    { 'assignee.any': assigned, completed: 'true', 'completed_on.after': since },
    { 'assignee.any': 'null', completed: 'true', is_subtask: 'false', 'projects.not': exclude, 'completed_on.after': since }
  ]);

  var keyByGid = {};
  CFG.PEOPLE.forEach(function (p) { if (p.gid) keyByGid[p.gid] = p.k; });
  var tagKey = tagKeyByName_();
  var plan = CFG.TODAY_STORE === 'properties' ? readTodayProps_() : null;
  var oldest = addDays_(today, -CFG.DONE_DAYS);
  var seen = {}, tasks = [];

  results.forEach(function (rows, qi) {
    rows.forEach(function (t) {
      if (seen[t.gid]) return;
      var a = t.assignee ? keyByGid[t.assignee.gid] : 'un';
      if (!a) return; // assigned to someone outside the team lanes
      var projects = (t.projects || []).map(function (p) { return p.name; });
      if (a === 'un' && (qi === 1 || qi === 3) && !projects.length) return; // unassigned + no project: skip
      var isPrivate = projects.some(function (n) { return CFG.PRIVATE_PROJECT_RE.test(n); });
      if (isPrivate && a !== CFG.PRIVATE_OWNER) return;
      var c = t.completed ? athensDate_(t.completed_at) : '';
      if (t.completed && c < oldest) return;
      var m = minutesFromNotes(t.notes);
      var owner = '';
      if (plan) owner = plan[t.gid] || '';
      else (t.tags || []).forEach(function (tg) { if (tagKey[tg.name]) owner = owner || tagKey[tg.name]; });
      if (owner && a !== 'un' && owner !== a) owner = a; // assigned tasks only plan into their own lane
      seen[t.gid] = true;
      tasks.push({
        i: t.gid, a: a, n: t.name || '', p: projects.join(', '),
        par: t.parent ? t.parent.name : '', d: t.due_on || '',
        m: m === null ? 10 : m, e: m === null ? 0 : 1, c: c, t: owner
      });
    });
  });

  return {
    today: today, cap: CFG.CAP_MIN, store: CFG.TODAY_STORE, workspace: CFG.WORKSPACE,
    people: CFG.PEOPLE.map(function (p) { return { k: p.k, name: p.name }; }),
    loadedAt: new Date().toISOString(), tasks: tasks
  };
}

/** Done circle → completed=true; Undo → completed=false. */
function setCompleted(gid, completed) {
  var d = call_('put', '/tasks/' + encodeURIComponent(gid) + '?opt_fields=completed,completed_at', { data: { completed: !!completed } }).data;
  return { i: gid, completed: d.completed, c: d.completed ? athensDate_(d.completed_at) : '' };
}

/** Rewrite the first-line D-code. Reads the task fresh so concurrent edits to the rest are kept. */
function setMinutes(gid, minutes) {
  minutes = Math.max(5, Math.min(CFG.CAP_MIN, Math.round(Number(minutes) || 10)));
  var t = call_('get', '/tasks/' + encodeURIComponent(gid) + '?opt_fields=notes,html_notes').data;
  var body = isPlainHtml_(t.notes, t.html_notes)
    ? { notes: rewritePlainNotes(t.notes, minutes) }
    : { html_notes: rewriteHtmlNotes(t.html_notes, minutes) };
  var d = call_('put', '/tasks/' + encodeURIComponent(gid) + '?opt_fields=notes', { data: body }).data;
  return { i: gid, m: minutesFromNotes(d.notes) };
}

/** Plan a task into a person's Today (owner = lane key) or back to Backlog (owner = ''). */
function setToday(gid, owner, prevOwner) {
  if (CFG.TODAY_STORE === 'properties') {
    writeTodayProps_(function (plan) { if (owner) plan[gid] = owner; else delete plan[gid]; });
    return { i: gid, t: owner || '' };
  }
  if (prevOwner && prevOwner !== owner) {
    var oldTag = todayTagGid_(prevOwner, false);
    if (oldTag) call_('post', '/tasks/' + encodeURIComponent(gid) + '/removeTag', { data: { tag: oldTag } });
  }
  if (owner) call_('post', '/tasks/' + encodeURIComponent(gid) + '/addTag', { data: { tag: todayTagGid_(owner, true) } });
  return { i: gid, t: owner || '' };
}

/** Clear Today for a list of {i, t} entries. */
function clearToday(entries) {
  entries = entries || [];
  if (CFG.TODAY_STORE === 'properties') {
    writeTodayProps_(function (plan) { entries.forEach(function (e) { delete plan[e.i]; }); });
    return { cleared: entries.length, failed: [] };
  }
  var tagOf = {};
  var reqs = [], ids = [];
  entries.forEach(function (e) {
    if (!(e.t in tagOf)) tagOf[e.t] = todayTagGid_(e.t, false);
    if (!tagOf[e.t]) return;
    reqs.push(['post', '/tasks/' + encodeURIComponent(e.i) + '/removeTag', { data: { tag: tagOf[e.t] } }]);
    ids.push(e.i);
  });
  var failed = [];
  for (var i = 0; i < reqs.length; i += 25) {
    callAll_(reqs.slice(i, i + 25)).forEach(function (r, j) { if (!r.ok) failed.push(ids[i + j]); });
  }
  return { cleared: reqs.length - failed.length, failed: failed };
}
