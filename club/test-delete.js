'use strict';
/* Deleting selected tables leaves the rest, refunds reserved chips, and still rejects non-owners. */
const assert = require('assert'), os = require('os'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const PORT = 18091, BASE = `http://127.0.0.1:${PORT}`, DATA = path.join(os.tmpdir(), `club-del-${process.pid}.json`);
const server = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, DATA_FILE: DATA, ADMIN_OPEN: '1', PAUSE_MS: '20', START_MS: '20', BOT_MIN_MS: '5' }, stdio: ['ignore', 'pipe', 'inherit'] });

class P {
  async login(name) { const r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); this.cookie = r.headers.get('set-cookie').split(';')[0]; this.me = await r.json(); return this; }
  async do(op, f = {}) { const r = await fetch(`${BASE}/api/do`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: this.cookie }, body: JSON.stringify({ op, ...f }) }); return { status: r.status, body: await r.json() }; }
  async must(op, f) { const r = await this.do(op, f); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; }
  async snap(code, table) { const s = new AbortController(); const r = await fetch(`${BASE}/api/stream?club=${code}&table=${table}`, { headers: { Cookie: this.cookie }, signal: s.signal }); let t = ''; for await (const c of r.body) { t += Buffer.from(c).toString(); if (t.includes('\n\n')) break; } s.abort(); return JSON.parse(t.slice(t.indexOf('data: ') + 6, t.indexOf('\n\n'))); }
}
async function main() {
  await new Promise(r => server.stdout.once('data', r));
  const a = await new P().login('DueÃ±o'), b = await new P().login('Amigo');
  const { code } = await a.must('createClub', { name: 'Del' });
  await b.must('joinClub', { code });
  const t1 = (await a.must('createTable', { club: code, name: 'Uno', turn: 30, practice: true, bots: 2 })).table;
  const t2 = (await a.must('createTable', { club: code, name: 'Dos', turn: 30, practice: true, bots: 2 })).table;
  const t3 = (await a.must('createTable', { club: code, name: 'Tres', seats: 2, bb: 100, turn: 30 })).table;

  assert.equal((await b.do('deleteTables', { club: code, ids: [t1] })).status, 400, 'un miembro borrÃ³ mesas');
  assert.equal((await a.do('deleteTables', { club: code, ids: ['no-existe'] })).status, 400, 'aceptÃ³ ids que no existen');
  console.log('ok     solo el dueÃ±o, y rechaza ids inexistentes');

  await a.must('deleteTables', { club: code, ids: [t1, t3] });
  const left = (await a.snap(code, '')).club.tables.map(t => t.id);
  assert.deepEqual(left, [t2], 'quedaron las mesas equivocadas');
  console.log('ok     borra solo las marcadas y deja el resto');

  /* a real table with reserved chips: deleting it refunds them */
  const t4 = (await a.must('createTable', { club: code, name: 'Real', seats: 2, bb: 100, turn: 30 })).table;
  await a.must('grant', { club: code, memberId: a.me.id, amount: 5000 });   /* no gift chips */
  await a.must('sit', { club: code, table: t4, seat: 0, buyIn: 5000 });
  const before = (await a.snap(code, '')).club.balance;
  await a.must('deleteTables', { club: code, ids: [t4] });
  const after = (await a.snap(code, '')).club.balance;
  assert.equal(after, before + 5000, 'no devolviÃ³ las fichas de la mesa borrada');
  console.log('ok     al borrar una mesa, sus fichas del club vuelven al saldo');

  await a.must('deleteTables', { club: code });     /* no ids: still deletes all, for older callers */
  assert.equal((await a.snap(code, '')).club.tables.length, 0, 'sin ids no borrÃ³ todo');
  console.log('ok     sin ids sigue borrando todas');
}
main().then(() => { server.kill(); fs.rmSync(DATA, { force: true }); console.log('todo correcto'); process.exit(0); })
  .catch(e => { console.error('FALLO', e.message); server.kill(); process.exit(1); });
