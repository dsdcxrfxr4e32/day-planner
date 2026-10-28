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
a.equal(L.ensureDCode('Call client\nre X'), 'D15M\nCall client\nre X'); a.equal(L.ensureDCode(''), 'D15M'); a.equal(L.ensureDCode('   '), 'D15M');
a.equal(L.ensureDCode('Do this first'), 'D15M\nDo this first'); a.equal(L.ensureDCode('D10Mx'), 'D15M\nD10Mx'); a.equal(L.ensureDCode('D1H\r\nx'), 'D1H\nx');
a.equal(L.ensureDCode('\nD10M'), 'D15M\n\nD10M');
a.equal(L.ensureDCode('D120M\nx'), 'D120M\nx'); a.equal(L.ensureDCode('D1H\nx'), 'D1H\nx'); a.equal(L.ensureDCode('D 2H 15M y'), 'D 2H 15M y'); a.equal(L.ensureDCode('d30m'), 'd30m');
a.equal(L.DEFAULT_MIN, 15); a.equal(L.minutesFromNotes(L.ensureDCode('plain')), 15);
const cur = { name: '054a Review', notes: 'D10M\nbody', due_on: '2026-10-30' };
a.deepEqual(L.buildTaskUpdate(cur, { name: '054a Review', notes: 'D10M\nbody', due_on: '2026-10-30' }), {});
a.deepEqual(L.buildTaskUpdate(cur, { name: ' 054a Review v2 ' }), { name: '054a Review v2' });
a.deepEqual(L.buildTaskUpdate(cur, { notes: 'body only' }), { notes: 'D15M\nbody only' });
a.deepEqual(L.buildTaskUpdate(cur, { notes: 'D45M\nbody' }), { notes: 'D45M\nbody' });
a.deepEqual(L.buildTaskUpdate(cur, { due_on: '' }), { due_on: null });
a.deepEqual(L.buildTaskUpdate({ name: 'x', notes: '', due_on: null }, { due_on: '' }), {});
a.deepEqual(L.buildTaskUpdate({ name: 'x', notes: 'D30M\nplain', due_on: null }, { name: 'y' }), { name: 'y' }); // has a code: notes untouched
a.deepEqual(L.buildTaskUpdate({ name: 'x', notes: 'plain', html_notes: '<body>plain</body>', due_on: null }, { name: 'y' }), { name: 'y', notes: 'D15M\nplain' }); // name save adds D15M
a.deepEqual(L.buildTaskUpdate({ name: 'x', notes: '', html_notes: '<body></body>', due_on: null }, { name: 'y' }), { name: 'y', notes: 'D15M' });
a.deepEqual(L.buildTaskUpdate({ name: 'x', notes: 'bold', html_notes: '<body><strong>bold</strong></body>', due_on: null }, { name: 'y' }), { name: 'y', html_notes: '<body>D15M\n<strong>bold</strong></body>' }); // rich: keep formatting
a.deepEqual(L.buildTaskUpdate({ name: 'x', notes: 'plain', due_on: null }, { name: 'x' }), {}); // nothing changed: nothing written
a.deepEqual(L.buildTaskUpdate({ name: 'x', notes: 'plain', due_on: null }, { due_on: '2026-11-02' }), { due_on: '2026-11-02' }); // date-only: no code added
a.deepEqual(L.buildTaskUpdate(cur, { due_on: '2026-11-02' }), { due_on: '2026-11-02' });
a.throws(() => L.buildTaskUpdate(cur, { name: '  ' })); a.throws(() => L.buildTaskUpdate(cur, { due_on: '2/11/2026' }));
console.log('editor save tests: all passed');
// new task ('+' on a section)
a.deepEqual(L.buildNewTask({ name: ' 054a Check drawings \n', notes: 'D10M\n' }), { name: '054a Check drawings', notes: 'D10M\n' });
a.deepEqual(L.buildNewTask({ name: '054a Check', notes: 'D15M\n' }), { name: '054a Check', notes: 'D15M\n' }); // '+' prefill
a.deepEqual(L.buildNewTask({ name: 'PRE x', notes: 'call back' }), { name: 'PRE x', notes: 'D15M\ncall back' });
a.deepEqual(L.buildNewTask({ name: 'PRE x', notes: '', due_on: '2026-11-02' }), { name: 'PRE x', notes: 'D15M', due_on: '2026-11-02' });
for (const n of ['', '   ', '054a', '054a ', ' PRE ', '054', 'pre']) a.throws(() => L.buildNewTask({ name: n }), /name/);
a.throws(() => L.buildNewTask({ name: 'PRE x', due_on: '02/11/2026' }), /due date/);
console.log('new task tests: all passed');
// placement: tags win, else due date (today/tomorrow), overdue stays in Backlog
const T0 = '2026-10-28';
a.deepEqual(L.placeByDate({ t: '', w: '', lane: 'dm', due: '2026-10-28', today: T0 }), { t: 'dm', w: '', src: 'd' });
a.deepEqual(L.placeByDate({ t: '', w: '', lane: 'dm', due: '2026-10-29', today: T0 }), { t: '', w: 'dm', src: 'd' });
a.deepEqual(L.placeByDate({ t: '', w: '', lane: 'dm', due: '2026-10-27', today: T0 }), { t: '', w: '', src: '' });
a.deepEqual(L.placeByDate({ t: '', w: '', lane: 'dm', due: '', today: T0 }), { t: '', w: '', src: '' });
a.deepEqual(L.placeByDate({ t: 'dm', w: '', lane: 'dm', due: '2026-10-29', today: T0 }), { t: 'dm', w: '', src: '' }); // TODAY tag beats tomorrow's date
a.deepEqual(L.placeByDate({ t: '', w: 'dm', lane: 'dm', due: '2026-10-28', today: T0 }), { t: '', w: 'dm', src: '' });
a.deepEqual(L.placeByDate({ t: '', w: '', lane: 'un', due: '2026-10-28', today: T0 }), { t: 'un', w: '', src: 'd' });
a.equal(L.dueDay({ due_on: '2026-10-28', due_at: '2026-10-28T22:30:00.000Z' }), '2026-10-29'); // 00:30 Athens next day
a.equal(L.dueDay({ due_on: '2026-10-29', due_at: null }), '2026-10-29'); a.equal(L.dueDay({}), '');
console.log('placement tests: all passed');
