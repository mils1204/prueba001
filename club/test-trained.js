'use strict';
/* Trained-bot table: both top up to 100 BB each hand, the bot from a daily reserve, and it never touches club chips. */
const assert = require('assert'), os = require('os'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const PORT = 18093, BASE = `http://127.0.0.1:${PORT}`, DATA = path.join(os.tmpdir(), `club-tr-${process.pid}.json`);
const server = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, DATA_FILE: DATA, ADMIN_OPEN: '1', PAUSE_MS: '15', START_MS: '15', BOT_MIN_MS: '5' }, stdio: ['ignore', 'pipe', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));

class P {
  async login(name) { const r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); this.cookie = r.headers.get('set-cookie').split(';')[0]; this.me = await r.json(); return this; }
  async do(op, f = {}) { const r = await fetch(`${BASE}/api/do`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: this.cookie }, body: JSON.stringify({ op, ...f }) }); return { status: r.status, body: await r.json() }; }
  async must(op, f) { const r = await this.do(op, f); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; }
  watch(code, table, play) {
    this.stop = new AbortController();
    this.frames = [];
    return fetch(`${BASE}/api/stream?club=${code}&table=${table}`, { headers: { Cookie: this.cookie }, signal: this.stop.signal }).then(async r => {
      (async () => { let buf = ''; const d = new TextDecoder(); for await (const c of r.body) { buf += d.decode(c, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); if (!line.startsWith('data: ')) continue; this.view = JSON.parse(line.slice(6)); if (this.view.table) this.frames.push(this.view.table); const l = this.view.table?.legal; if (play && l && !this.busy) { this.busy = true; this.do('act', { club: code, table, type: l.check ? 'check' : 'call' }).finally(() => { this.busy = false; }); } } } })().catch(() => {});
      while (!this.view) await sleep(5);
    });
  }
}
async function main() {
  await new Promise(r => server.stdout.once('data', r));
  const a = await new P().login('DueÃ±o');
  const { code } = await a.must('createClub', { name: 'Tr' });
  const { table } = await a.must('createTable', { club: code, name: 'Entrenado', turn: 10, practice: true, trained: true, bots: 1, bb: 100 });
  await a.must('sit', { club: code, table, seat: 0 });
  await a.watch(code, table, true);
  const FULL = 10000;

  const deadline = Date.now() + 90000;
  while ((a.view.table.history[0]?.no ?? 0) < 20) { assert.ok(Date.now() < deadline, 'se atascÃ³'); await sleep(30); }

  assert.equal(a.view.club.balance, 0, 'la mesa entrenada tocÃ³ el saldo del club');
  assert.ok(a.view.table.trained, 'no se marcÃ³ como mesa entrenada');
  assert.equal(a.view.table.alwaysFull, true, 'el jugador no empezÃ³ en Siempre al 100% ON');

  const starts = a.frames.filter(t => t.hand && !t.hand.done && t.hand.street === 'preflop' && t.seats.every(s => !s || s.stack + s.bet > 0));
  const human = t => t.seats.find(s => s && !s.bot), bot = t => t.seats.find(s => s && s.bot);
  assert.ok(starts.some(t => human(t).stack + human(t).bet === FULL), 'con ON el jugador no se recargÃ³ a 100 BB');
  assert.ok(starts.every(t => bot(t).stack + bot(t).bet <= FULL), 'el bot superÃ³ los 100 BB al empezar la mano');
  const reserves = a.frames.filter(t => t.botReserve != null).map(t => t.botReserve);
  assert.ok(reserves.every(r => r >= 0), 'reserva del bot negativa');
  console.log(`ok     entrenada: sin tocar el club, recarga a 100 BB, reserva del bot de ${(reserves.at(-1) / 100).toFixed(2)} BB`);

  /* the toggle flips and turns the human top-up off */
  await a.must('setAlwaysFull', { club: code, table, on: false });
  await sleep(200);
  assert.equal(a.view.table.alwaysFull, false, 'el toggle no se apagÃ³');
  await a.must('setAlwaysFull', { club: code, table, on: true });
  await sleep(50);
  assert.equal(a.view.table.alwaysFull, true, 'el toggle no se encendiÃ³');
  console.log('ok     el botÃ³n Siempre al 100% se enciende y apaga');

  /* a non-trained practice table has no toggle and no reserve */
  const { table: rules } = await a.must('createTable', { club: code, name: 'Reglas', turn: 10, practice: true, bots: 2, bb: 100 });
  a.stop.abort(); a.view = null;
  await a.watch(code, rules, false);
  assert.equal(a.view.table.trained, false, 'una mesa con reglas se marcÃ³ como entrenada');
  assert.equal(a.view.table.botReserve, null, 'una mesa con reglas expuso reserva');
  console.log('ok     solo la mesa del bot entrenado tiene la recarga a 100');
}
main().then(() => { server.kill(); fs.rmSync(DATA, { force: true }); console.log('todo correcto'); process.exit(0); })
  .catch(e => { console.error('FALLO', e.message); server.kill(); process.exit(1); });
