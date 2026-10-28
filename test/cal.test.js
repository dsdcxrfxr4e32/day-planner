// Calendar parsing / client-meeting classification against a synthetic feed (no real calendar data).
const a = require('assert'), fs = require('fs'), path = require('path'), C = require('../cal');
const cal = C.parse(fs.readFileSync(path.join(__dirname, 'fixture.ics'), 'utf8'));
const SELF = ['test@precisegreece.gr'];
const hm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Europe/Athens', hour: '2-digit', minute: '2-digit' });
const titles = (d) => d.list.map((m) => hm(m.s) + '-' + hm(m.e) + ' ' + m.title);

a.equal(C.calName(cal), 'test@precisegreece.gr');
// Mon 2 Nov: ALL timed events (internal too). Zero-length 09:30 reminder listed, adds 0.
// 10-11 + 10:30-11:30 merged 90; internal 12-13 60; weekly 16:30-17 + '2026 planning' 17-18 merged 90 -> 240.
// Hidden: cancelled, declined (case-insensitive email). All-day -> allday chips, not counted.
const d1 = C.dayMeetings(cal, '2026-11-02', SELF);
a.deepEqual(titles(d1), ['09:30-09:30 Reminder call', '10:00-11:00 Client call (external attendee)', '10:30-11:30 054a Site visit', '12:00-13:00 PRECISE internal sync',
  '16:30-17:00 917 Weekly', '16:45-17:30 054 Tentative workshop', '17:00-18:00 2026 planning']);
