'use strict';
// Client-meeting minutes from Google Calendar secret iCal feeds (one per person).
// Only start/end/title of qualifying meetings ever leave this module.
const ical = require('node-ical');

const TZ = 'Europe/Athens';
const INTERNAL_DOMAIN = 'precisegreece.gr';
const CLIENT_CODE_RE = /^\s*\d{3}(?!\d)/; // '054 …', '917a …', '917 …'

// UTC instant of 00:00 Europe/Athens on ymd.
function athensMidnight(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  let t = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) { // offset can differ across the DST switch; two passes settle it
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    t -= asIfUtc - Date.UTC(y, m - 1, d);
  }
  return t;
}
function dayWindow(ymd) {
  const s = athensMidnight(ymd);
  const [y, m, d] = ymd.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return [s, athensMidnight(next)];
}

const val = (x) => (x && typeof x === 'object' && 'val' in x ? x.val : x);
const params = (x) => (x && typeof x === 'object' && x.params ? x.params : {});
const asList = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const emailOf = (a) => String(val(a) || '').replace(/^mailto:/i, '').trim().toLowerCase();

function isExternalAttendee(a) {
  const e = emailOf(a), p = params(a);
  if (!e || !e.includes('@')) return false;
  if (/^(room|resource)$/i.test(p.CUTYPE || '')) return false;
  if (/@(resource|group)\.calendar\.google\.com$/.test(e) || /\.calendar\.google\.com$/.test(e)) return false;
  return !(e === INTERNAL_DOMAIN || e.endsWith('@' + INTERNAL_DOMAIN) || e.endsWith('.' + INTERNAL_DOMAIN));
}

function isClientMeeting(ev) {
  const title = String(val(ev.summary) || '');
  if (CLIENT_CODE_RE.test(title)) return true;
  return asList(ev.attendee).some(isExternalAttendee);
}

function declinedBy(ev, selfEmails) {
  return asList(ev.attendee).some((a) => selfEmails.includes(emailOf(a)) && String(params(a).PARTSTAT || '').toUpperCase() === 'DECLINED');
}

function tentativeBy(ev, selfEmails) {
  return asList(ev.attendee).some((a) => selfEmails.includes(emailOf(a)) && String(params(a).PARTSTAT || '').toUpperCase() === 'TENTATIVE');
}

function parse(text) { return ical.sync.parseICS(String(text)); }

function calName(cal) {
  const v = cal.vcalendar || Object.values(cal).find((x) => x && x.type === 'VCALENDAR') || {};
  return String(val(v['WR-CALNAME']) || '');
}

// All instances (recurring expanded) overlapping [from, to).
function instances(cal, from, to) {
  const out = [];
  for (const ev of Object.values(cal)) {
    if (!ev || ev.type !== 'VEVENT' || !ev.start) continue;
    if (ev.rrule) {
      let xs = [];
      try { xs = ical.expandRecurringEvent(ev, { from: new Date(from), to: new Date(to), expandOngoing: true }); } catch { xs = []; }
      for (const x of xs) {
        const e2 = x.event || ev;
        // Google instance id uses the ORIGINAL occurrence start (RECURRENCE-ID for moved instances)
        const orig = x.isOverride && e2.recurrenceid ? +e2.recurrenceid : +x.start;
        out.push({ start: +x.start, end: +x.end, full: x.isFullDay, ev: e2, uid: ev.uid, inst: orig });
      }
    } else {
      if (ev.recurrenceid && cal[ev.uid] && cal[ev.uid] !== ev && cal[ev.uid].rrule) continue; // handled by the base event
      const full = ev.datetype === 'date' || (ev.start && ev.start.dateOnly);
      const s = +ev.start, e = ev.end ? +ev.end : (ev.duration ? s : s);
      out.push({ start: s, end: e, full, ev, uid: ev.uid, inst: ev.recurrenceid ? +ev.recurrenceid : null });
    }
  }
  for (const x of out) if (x.full && !(x.end > x.start)) x.end = x.start + 24 * 3600e3; // all-day without DTEND = one day
  // zero-length events (e.g. a reminder at 09:30) count as overlapping when they start inside the window
  return out.filter((x) => x.start < to && (x.end > from || (x.end === x.start && x.start >= from)));
}

const utcStamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20261029T080000Z
// Google Calendar link for an event (instance). Non-Google UIDs fall back to the day view.
function eventLink(uid, inst, calEmail, ymd, fullDay) {
  const m = /^(.+)@google\.com$/i.exec(String(uid || ''));
  if (!m || !calEmail) {
    const [y, mo, d] = ymd.split('-').map(Number);
    return 'https://calendar.google.com/calendar/r/day/' + y + '/' + mo + '/' + d;
  }
  let id = m[1];
  if (inst != null && !Number.isNaN(inst)) {
    // A split series ("this and following" edits) has a UID like <base>_R20260917T100000; Google's instance ids drop the _R… part.
    id = id.replace(/_R\d{8}(T\d{6}Z?)?$/, '') + '_' + (fullDay ? utcStamp(inst).slice(0, 8) : utcStamp(inst));
  }
  const eid = Buffer.from(id + ' ' + calEmail, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'https://calendar.google.com/calendar/event?eid=' + eid;
}

function mergedMinutes(intervals) {
  const xs = intervals.map((x) => [x[0], x[1]]).sort((a, b) => a[0] - b[0]);
  let total = 0, cur = null;
  for (const [s, e] of xs) {
    if (!cur || s > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [s, e]; } else cur[1] = Math.max(cur[1], e);
  }
  if (cur) total += cur[1] - cur[0];
  return Math.round(total / 60000);
}

// Client meetings for one Athens calendar day: { min, n, nt, list:[{s, e, title, link, tent?}] } (times clipped to the day).
// All of a person's calendar events for one Athens day (not only client meetings):
// { min, n, nt, list:[{s, e, title, link, tent?}], allday:[{title, link}] }
// Counted: accepted / needs-action / own events, overlaps merged. Tentative: listed, not counted.
// Declined and cancelled: hidden. Zero-length events are listed (s === e) and add 0. All-day: chips, never counted.
function dayMeetings(cal, ymd, selfEmails, calEmail) {
  const [from, to] = dayWindow(ymd);
  const self = (selfEmails || []).map((e) => String(e).toLowerCase());
  const list = [], allday = [];
  for (const x of instances(cal, from, to)) {
    const ev = x.ev;
    if (String(ev.status || '').toUpperCase() === 'CANCELLED') continue;
    if (declinedBy(ev, self)) continue;
    const title = String(val(ev.summary) || '(no title)'), link = eventLink(x.uid, x.inst, calEmail, ymd, x.full);
    if (x.full) { allday.push({ title, link }); continue; }
    if (x.end < x.start) continue;
    list.push({ s: new Date(Math.max(x.start, from)).toISOString(), e: new Date(Math.max(Math.min(x.end, to), Math.max(x.start, from))).toISOString(), title, link, ...(tentativeBy(ev, self) ? { tent: true } : {}) });
  }
  list.sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : a.e < b.e ? -1 : a.e > b.e ? 1 : 0));
  allday.sort((a, b) => (a.title < b.title ? -1 : 1));
  // Tentative events are listed but not counted (minutes, count, overlap merge).
  const counted = list.filter((m) => !m.tent);
  return { min: mergedMinutes(counted.map((m) => [Date.parse(m.s), Date.parse(m.e)])), n: counted.length, nt: list.length - counted.length, list, allday };
}

// Merge several feeds' days (e.g. primary + Personal calendar) into one; overlaps across feeds merged too.
function combineDays(days) {
  const list = [].concat(...days.map((d) => d.list)), allday = [].concat(...days.map((d) => d.allday || []));
  list.sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : a.e < b.e ? -1 : a.e > b.e ? 1 : 0));
  const counted = list.filter((m) => !m.tent);
  return { min: mergedMinutes(counted.map((m) => [Date.parse(m.s), Date.parse(m.e)])), n: counted.length, nt: list.length - counted.length, list, allday };
}

module.exports = { combineDays, eventLink, parse, calName, dayMeetings, dayWindow, athensMidnight, isClientMeeting, isExternalAttendee, mergedMinutes, CLIENT_CODE_RE };
