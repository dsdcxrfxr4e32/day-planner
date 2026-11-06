const a = require('assert'); const L = require('../lib');
a.equal(L.minutesFromNotes('D10M\n—'), 10); a.equal(L.minutesFromNotes('D1H'), 60); a.equal(L.minutesFromNotes('D1H30M\nx'), 90);
a.equal(L.minutesFromNotes('D1.5H'), 90); a.equal(L.minutesFromNotes('Do this'), null); a.equal(L.minutesFromNotes(''), null); a.equal(L.minutesFromNotes('D 2H 15M'), 135);
a.equal(L.formatDCode(10), 'D10M'); a.equal(L.formatDCode(60), 'D1H'); a.equal(L.formatDCode(90), 'D1H30M'); a.equal(L.formatDCode(480), 'D8H');
a.equal(L.rewritePlainNotes('D10M\n—', 25), 'D25M\n—');
a.equal(L.rewritePlainNotes('D1H30M rest of line\nmore', 45), 'D45M rest of line\nmore');
a.equal(L.rewritePlainNotes('Call the client\nabout X', 20), 'D20M\nCall the client\nabout X');
a.equal(L.rewritePlainNotes('', 15), 'D15M');
a.equal(L.rewriteHtmlNotes('<body>D10M\n<strong>bold</strong></body>', 70), '<body>D1H10M\n<strong>bold</strong></body>');
a.equal(L.rewriteHtmlNotes('<body><strong>D10M</strong> note</body>', 15), '<body><strong>D15M</strong> note</body>');
a.equal(L.rewriteHtmlNotes('<body><ul><li>x</li></ul></body>', 15), '<body>D15M\n<ul><li>x</li></ul></body>');
a.equal(L.rewriteHtmlNotes('<body>Do <em>this</em></body>', 15), '<body>D15M\nDo <em>this</em></body>');
a.ok(L.isPlainHtml('D10M\n—', '<body>D10M\n—</body>')); a.ok(L.isPlainHtml('a & b', '<body>a &amp; b</body>'));
a.ok(!L.isPlainHtml('bold', '<body><strong>bold</strong></body>'));
a.equal(L.athensDate('2026-10-27T22:30:00Z'), '2026-10-28'); a.equal(L.addDays('2026-10-28', -15), '2026-10-13');
console.log('lib tests: all passed');
// editor save: D-code rule + only-changed fields
a.equal(L.ensureDCode('D10M\nnotes'), 'D10M\nnotes'); a.equal(L.ensureDCode('D2H\n'), 'D2H\n'); a.equal(L.ensureDCode('D120M'), 'D120M');
a.equal(L.ensureDCode('Call client\nre X'), 'D10M\nCall client\nre X'); a.equal(L.ensureDCode(''), 'D10M'); a.equal(L.ensureDCode('   '), 'D10M');
a.equal(L.ensureDCode('Do this first'), 'D10M\nDo this first'); a.equal(L.ensureDCode('D10Mx'), 'D10M\nD10Mx'); a.equal(L.ensureDCode('D1H\r\nx'), 'D1H\nx');
a.equal(L.ensureDCode('\nD10M'), 'D10M\n\nD10M');
a.equal(L.ensureDCode('D120M\nx'), 'D120M\nx'); a.equal(L.ensureDCode('D1H\nx'), 'D1H\nx'); a.equal(L.ensureDCode('D 2H 15M y'), 'D 2H 15M y'); a.equal(L.ensureDCode('d30m'), 'd30m');
a.equal(L.DEFAULT_MIN, 10); a.equal(L.minutesFromNotes(L.ensureDCode('plain')), 10);
const cur = { name: '054a Review', notes: 'D10M\nbody', due_on: '2026-10-30' };
a.deepEqual(L.buildTaskUpdate(cur, { name: '054a Review', notes: 'D10M\nbody', due_on: '2026-10-30' }), {});
a.deepEqual(L.buildTaskUpdate(cur, { name: ' 054a Review v2 ' }), { name: '054a Review v2' });
a.deepEqual(L.buildTaskUpdate(cur, { notes: 'body only' }), { notes: 'D10M\nbody only' });
a.deepEqual(L.buildTaskUpdate(cur, { notes: 'D45M\nbody' }), { notes: 'D45M\nbody' });
a.deepEqual(L.buildTaskUpdate(cur, { due_on: '' }), { due_on: null });
a.deepEqual(L.buildTaskUpdate({ name: 'x', notes: '', due_on: null }, { due_on: '' }), {});
a.deepEqual(L.buildTaskUpdate({ name: 'x', notes: 'D30M\nplain', due_on: null }, { name: 'y' }), { name: 'y' }); // has a code: notes untouched
a.deepEqual(L.buildTaskUpdate({ name: 'x', notes: 'plain', html_notes: '<body>plain</body>', due_on: null }, { name: 'y' }), { name: 'y', notes: 'D10M\nplain' }); // name save adds D10M
a.deepEqual(L.buildTaskUpdate({ name: 'x', notes: '', html_notes: '<body></body>', due_on: null }, { name: 'y' }), { name: 'y', notes: 'D10M' });
a.deepEqual(L.buildTaskUpdate({ name: 'x', notes: 'bold', html_notes: '<body><strong>bold</strong></body>', due_on: null }, { name: 'y' }), { name: 'y', html_notes: '<body>D10M\n<strong>bold</strong></body>' }); // rich: keep formatting
a.deepEqual(L.buildTaskUpdate({ name: 'x', notes: 'plain', due_on: null }, { name: 'x' }), {}); // nothing changed: nothing written
a.deepEqual(L.buildTaskUpdate({ name: 'x', notes: 'plain', due_on: null }, { due_on: '2026-11-02' }), { due_on: '2026-11-02' }); // date-only: no code added
a.deepEqual(L.buildTaskUpdate(cur, { due_on: '2026-11-02' }), { due_on: '2026-11-02' });
a.throws(() => L.buildTaskUpdate(cur, { name: '  ' })); a.throws(() => L.buildTaskUpdate(cur, { due_on: '2/11/2026' }));
a.equal(L.MIN_MIN, 10); a.equal(L.clampMinutes(5), 10); a.equal(L.clampMinutes(0), 10); a.equal(L.clampMinutes('x'), 10); a.equal(L.clampMinutes(20), 20); a.equal(L.clampMinutes(999, 480), 480);
console.log('editor save tests: all passed');
// new task ('+' on a section)
a.deepEqual(L.buildNewTask({ name: ' 054a Check drawings \n', notes: 'D10M\n' }), { name: '054a Check drawings', notes: 'D10M\n' });
a.deepEqual(L.buildNewTask({ name: 'PRE x', notes: 'call back' }), { name: 'PRE x', notes: 'D10M\ncall back' });
a.deepEqual(L.buildNewTask({ name: 'PRE x', notes: '', due_on: '2026-11-02' }), { name: 'PRE x', notes: 'D10M', due_on: '2026-11-02' });
for (const n of ['', '   ', '054a', '054a ', ' PRE ', '054', 'pre']) a.throws(() => L.buildNewTask({ name: n }), /name/);
a.throws(() => L.buildNewTask({ name: 'PRE x', due_on: '02/11/2026' }), /due date/);
console.log('new task tests: all passed');
// placement: Asana due date wins over leftover TODAY-/TOMORROW- tags.
// Tomorrow = next calendar day. Monday = the next Monday strictly after today.
// A tag with no due date does not place the task.
const T0 = '2026-10-28'; // Wednesday
const none = { t: '', w: '', mo: '', src: '' };
a.deepEqual(L.placeByDate({ t: '', w: '', lane: 'dm', due: '2026-10-28', today: T0 }), { t: 'dm', w: '', mo: '', src: 'd' });
a.deepEqual(L.placeByDate({ t: '', w: '', lane: 'dm', due: '2026-10-29', today: T0 }), { t: '', w: 'dm', mo: '', src: 'd' });
a.deepEqual(L.placeByDate({ t: '', w: '', lane: 'dm', due: '2026-10-27', today: T0 }), none); // overdue
a.deepEqual(L.placeByDate({ t: '', w: '', lane: 'dm', due: '', today: T0 }), none);
a.deepEqual(L.placeByDate({ t: 'dm', w: '', lane: 'dm', due: T0, today: T0 }), { t: 'dm', w: '', mo: '', src: 'd' });
a.deepEqual(L.placeByDate({ t: 'dm', w: '', lane: 'dm', due: '2026-10-29', today: T0 }), { t: '', w: 'dm', mo: '', src: 'd' }); // TODAY tag ignored; due tomorrow
a.deepEqual(L.placeByDate({ t: 'dm', w: '', lane: 'dm', due: '2026-11-02', today: T0 }), { t: '', w: '', mo: 'dm', src: 'd' }); // 2 Nov 2026 is the next Monday
a.deepEqual(L.placeByDate({ t: 'dm', w: 'dm', lane: 'dm', due: '2026-11-03', today: T0 }), none); // Tuesday, neither tomorrow nor Monday
a.deepEqual(L.placeByDate({ t: 'dm', w: '', lane: 'dm', due: '2026-10-20', today: T0 }), none); // overdue TODAY tag stays in Backlog
a.deepEqual(L.placeByDate({ t: '', w: 'dm', lane: 'dm', due: '2026-10-28', today: T0 }), { t: 'dm', w: '', mo: '', src: 'd' }); // due today beats leftover TOMORROW tag
a.deepEqual(L.placeByDate({ t: '', w: 'dm', lane: 'dm', due: '2026-10-20', today: T0 }), none); // overdue beats a TOMORROW tag
a.deepEqual(L.placeByDate({ t: '', w: '', lane: 'un', due: '2026-10-28', today: T0 }), { t: 'un', w: '', mo: '', src: 'd' });
a.deepEqual(L.placeByDate({ t: 'dm', w: '', lane: 'dm', due: '', today: T0 }), none); // no due date: tag does not plan Today
a.deepEqual(L.placeByDate({ t: '', w: 'dm', lane: 'dm', due: '', today: T0 }), none); // no due date: tag does not plan Tomorrow
a.deepEqual(L.placeByDate({ t: 'dm', w: 'dm', lane: 'dm', due: '', today: T0 }), none);
a.equal(L.dueDay({ due_on: '2026-10-28', due_at: '2026-10-28T22:30:00.000Z' }), '2026-10-29'); // 00:30 Athens next day
a.equal(L.dueDay({ due_on: '2026-10-29', due_at: null }), '2026-10-29'); a.equal(L.dueDay({}), '');
// Friday 6 Nov 2026: Tomorrow is Saturday 7 Nov, Monday is 9 Nov. Not the old Friday→Monday shortcut.
const FRI = '2026-11-06';
a.equal(new Date(FRI + 'T12:00:00Z').getUTCDay(), 5);
a.equal(L.addDays(FRI, 1), '2026-11-07');
a.equal(L.nextMonday(FRI), '2026-11-09');
a.equal(L.nextWorkday(FRI), '2026-11-09'); // old workday shortcut; Tomorrow must not use it
a.deepEqual(L.boardDates(FRI), { today: FRI, tomorrow: '2026-11-07', monday: '2026-11-09' });
a.equal(L.slotDue('t', FRI), FRI);
a.equal(L.slotDue('w', FRI), '2026-11-07');
a.equal(L.slotDue('mo', FRI), '2026-11-09');
a.equal(L.slotDue('nope', FRI), null);
a.deepEqual(L.placeByDate({ t: '', w: 'dd', lane: 'dd', due: FRI, today: FRI }), { t: 'dd', w: '', mo: '', src: 'd' });
a.deepEqual(L.placeByDate({ lane: 'dd', due: '2026-11-07', today: FRI }), { t: '', w: 'dd', mo: '', src: 'd' });
a.deepEqual(L.placeByDate({ t: 'dd', w: 'dd', lane: 'dd', due: '2026-11-09', today: FRI }), { t: '', w: '', mo: 'dd', src: 'd' });
a.deepEqual(L.placeByDate({ lane: 'dd', due: '2026-11-08', today: FRI }), none); // Sunday is backlog
// Today is Monday: the Monday column is one week later, Today keeps this Monday.
const MON = '2026-11-09';
a.equal(L.nextMonday(MON), '2026-11-16');
a.equal(L.slotDue('w', MON), '2026-11-10');
a.deepEqual(L.placeByDate({ lane: 'dd', due: MON, today: MON }), { t: 'dd', w: '', mo: '', src: 'd' });
a.deepEqual(L.placeByDate({ lane: 'dd', due: '2026-11-16', today: MON }), { t: '', w: '', mo: 'dd', src: 'd' });
// Sunday: tomorrow and the next Monday are the same date, so the card sits in Tomorrow only.
const SUN = '2026-11-08';
a.equal(L.addDays(SUN, 1), L.nextMonday(SUN));
a.deepEqual(L.placeByDate({ lane: 'dd', due: '2026-11-09', today: SUN }), { t: '', w: 'dd', mo: '', src: 'd' });
console.log('placement tests: all passed');
