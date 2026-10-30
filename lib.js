'use strict';
// Pure helpers shared by the server and the tests.
const DCODE_RE = /^\s*D\s?(?:(\d+(?:[.,]\d+)?)\s*H)?\s*(?:(\d+)\s*M)?(?![A-Za-z0-9])/i;

// Minutes counted for a task whose notes have no D-code, and the code the app writes on save.
const DEFAULT_MIN = 10;
const DEFAULT_DCODE = 'D10M';
// Smallest duration the app writes (card −10 never goes below it).
const MIN_MIN = 10;
function clampMinutes(m, cap) { return Math.max(MIN_MIN, Math.min(cap || 480, Math.round(Number(m) || DEFAULT_MIN))); }

function minutesFromNotes(notes) {
  const first = String(notes || '').split('\n')[0];
  const m = DCODE_RE.exec(first);
  if (!m || (!m[1] && !m[2])) return null;
  const h = m[1] ? parseFloat(m[1].replace(',', '.')) : 0;
  return Math.round(h * 60 + (m[2] ? parseInt(m[2], 10) : 0));
}

function formatDCode(min) {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60), r = min % 60;
  return 'D' + (h ? h + 'H' : '') + (r || !h ? r + 'M' : '');
}

function rewritePlainNotes(notes, min) {
  notes = String(notes || '');
  const code = formatDCode(min);
  const nl = notes.indexOf('\n');
  const first = nl < 0 ? notes : notes.slice(0, nl);
  const m = DCODE_RE.exec(first);
  if (m && (m[1] || m[2])) return code + notes.slice(m[0].length);
  return notes ? code + '\n' + notes : code;
}

function rewriteHtmlNotes(html, min) {
  const code = formatDCode(min);
  const m = /^<body>([\s\S]*)<\/body>$/.exec(String(html || ''));
  let inner = m ? m[1] : '';
  const re = /^((?:<[^>]+>)*)(\s*D\s?(?:(\d+(?:[.,]\d+)?)\s*H)?\s*(?:(\d+)\s*M)?)(?=$|[\s<])/i;
  const mm = re.exec(inner);
  if (mm && (mm[3] || mm[4])) inner = mm[1] + code + inner.slice(mm[0].length);
  else inner = inner ? code + '\n' + inner : code;
  return '<body>' + inner + '</body>';
}

function unescapeHtml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function isPlainHtml(notes, html) {
  const m = /^<body>([\s\S]*)<\/body>$/.exec(String(html || ''));
  if (!m) return !html;
  return m[1].indexOf('<') < 0 && unescapeHtml(m[1]) === String(notes || '');
}

function athensDate(d) {
  if (!d) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Athens', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Next working day: Friday (and the weekend) -> Monday.
function nextWorkday(ymd) {
  let d = addDays(ymd, 1);
  while ([0, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay())) d = addDays(d, 1);
  return d;
}

// App save: the first line must be a D-code (same DCODE_RE as the parser); otherwise
// prepend D10M as its own line and keep the existing notes below. Existing codes are never changed.
function ensureDCode(notes) {
  notes = String(notes == null ? '' : notes).replace(/\r\n?/g, '\n');
  if (minutesFromNotes(notes) !== null) return notes;
  return notes.trim() ? DEFAULT_DCODE + '\n' + notes : DEFAULT_DCODE;
}

const normNotes = (s) => String(s == null ? '' : s).replace(/\r\n?/g, '\n');
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

// Build the Asana PUT body from the editor's edits: only fields present in `edits`
// that differ from `current` (the task as Asana has it now: name, notes, html_notes, due_on).
// Saving a name or notes always leaves a D-code on the notes' first line: edited notes go through
// ensureDCode; a name-only save of a task without a code also gets D10M (in html_notes when the
// notes are rich text, so formatting is kept). A due-date-only save never touches the notes.
// Throws on bad input.
function buildTaskUpdate(current, edits) {
  const out = {};
  edits = edits || {};
  if (edits.name !== undefined) {
    const n = String(edits.name).replace(/[\r\n]+/g, ' ').trim();
    if (!n) throw Object.assign(new Error('Name cannot be empty'), { status: 400 });
    if (n !== (current.name || '')) out.name = n;
  }
  if (edits.notes !== undefined) {
    const n = ensureDCode(edits.notes);
    if (n !== normNotes(current.notes)) out.notes = n;
  } else if (out.name !== undefined && minutesFromNotes(current.notes) === null) {
    if (isPlainHtml(current.notes, current.html_notes)) out.notes = ensureDCode(current.notes);
    else out.html_notes = rewriteHtmlNotes(current.html_notes, DEFAULT_MIN);
  }
  if (edits.due_on !== undefined) {
    const d = edits.due_on ? String(edits.due_on) : null;
    if (d && !YMD_RE.test(d)) throw Object.assign(new Error('Bad due date ' + d), { status: 400 });
    if (d !== (current.due_on || null)) out.due_on = d;
  }
  return out;
}

// New task from the planner's '+' button. Name must be more than the section prefix ('054a', 'PRE').
const PREFIX_ONLY_RE = /^(?:\d{3}[a-z]?|PRE)$/i;
function buildNewTask(input) {
  input = input || {};
  const name = String(input.name == null ? '' : input.name).replace(/[\r\n]+/g, ' ').trim();
  if (!name || PREFIX_ONLY_RE.test(name)) throw Object.assign(new Error('Type a task name after the prefix'), { status: 400 });
  const out = { name, notes: ensureDCode(input.notes) };
  if (input.due_on) {
    if (!YMD_RE.test(String(input.due_on))) throw Object.assign(new Error('Bad due date ' + input.due_on), { status: 400 });
    out.due_on = String(input.due_on);
  }
  return out;
}

// Column placement: explicit TODAY-/TOMORROW- tags win; otherwise the due date (Athens) decides:
// due today -> Today, due tomorrow -> Tomorrow, anything else (incl. overdue) -> Backlog. lane = the assignee key.
function placeByDate({ t, w, lane, due, today }) {
  if (t || w) return { t: t || '', w: t ? '' : w || '', src: '' };
  if (due && due === today) return { t: lane, w: '', src: 'd' };
  if (due && due === nextWorkday(today)) return { t: '', w: lane, src: 'd' };
  return { t: '', w: '', src: '' };
}
// Due date of an Asana task as an Athens day: due_at (a time) wins, else due_on.
function dueDay(t) { return t.due_at ? athensDate(t.due_at) : t.due_on || ''; }

module.exports = { DEFAULT_MIN, DEFAULT_DCODE, MIN_MIN, clampMinutes, placeByDate, dueDay, buildNewTask, ensureDCode, buildTaskUpdate, DCODE_RE, minutesFromNotes, formatDCode, rewritePlainNotes, rewriteHtmlNotes, isPlainHtml, athensDate, addDays, nextWorkday };
