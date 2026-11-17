'use strict';
// Build the Asana calls that copy a task exactly. Asana's duplicate endpoint
// does not copy comments or guarantee the original section, so those are separate steps.
const DUPLICATE_INCLUDE = ['notes', 'assignee', 'dates', 'projects', 'tags', 'followers', 'parent', 'subtasks', 'attachments', 'dependencies'];

const SOURCE_FIELDS = [
  'name', 'notes', 'html_notes', 'assignee', 'assignee.gid', 'due_on', 'due_at', 'completed',
  'custom_fields', 'custom_fields.gid', 'custom_fields.resource_subtype', 'custom_fields.type',
  'custom_fields.text_value', 'custom_fields.number_value',
  'custom_fields.enum_value', 'custom_fields.enum_value.gid',
  'custom_fields.multi_enum_values', 'custom_fields.multi_enum_values.gid',
  'custom_fields.date_value', 'custom_fields.date_value.date', 'custom_fields.date_value.date_time',
  'custom_fields.people_value', 'custom_fields.people_value.gid',
  'memberships', 'memberships.project', 'memberships.project.gid',
  'memberships.section', 'memberships.section.gid',
].join(',');

function fieldType(field) {
  return field.type || field.resource_subtype || '';
}

// Value Asana accepts in PUT custom_fields. undefined means skip (unknown type).
function customFieldValue(field) {
  if (!field || !field.gid) return undefined;
  switch (fieldType(field)) {
    case 'text':
      return field.text_value == null ? null : field.text_value;
    case 'number':
      return field.number_value == null ? null : field.number_value;
    case 'enum':
      return field.enum_value && field.enum_value.gid ? field.enum_value.gid : null;
    case 'multi_enum':
      return (field.multi_enum_values || []).map((v) => v.gid);
    case 'date':
      if (!field.date_value) return null;
      if (field.date_value.date_time) return { date_time: field.date_value.date_time };
      return field.date_value.date ? { date: field.date_value.date } : null;
    case 'people':
      return (field.people_value || []).map((v) => v.gid);
    default:
      return undefined;
  }
}

function customFieldsBody(fields) {
  const out = {};
  for (const field of fields || []) {
    const value = customFieldValue(field);
    if (value !== undefined) out[field.gid] = value;
  }
  return out;
}

function sectionGids(memberships) {
  const out = [];
  for (const m of memberships || []) {
    const gid = m && m.section && m.section.gid;
    if (gid && !out.includes(gid)) out.push(gid);
  }
  return out;
}

function commentStories(stories) {
  return (stories || [])
    .filter((s) => s && s.resource_subtype === 'comment_added')
    .slice()
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

function commentBody(story) {
  if (story.html_text) return { html_text: story.html_text };
  if (story.text) return { text: story.text };
  return null;
}

function newTaskGid(job) {
  if (!job) return '';
  if (job.new_task && job.new_task.gid) return job.new_task.gid;
  if (job.resource_type === 'task' && job.gid) return job.gid;
  return '';
}

async function listStories(asana, gid) {
  let offset = null, out = [];
  for (let i = 0; i < 30; i++) {
    const q = 'opt_fields=resource_subtype,text,html_text,created_at,type&limit=100' + (offset ? '&offset=' + encodeURIComponent(offset) : '');
    const d = await asana('GET', '/tasks/' + gid + '/stories?' + q);
    out = out.concat(d.data || []);
    if (!d.next_page || !d.next_page.offset) break;
    offset = d.next_page.offset;
  }
  return out;
}

async function waitForDuplicate(asana, job, sleep) {
  if (job && job.resource_type === 'task') return job;
  let cur = job;
  for (let i = 0; i < 20; i++) {
    if (cur && cur.status === 'succeeded') return cur;
    if (cur && cur.status === 'failed') throw Object.assign(new Error('Asana could not duplicate the task'), { status: 502 });
    if (!job || !job.gid) break;
    await sleep(400);
    cur = (await asana('GET', '/jobs/' + job.gid)).data;
  }
  throw Object.assign(new Error('Asana is still duplicating; refresh in a moment'), { status: 504 });
}

// Copy one task. `asana(method, path, body)` is the app's Asana client.
async function runDuplicate(asana, gid, sleep) {
  if (!/^\d{5,25}$/.test(String(gid || ''))) throw Object.assign(new Error('bad task id'), { status: 400 });
  const src = (await asana('GET', '/tasks/' + gid + '?opt_fields=' + SOURCE_FIELDS)).data || {};
  const name = src.name || '';
  const started = (await asana('POST', '/tasks/' + gid + '/duplicate', { data: { name, include: DUPLICATE_INCLUDE.slice() } })).data;
  const done = await waitForDuplicate(asana, started, sleep);
  const created = newTaskGid(done) || newTaskGid(started);
  if (!created) throw Object.assign(new Error('Asana did not return the duplicated task'), { status: 502 });
  const createdName = (done.new_task && done.new_task.name) || (done.resource_type === 'task' ? done.name : '') || '';
  if (createdName !== name) await asana('PUT', '/tasks/' + created, { data: { name } });
  const fields = customFieldsBody(src.custom_fields);
  if (Object.keys(fields).length) await asana('PUT', '/tasks/' + created, { data: { custom_fields: fields } });
  for (const section of sectionGids(src.memberships)) {
    await asana('POST', '/sections/' + section + '/addTask', { data: { task: created } });
  }
  for (const story of commentStories(await listStories(asana, gid))) {
    const body = commentBody(story);
    if (body) await asana('POST', '/tasks/' + created + '/stories', { data: body });
  }
  return { i: created, gid: created };
}

module.exports = {
  DUPLICATE_INCLUDE, customFieldValue, customFieldsBody, sectionGids, commentStories, commentBody, newTaskGid, runDuplicate,
};
