// Duplicate planning against a fake Asana client. No network and no real tasks.
const a = require('assert');
const D = require('../duplicate');

const src = {
  gid: '1111111111111',
  name: '919a D10M Check drawings',
  custom_fields: [
    { gid: 'f-text', type: 'text', text_value: 'note' },
    { gid: 'f-num', resource_subtype: 'number', number_value: 25 },
    { gid: 'f-enum', type: 'enum', enum_value: { gid: 'opt1', name: 'A' } },
    { gid: 'f-empty', type: 'enum', enum_value: null },
    { gid: 'f-multi', type: 'multi_enum', multi_enum_values: [{ gid: 'm1' }, { gid: 'm2' }] },
    { gid: 'f-date', type: 'date', date_value: { date: '2026-11-17', date_time: null } },
    { gid: 'f-people', type: 'people', people_value: [{ gid: 'u1' }] },
  ],
  memberships: [
    { project: { gid: 'p1' }, section: { gid: 's1' } },
    { project: { gid: 'p2' }, section: { gid: 's1' } },
    { project: { gid: 'p3' }, section: null },
  ],
};
const storiesPage1 = {
  data: [
    { resource_subtype: 'comment_added', text: 'second', html_text: '<body>second</body>', created_at: '2026-11-02T00:00:00.000Z' },
    { resource_subtype: 'assigned', text: 'ignored', created_at: '2026-11-01T00:00:00.000Z' },
  ],
  next_page: { offset: 'page2' },
};
const storiesPage2 = {
  data: [
    { resource_subtype: 'comment_added', text: 'first plain', created_at: '2026-11-01T00:00:00.000Z' },
    { resource_subtype: 'comment_added', text: '', html_text: '', created_at: '2026-11-03T00:00:00.000Z' },
  ],
  next_page: null,
};

a.deepEqual(D.customFieldsBody(src.custom_fields), {
  'f-text': 'note',
  'f-num': 25,
  'f-enum': 'opt1',
  'f-empty': null,
  'f-multi': ['m1', 'm2'],
  'f-date': { date: '2026-11-17' },
  'f-people': ['u1'],
});
a.deepEqual(D.sectionGids(src.memberships), ['s1']);
a.deepEqual(D.commentStories(storiesPage1.data.concat(storiesPage2.data)).map((s) => s.text), ['first plain', 'second', '']);
a.deepEqual(D.commentBody({ html_text: '<body>x</body>', text: 'x' }), { html_text: '<body>x</body>' });
a.deepEqual(D.commentBody({ text: 'plain' }), { text: 'plain' });
a.equal(D.commentBody({ text: '', html_text: '' }), null);
a.ok(D.DUPLICATE_INCLUDE.includes('notes') && D.DUPLICATE_INCLUDE.includes('parent') && D.DUPLICATE_INCLUDE.includes('attachments'));

(async () => {
  const calls = [];
  const asana = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path.startsWith('/tasks/1111111111111?')) return { data: src };
    if (method === 'POST' && path === '/tasks/1111111111111/duplicate') {
      return { data: { gid: 'job1', resource_subtype: 'duplicate_task', status: 'in_progress', new_task: { gid: '2222222222222', name: 'Duplicate of 919a D10M Check drawings' } } };
    }
    if (method === 'GET' && path === '/jobs/job1') {
      return { data: { gid: 'job1', status: 'succeeded', new_task: { gid: '2222222222222', name: 'Duplicate of 919a D10M Check drawings' } } };
    }
    if (method === 'GET' && path.includes('/stories')) {
      return path.includes('offset=page2') ? storiesPage2 : storiesPage1;
    }
    return { data: {} };
  };
  const out = await D.runDuplicate(asana, '1111111111111', async () => {});
  a.deepEqual(out, { i: '2222222222222', gid: '2222222222222' });
  const dup = calls.find((c) => c.path.endsWith('/duplicate'));
  a.equal(dup.body.data.name, src.name);
  a.deepEqual(dup.body.data.include, D.DUPLICATE_INCLUDE);
  const rename = calls.find((c) => c.method === 'PUT' && c.body && c.body.data && c.body.data.name);
  a.equal(rename.body.data.name, src.name);
  const fields = calls.find((c) => c.method === 'PUT' && c.body && c.body.data && c.body.data.custom_fields);
  a.equal(fields.body.data.custom_fields['f-num'], 25);
  const sections = calls.filter((c) => c.path === '/sections/s1/addTask');
  a.equal(sections.length, 1);
  a.equal(sections[0].body.data.task, '2222222222222');
  const comments = calls.filter((c) => c.path === '/tasks/2222222222222/stories');
  a.deepEqual(comments.map((c) => c.body.data), [{ text: 'first plain' }, { html_text: '<body>second</body>' }]);
  await a.rejects(D.runDuplicate(asana, 'nope', async () => {}), /bad task id/);
  console.log('duplicate tests: all passed');
})().catch((e) => { console.error(e); process.exit(1); });