// tentative (self PARTSTAT=TENTATIVE) is listed but not counted and not merged (it would bridge nothing extra here, but would add 16:45-17:30 overlap)
a.equal(d1.n, 6); a.equal(d1.nt, 1); a.equal(d1.min, 240);
a.deepEqual(d1.list.map((m) => !!m.tent), [false, false, false, false, false, true, false]);
a.equal(d1.list[0].s, d1.list[0].e); // zero-length
a.deepEqual(d1.allday.map((x) => x.title), ['917 Workshop day']);
a.deepEqual(Object.keys(d1.list[0]).sort(), ['e', 'link', 's', 'title']); // nothing else exposed
a.deepEqual(Object.keys(d1.allday[0]).sort(), ['link', 'title']);
a.deepEqual(C.dayMeetings(cal, '2026-11-03', SELF).allday, []); // DTEND is exclusive
{ // tentative alone, not overlapping anything counted: still 0 minutes
  const t = C.parse(fs.readFileSync(path.join(__dirname, 'fixture.ics'), 'utf8').replace('20261102T164500', '20261102T190000').replace('20261102T173000', '20261102T200000'));
  const d = C.dayMeetings(t, '2026-11-02', SELF); a.equal(d.min, 240); a.equal(d.nt, 1);
}
// Tue 3 Nov: late call clipped at midnight Athens -> 30 min.
const d2 = C.dayMeetings(cal, '2026-11-03', SELF);
a.deepEqual(titles(d2), ['23:30-00:00 906 Late call']); a.equal(d2.min, 30);
a.equal(C.dayMeetings(cal, '2026-11-04', SELF).min, 30); // the rest of it on Wed
// EXDATE: no weekly on 9 Nov. Override: 16 Nov moved to Tue 17 Nov 09:00-09:45.
a.equal(C.dayMeetings(cal, '2026-11-09', SELF).n, 0);
a.equal(C.dayMeetings(cal, '2026-11-16', SELF).n, 0);
a.deepEqual(titles(C.dayMeetings(cal, '2026-11-17', SELF)), ['09:00-09:45 917 Weekly (moved)']);
a.deepEqual(titles(C.dayMeetings(cal, '2026-11-23', SELF)), ['16:30-17:00 917 Weekly']);
// Before DST end (26 Oct is EET already; 19 Oct is EEST): weekly at 16:30 local both times.
a.deepEqual(titles(C.dayMeetings(cal, '2026-10-19', SELF)), ['16:30-17:00 917 Weekly']);
// Without the self email the declined lunch counts.
a.equal(C.dayMeetings(cal, '2026-11-02', []).n, 8); a.equal(C.dayMeetings(cal, '2026-11-02', []).nt, 0); a.equal(C.dayMeetings(cal, '2026-11-02', []).min, 300); // + declined lunch 60, tentative counted (inside 16:30-18)
// helpers
a.ok(C.CLIENT_CODE_RE.test('054 x')); a.ok(C.CLIENT_CODE_RE.test('917a Review')); a.ok(C.CLIENT_CODE_RE.test(' 917 ')); a.ok(!C.CLIENT_CODE_RE.test('2026 plan')); a.ok(!C.CLIENT_CODE_RE.test('ADA 054'));
a.equal(C.mergedMinutes([[0, 60e3 * 60], [30 * 60e3, 90 * 60e3], [120 * 60e3, 150 * 60e3]]), 120);
a.deepEqual(C.dayWindow('2026-10-25').map((x) => new Date(x).toISOString()), ['2026-10-24T21:00:00.000Z', '2026-10-25T22:00:00.000Z']);
a.deepEqual(C.dayWindow('2026-03-29').map((x) => new Date(x).toISOString()), ['2026-03-28T22:00:00.000Z', '2026-03-29T21:00:00.000Z']);
// Google Calendar links: eid = base64url('<id>[_<UTC start of the original occurrence>] <calendar email>')
const eid = (l) => Buffer.from(new URL(l).searchParams.get('eid').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
const L2 = C.dayMeetings(cal, '2026-11-02', SELF, 'test@precisegreece.gr').list, by = (t) => L2.find((m) => m.title === t);
a.equal(eid(by('Client call (external attendee)').link), 'ext1 test@precisegreece.gr'); a.ok(!/=/.test(new URL(by('Client call (external attendee)').link).searchParams.get('eid')));
a.equal(by('054a Site visit').link, 'https://calendar.google.com/calendar/r/day/2026/11/2'); // non-Google UID -> day view
a.equal(eid(by('917 Weekly').link), 'wk123abc_20261102T143000Z test@precisegreece.gr'); // 16:30 EET = 14:30Z
a.equal(eid(C.dayMeetings(cal, '2026-10-19', SELF, 'test@precisegreece.gr').list[0].link), 'wk123abc_20261019T133000Z test@precisegreece.gr'); // EEST
a.equal(eid(C.dayMeetings(cal, '2026-11-17', SELF, 'test@precisegreece.gr').list[0].link), 'wk123abc_20261116T143000Z test@precisegreece.gr'); // moved: original start
a.equal(C.eventLink('x@google.com', Date.UTC(2026, 10, 2), 'a@b.c', '2026-11-02', true).length > 0, true);
a.equal(eid(C.eventLink('x@google.com', Date.UTC(2026, 10, 2), 'a@b.c', '2026-11-02', true)), 'x_20261102 a@b.c');
a.equal(C.dayMeetings(cal, '2026-11-02', SELF).list[0].link, 'https://calendar.google.com/calendar/r/day/2026/11/2'); // no calendar email -> day view
console.log('calendar tests: all passed');

// split series UID: _R suffix is dropped from instance ids, kept for the plain series link
{
  const dec = (l) => Buffer.from(new URL(l).searchParams.get('eid').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
  a.equal(dec(C.eventLink('abc_R20260917T100000@google.com', Date.UTC(2026, 9, 29, 10), 'dm@x.gr', '2026-10-29', false)), 'abc_20261029T100000Z dm@x.gr');
  a.equal(dec(C.eventLink('abc_R20260917T100000@google.com', null, 'dm@x.gr', '2026-10-29', false)), 'abc_R20260917T100000 dm@x.gr');
  console.log('calendar split-series link tests: all passed');
}
// two feeds combined: overlaps across feeds merged, tentative still excluded, all-day kept
{
  const x = { min: 60, n: 1, nt: 0, list: [{ s: '2026-11-02T08:00:00.000Z', e: '2026-11-02T09:00:00.000Z', title: 'A', link: 'l' }], allday: [{ title: 'Off', link: 'l' }] };
  const y = { min: 60, n: 1, nt: 1, list: [{ s: '2026-11-02T08:30:00.000Z', e: '2026-11-02T09:30:00.000Z', title: 'B', link: 'l' }, { s: '2026-11-02T12:00:00.000Z', e: '2026-11-02T13:00:00.000Z', title: 'T', link: 'l', tent: true }], allday: [] };
  const z = C.combineDays([x, y]);
  a.equal(z.min, 90); a.equal(z.n, 2); a.equal(z.nt, 1); a.deepEqual(z.list.map((m) => m.title), ['A', 'B', 'T']); a.deepEqual(z.allday.map((m) => m.title), ['Off']);
  console.log('calendar combine tests: all passed');
}
