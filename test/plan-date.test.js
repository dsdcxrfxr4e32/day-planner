// Column moves write an Asana due date and never create, add, or remove a tag.
// Fetch is mocked; nothing here talks to Asana.
process.env.TODAY_STORE = 'asana_tags';
process.env.ASANA_PAT = 'test-pat';
process.env.ACCESS_KEY = 'test-key';
delete process.env.READ_ONLY;
delete process.env.RENDER;

const a = require('assert');
const L = require('../lib');

const calls = [];
function res(obj, status) {
  status = status || 200;
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(obj) };
}
global.fetch = async (url, opts) => {
  const method = (opts && opts.method) || 'GET';
  const path = String(url).replace('https://app.asana.com/api/1.0', '');
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  calls.push({ method, path, body });
  if (method === 'POST' && /\/tags$/.test(path)) throw new Error('created a tag ' + JSON.stringify(body));
  if (method === 'POST' && path.includes('addTag')) throw new Error('addTag ' + path + ' ' + JSON.stringify(body));
  if (method === 'POST' && path.includes('removeTag')) throw new Error('removeTag ' + path + ' ' + JSON.stringify(body));
  if (method === 'DELETE') throw new Error('delete ' + path);
  if (method === 'GET' && path.includes('/projects')) {
    return res({ data: [{ gid: '3333333333333', name: '919 Client', archived: false }] });
  }
  if (method === 'GET' && path.includes('/tasks/')) {
    return res({ data: {
      gid: '2222222222222', name: '054a Review', notes: 'D10M\nbody', html_notes: '<body>D10M\nbody</body>',
      due_on: '2026-10-01', tags: [{ gid: '9001', name: 'TODAY-Dimitra' }, { gid: '9003', name: '919a' }],
    } });
  }
  if (method === 'PUT') {
    const data = (body && body.data) || {};
    return res({ data: {
      gid: '2222222222222', name: data.name || '054a Review', notes: 'D10M\nbody', html_notes: '<body>D10M\nbody</body>',
      due_on: Object.prototype.hasOwnProperty.call(data, 'due_on') ? data.due_on : '2026-10-01',
      due_at: data.due_at || null,
      assignee: data.assignee ? { name: 'Antonia', gid: data.assignee } : { name: 'Dimitra', gid: '1213448798749941' },
    } });
  }
  if (method === 'POST' && path.startsWith('/tasks')) {
    const data = (body && body.data) || {};
    return res({ data: { gid: '4444444444444', name: data.name || '', notes: data.notes || 'D10M', due_on: data.due_on || '', projects: [{ gid: '3333333333333', name: '919 Client' }] } });
  }
  return res({ data: {} });
};

const S = require('../server');
const today = L.athensDate(new Date());
const tomorrow = L.addDays(today, 1);
const monday = L.nextMonday(today);
const TASK = '2222222222222';

function puts() { return calls.filter((c) => c.method === 'PUT'); }
function tagCalls() {
  return calls.filter((c) => /\/tags|addTag|removeTag|tags\.name/i.test(c.path) || (c.body && /"tag"/.test(JSON.stringify(c.body))));
}

