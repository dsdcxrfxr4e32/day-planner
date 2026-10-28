// File-store Today/Tomorrow moves (no Asana calls). Uses a temp copy of the data dir via env-free path swap.
process.env.TODAY_STORE = 'file'; process.env.READ_ONLY = '1';
const a = require('assert'), fs = require('fs'), path = require('path');
const D = path.join(__dirname, '..', 'data'), T = path.join(D, 'today.json'), W = path.join(D, 'tomorrow.json');
const had = [T, W].map((f) => (fs.existsSync(f) ? fs.readFileSync(f) : null));
const S = require('../server');
const rd = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
(async () => {
  try {
    const i = '1111111111111';
    const RO = /refused PUT \/tasks\/1111111111111/;
    await a.rejects(S.movePlan({ i, from: null, to: { s: 't', k: 'dm' } }), RO); a.equal(rd(T)[i], 'dm'); a.equal(rd(W)[i], undefined);
    await a.rejects(S.movePlan({ i, from: { s: 't', k: 'dm' }, to: { s: 'w', k: 'dm' } }), RO); a.equal(rd(T)[i], undefined); a.equal(rd(W)[i], 'dm');
    // every real move also writes the due date in Asana in the same call (READ_ONLY refuses that PUT here, after the slot moved)
    await a.rejects(S.movePlan({ i, from: { s: 'w', k: 'dm' }, to: { s: 't', k: 'dm' } }), /refused PUT \/tasks\/1111111111111/); a.equal(rd(T)[i], 'dm');
    await S.movePlan({ i, from: { s: 't', k: 'dm' }, to: { s: 't', k: 'dm' } }); // same slot: no date write
    await a.rejects(S.movePlan({ i, from: { s: 't', k: 'dm' }, to: null }), /refused PUT \/tasks\/1111111111111/);
    a.equal(rd(T)[i], undefined); a.equal(rd(W)[i], undefined);
    // create: validation happens before any Asana call
    await a.rejects(S.createTask({ name: '054a ', project: '1', a: 'dm' }), /name/);
    await a.rejects(S.createTask({ name: 'PRE', project: '1', a: 'dm' }), /name/);
    await a.rejects(S.movePlan({ i, from: null, to: { s: 'x', k: 'dm' } })); await a.rejects(S.movePlan({ i, from: null, to: { s: 'w', k: 'zz' } }));
    console.log('plan file-store tests: all passed');
  } finally { [T, W].forEach((f, j) => (had[j] ? fs.writeFileSync(f, had[j]) : fs.rmSync(f, { force: true }))); }
})().catch((e) => { console.error(e); process.exit(1); });
