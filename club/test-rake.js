'use strict';
/* Commission goes from the winners to the club pool; chips are conserved; only the owner sees the pool. */
const assert = require('assert'), os = require('os'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const PORT = 18092, BASE = `http://127.0.0.1:${PORT}`, DATA = path.join(os.tmpdir(), `club-rake-${process.pid}.json`);
const server = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, DATA_FILE: DATA, ADMIN_OPEN: '1', PAUSE_MS: '15', START_MS: '15', BOT_MIN_MS: '5' }, stdio: ['ignore', 'pipe', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));

class P {
  async login(name) { const r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); this.cookie = r.headers.get('set-cookie').split(';')[0]; this.me = await r.json(); return this; }
  async do(op, f = {}) { const r = await fetch(`${BASE}/api/do`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: this.cookie }, body: JSON.stringify({ op, ...f }) }); return { status: r.status, body: await r.json() }; }
  async must(op, f) { const r = await this.do(op, f); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; }
  async watch(code, table, play) {
    this.stop = new AbortController();
    const r = await fetch(`${BASE}/api/stream?club=${code}&table=${table}`, { headers: { Cookie: this.cookie }, signal: this.stop.signal });
    (async () => { let buf = ''; const d = new TextDecoder(); for await (const c of r.body) { buf += d.decode(c, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); if (!line.startsWith('data: ')) continue; this.view = JSON.parse(line.slice(6)); const l = this.view.table?.legal; if (play && l && !this.busy) { this.busy = true; this.do('act', { club: code, table, type: l.check ? 'check' : 'call' }).finally(() => { this.busy = false; }); } } } })().catch(() => {});
    while (!this.view) await sleep(5);
  }
}
async function main() {
  await new Promise(r => server.stdout.once('data', r));
  const a = await new P().login('DueÃ±o'), b = await new P().login('Amigo');
  const { code } = await a.must('createClub', { name: 'Rake' });
  await b.must('joinClub', { code });
  for (const p of [a, b]) await a.must('grant', { club: code, memberId: p.me.id, amount: 100000 });
  const START = 200000;

  assert.equal((await a.do('createTable', { club: code, name: 'X', seats: 2, bb: 100, turn: 10, rake: 9 })).status, 400, 'aceptÃ³ comisiÃ³n fuera de 0-5');
  const { table } = await a.must('createTable', { club: code, name: 'Mesa', seats: 2, bb: 100, turn: 10, rake: 5 });
  await a.must('sit', { club: code, table, seat: 0, buyIn: 20000 });
  await b.must('sit', { club: code, table, seat: 1, buyIn: 20000 });
  await a.watch(code, table, true);
  await b.watch(code, table, true);

  const deadline = Date.now() + 120000;
  while ((a.view.table.history[0]?.no ?? 0) < 25) { assert.ok(Date.now() < deadline, 'se atascÃ³'); await sleep(30); }
  assert.ok(a.view.club.pot > 0, 'la comisiÃ³n no alimentÃ³ el pozo');
  assert.ok(a.view.table.history.some(h => h.rake > 0), 'ninguna mano registrÃ³ comisiÃ³n');
  console.log(`ok     el pozo creciÃ³ a ${(a.view.club.pot / 100).toFixed(2)} con comisiÃ³n del 5%`);

  /* only the owner sees the pool */
  assert.equal(typeof a.view.club.pot, 'number', 'el dueÃ±o no ve el pozo');
  assert.equal(b.view.club.pot, null, 'un miembro ve el pozo');
  console.log('ok     solo quien creÃ³ el club ve el pozo');

  /* chips are conserved: deleting the table returns the seated chips, and the pool keeps the rake */
  a.stop.abort(); b.stop.abort();
  await sleep(200);
  await a.must('deleteTables', { club: code });
  await sleep(200);
  a.view = null;
  await a.watch(code, '');
  const snap = a.view.club;
  const total = snap.members.reduce((s, m) => s + m.balance, 0) + snap.pot;
  assert.equal(total, START, `las fichas no cuadran: ${total} vs ${START}`);
  console.log(`ok     fichas conservadas: saldos ${(snap.members.reduce((s, m) => s + m.balance, 0) / 100).toFixed(2)} + pozo ${(snap.pot / 100).toFixed(2)} = ${(START / 100).toFixed(2)}`);
}
main().then(() => { server.kill(); fs.rmSync(DATA, { force: true }); console.log('todo correcto'); process.exit(0); })
  .catch(e => { console.error('FALLO', e.message); server.kill(); process.exit(1); });