(async () => {
  calls.length = 0;
  const td = await S.movePlan({ i: TASK, from: null, to: { s: 't', k: 'dd' } });
  a.equal(td.d, today);
  a.equal(puts().length, 1);
  a.equal(puts()[0].body.data.due_on, today);
  a.equal(puts()[0].body.data.due_on, L.slotDue('t', today));
  a.deepEqual(tagCalls(), []);

  calls.length = 0;
  const w = await S.movePlan({ i: TASK, from: { s: 't', k: 'dd' }, to: { s: 'w', k: 'dd' } });
  a.equal(w.d, tomorrow);
  a.equal(puts().length, 1);
  a.equal(puts()[0].body.data.due_on, tomorrow);
  a.deepEqual(tagCalls(), []);
  if (new Date(today + 'T12:00:00Z').getUTCDay() === 5) a.notEqual(puts()[0].body.data.due_on, L.nextWorkday(today));

  calls.length = 0;
  const mo = await S.movePlan({ i: TASK, from: { s: 'w', k: 'dd' }, to: { s: 'mo', k: 'dd' } });
  a.equal(mo.d, monday);
  a.equal(puts().length, 1);
  a.equal(puts()[0].body.data.due_on, monday);
  a.equal(puts()[0].body.data.due_on, L.slotDue('mo', today));
  a.deepEqual(tagCalls(), []);

  calls.length = 0;
  const back = await S.movePlan({ i: TASK, from: { s: 't', k: 'dd' }, to: null });
  a.equal(back.d, '');
  a.equal(puts().length, 1);
  a.equal(puts()[0].body.data.due_on, null);
  a.equal(puts()[0].body.data.due_at, null);
  a.deepEqual(tagCalls(), []);

  calls.length = 0;
  const same = await S.movePlan({ i: TASK, from: { s: 't', k: 'dd' }, to: { s: 't', k: 'dd' } });
  a.equal(same.d, undefined);
  a.equal(puts().length, 0);
  a.deepEqual(calls, []);

  calls.length = 0;
  const asg = await S.assignTask({ i: TASK, a: 'ak', from: { s: 't', k: 'dd' } });
  a.equal(asg.a, 'ak');
  a.equal(puts().length, 1);
  a.equal(puts()[0].body.data.assignee, '1213448855148301');
  a.deepEqual(tagCalls(), []);

  calls.length = 0;
  const edited = await S.updateTask(TASK, { due_on: tomorrow });
  a.ok(edited.changed.includes('due_on'));
  a.equal(puts().length, 1);
  a.equal(puts()[0].body.data.due_on, tomorrow);
  a.equal(puts()[0].body.data.notes, undefined);
  a.equal(puts()[0].body.data.html_notes, undefined);
  a.deepEqual(tagCalls(), []);

  calls.length = 0;
  const greek = 'D1H\nΝα το δούμε πάλι αύριο με τον Δημήτρη.';
  const described = await S.updateTask(TASK, { notes: greek });
  a.deepEqual(described.changed, ['html_notes']);
  a.equal(puts().length, 1);
  a.equal(puts()[0].body.data.html_notes, '<body>' + greek + '</body>');
  a.equal(puts()[0].body.data.notes, undefined);
  a.deepEqual(tagCalls(), []);

  calls.length = 0;
  const cleared = await S.clearToday({ entries: [{ i: TASK, t: 'dd' }] });
  a.equal(cleared.cleared, 1);
  a.deepEqual(cleared.failed, []);
  a.equal(puts().length, 1);
  a.equal(puts()[0].body.data.due_on, null);
  a.deepEqual(tagCalls(), []);

  calls.length = 0;
  const marked = await S.setToday({ i: TASK, t: 'dd', prev: 'dm' });
  a.equal(marked.d, today);
  a.equal(puts().length, 1);
  a.equal(puts()[0].body.data.due_on, today);
  a.deepEqual(tagCalls(), []);

  calls.length = 0;
  const made = await S.createTask({ name: '919 Review', notes: 'D10M', project: '3333333333333', a: 'dd', slot: { s: 't', k: 'dd' } });
  a.equal(made.d, today);
  a.equal(made.t, 'dd');
  const created = calls.filter((c) => c.method === 'POST' && c.path.startsWith('/tasks'));
  a.equal(created.length, 1);
  a.equal(created[0].body.data.due_on, today);
  a.equal(created[0].body.data.html_notes, '<body>D10M</body>');
  a.equal(created[0].body.data.notes, undefined);
  a.deepEqual(tagCalls(), []);

  a.equal(L.slotDue('w', '2026-11-06'), '2026-11-07');
  a.equal(L.slotDue('mo', '2026-11-06'), '2026-11-09');
  console.log('plan date tests: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
