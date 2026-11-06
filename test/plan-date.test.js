// Asana-tag store: Tomorrow and Monday write a due date and never create a plan tag.
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
  if (method === 'DELETE') throw new Error('delete ' + path);
  if (method === 'GET' && path.includes('/tasks/')) {
    return res({ data: { gid: '2222222222222', tags: [
      { gid: '9001', name: 'TODAY-Dimitra' },
      { gid: '9002', name: 'TOMORROW-Dimitra' },
      { gid: '9003', name: '919a' },
      { gid: '9004', name: 'TOMORROW-Unassigned' },
    ] } });
  }
  if (method === 'PUT') return res({ data: { due_on: body.data.due_on || null, due_at: body.data.due_at || null } });
  if (method === 'POST' && path.includes('removeTag')) return res({ data: {} });
  return res({ data: {} });
};

const S = require('../server');
const today = L.athensDate(new Date());
const tomorrow = L.addDays(today, 1);
const monday = L.nextMonday(today);
const TASK = '2222222222222';

function removed() { return calls.filter((c) => c.path.includes('removeTag')).map((c) => c.body.data.tag); }
function puts() { return calls.filter((c) => c.method === 'PUT'); }

(async () => {
  calls.length = 0;
  const w = await S.movePlan({ i: TASK, from: { s: 't', k: 'dd' }, to: { s: 'w', k: 'dd' } });
  a.equal(w.d, tomorrow);
  a.equal(puts().length, 1);
  a.equal(puts()[0].body.data.due_on, tomorrow);
  a.deepEqual(removed().slice().sort(), ['9001', '9002', '9004']); // plan tags only; not the 919a tag
  a.ok(!calls.some((c) => c.method === 'POST' && (c.path.includes('addTag') || /\/tags$/.test(c.path))));
  // Friday's Tomorrow is Saturday, not the old next-workday Monday.
  if (new Date(today + 'T12:00:00Z').getUTCDay() === 5) a.notEqual(puts()[0].body.data.due_on, L.nextWorkday(today));

  calls.length = 0;
  const mo = await S.movePlan({ i: TASK, from: { s: 'w', k: 'dd' }, to: { s: 'mo', k: 'dd' } });
  a.equal(mo.d, monday);
  a.equal(puts().length, 1);
  a.equal(puts()[0].body.data.due_on, monday);
  a.equal(puts()[0].body.data.due_on, L.slotDue('mo', today));
  a.deepEqual(removed().slice().sort(), ['9001', '9002', '9004']);
  a.ok(!calls.some((c) => /TOMORROW-|MONDAY-/.test(JSON.stringify(c.body))));
  a.ok(!calls.some((c) => c.method === 'POST' && (c.path.includes('addTag') || /\/tags$/.test(c.path))));

  // Fixed Friday, independent of the machine clock: Tomorrow Saturday, Monday the 9th.
  a.equal(L.slotDue('w', '2026-11-06'), '2026-11-07');
  a.equal(L.slotDue('mo', '2026-11-06'), '2026-11-09');
  console.log('plan date tests: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
