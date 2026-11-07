'use strict';
/* An absent player must not freeze the table, loses the seat after two button rounds, and returns with the same chips. */
const assert = require('assert'), os = require('os'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');

const PORT = 18088, BASE = `http://127.0.0.1:${PORT}`, DATA = path.join(os.tmpdir(), `club-absent-${process.pid}.json`);
const server = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, DATA_FILE: DATA, ADMIN_OPEN: '1', PAUSE_MS: '20', START_MS: '20', BOT_MIN_MS: '5' }, stdio: ['ignore', 'pipe', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Person {
  async post(body) {
    const res = await fetch(`${BASE}/api/do`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: this.cookie }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  }
  async login(name) {
    const res = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    this.cookie = res.headers.get('set-cookie').split(';')[0];
    this.me = await res.json();
    return this;
  }
  async must(op, fields) { const r = await this.post({ op, ...fields }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; }
  async watch(code, table, play) {
    this.view = null;
    this.stop = new AbortController();
    const res = await fetch(`${BASE}/api/stream?club=${code}&table=${table}`, { headers: { Cookie: this.cookie }, signal: this.stop.signal });
    (async () => {
      let buffer = '';
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const line = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (!line.startsWith('data: ')) continue;
          this.view = JSON.parse(line.slice(6));
          const l = this.view.table?.legal;
          if (play && l && !this.busy) {
            this.busy = true;
            this.post({ op: 'act', club: code, table, type: l.check ? 'check' : 'call' }).finally(() => { this.busy = false; });
          }
        }
      }
    })().catch(() => {});
    while (!this.view) await sleep(5);
  }
}
const until = async (test, label, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (test()) return; await sleep(20); }
  throw new Error(`no ocurriÃ³: ${label}`);
};

async function main() {
  await new Promise(r => server.stdout.once('data', r));
  const a = await new Person().login('Ana'), b = await new Person().login('Beto'), c = await new Person().login('Caro');
  const { code } = await a.must('createClub', { name: 'Prueba' });
  await b.must('joinClub', { code });
  await c.must('joinClub', { code });

  /* practice: alone, go absent by not acting */
  const { table: solo } = await a.must('createTable', { club: code, name: 'Solo', turn: 10, practice: true, bots: 2 });
  await a.must('sit', { club: code, table: solo, seat: 0 });
  await a.watch(code, solo, false);
  await until(() => a.view.table.seats[0]?.sittingOut, 'quedar ausente', 45000);
  const stack = a.view.table.seats[0].stack;
  await until(() => a.view.table.hand?.demo, 'los bots siguen sin ti', 5000);
  console.log('ok     ausente: los bots siguen jugando');
  await until(() => a.view.table.mySeat === -1, 'salir tras dos vueltas', 30000);
  assert.equal(a.view.table.reserved, stack, 'no se guardaron tus fichas');
  console.log(`ok     tras dos vueltas sales de la mesa con ${stack} fichas guardadas`);
  await a.must('sit', { club: code, table: solo, seat: 0 });
  await until(() => a.view.table.seats[0]?.id === a.me.id, 'volver', 3000);
  assert.equal(a.view.table.seats[0].stack + a.view.table.seats[0].bet, stack, 'no volviste con las mismas fichas');
  assert.equal(a.view.table.reserved, null);
  console.log('ok     al volver entras con las mismas fichas');
  await a.must('stand', { club: code, table: solo });
  a.stop.abort();

  /* real table: Caro goes absent, the others keep playing, and the chips stay accounted for */
  const { table } = await a.must('createTable', { club: code, name: 'Real', seats: 3, bb: 100, turn: 10 });
  for (const p of [a, b, c]) await a.must('grant', { club: code, memberId: p.me.id, amount: 5000 });   /* no gift chips */
  await a.must('sit', { club: code, table, seat: 0, buyIn: 5000 });
  await b.must('sit', { club: code, table, seat: 1, buyIn: 5000 });
  await c.must('sit', { club: code, table, seat: 2, buyIn: 5000 });
  await a.watch(code, table, true);
  await b.watch(code, table, true);
  await c.watch(code, table, false);
  await until(() => c.view.table.mySeat === -1, 'una persona sale tras dos vueltas', 90000);
  const saved = c.view.table.reserved;
  assert.ok(Number.isInteger(saved) && saved > 0, 'no se guardaron sus fichas');
  await c.must('sit', { club: code, table, seat: 2 });
  await until(() => c.view.table.seats[2]?.id === c.me.id, 'la persona vuelve', 3000);
  assert.equal(c.view.table.seats[2].stack + c.view.table.seats[2].bet, saved, 'no volviÃ³ con sus fichas');
  console.log(`ok     en mesa normal tambiÃ©n: vuelve con ${saved} fichas sin pagar otra entrada`);

  await c.must('stand', { club: code, table });
  await a.must('deleteTables', { club: code });
  await sleep(100);
  const total = a.view.club.members.reduce((sum, m) => sum + m.balance, 0);
  assert.equal(total, 15000, 'las fichas del club no cuadran');
  console.log('ok     las fichas del club cuadran al final');
}
main().then(() => { server.kill(); fs.rmSync(DATA, { force: true }); console.log('todo correcto'); process.exit(0); })
  .catch(err => { console.error('FALLO', err.message); server.kill(); process.exit(1); });
