'use strict';
/* The "see bots' cards" option must work at practice tables and never reveal a person's cards. */
const assert = require('assert'), os = require('os'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');

const PORT = 18085, BASE = `http://127.0.0.1:${PORT}`, DATA = path.join(os.tmpdir(), `club-see-${process.pid}.json`);
const server = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, DATA_FILE: DATA, ADMIN_OPEN: '1', PAUSE_MS: '100', START_MS: '20', BOT_MIN_MS: '3000' }, stdio: ['ignore', 'pipe', 'inherit'] });

class Person {
  async post(url, body) {
    const res = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) }, body: JSON.stringify(body) });
    const c = res.headers.get('set-cookie');
    if (c) this.cookie = c.split(';')[0];
    return { status: res.status, body: await res.json() };
  }
  async login(name) { this.me = (await this.post('/api/login', { name })).body; return this; }
  async must(op, fields) { const r = await this.post('/api/do', { op, ...fields }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; }
  async snapshot(code, table) {
    const stop = new AbortController();
    const res = await fetch(`${BASE}/api/stream?club=${code}&table=${table}`, { headers: { Cookie: this.cookie }, signal: stop.signal });
    let text = '';
    for await (const chunk of res.body) { text += Buffer.from(chunk).toString(); if (text.includes('\n\n')) break; }
    stop.abort();
    return JSON.parse(text.slice(text.indexOf('data: ') + 6, text.indexOf('\n\n')));
  }
  async whileBotsHoldCards(code, table) {
    for (let i = 0; i < 200; i++) {
      const v = await this.snapshot(code, table);
      if (v.table.hand && !v.table.hand.done && v.table.seats.some(s => s?.bot && s.cards.length)) return v;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error('no llegÃ³ una mano');
  }
}
const botCards = v => v.table.seats.filter(s => s?.bot && s.cards.length).map(s => s.cards);
const revealed = cards => cards.every(pair => pair.every(c => Number.isInteger(c)));
const hidden = cards => cards.every(pair => pair.every(c => c === null));

async function main() {
  await new Promise(r => server.stdout.once('data', r));
  const owner = await new Person().login('DueÃ±o'), friend = await new Person().login('Amigo');
  const { code } = await owner.must('createClub', { name: 'Prueba' });
  await friend.must('joinClub', { code });
  const practice = (await owner.must('createTable', { club: code, name: 'P1', turn: 60, practice: true, bots: 2 })).table;
  const other = (await owner.must('createTable', { club: code, name: 'P2', turn: 60, practice: true, bots: 2 })).table;
  const people = (await owner.must('createTable', { club: code, name: 'Real', seats: 2, bb: 100, turn: 60 })).table;

  assert.equal((await friend.post('/api/do', { op: 'setSeeCards', club: code, memberId: friend.me.id, on: true })).status, 400, 'un miembro se dio el permiso');
  console.log('ok     solo quien creÃ³ el club puede activarlo');

  await owner.must('sit', { club: code, table: practice, seat: 0 });
  assert.ok(hidden(botCards(await owner.whileBotsHoldCards(code, practice))), 'visible sin activar');
  console.log('ok     desactivado: cartas de los bots ocultas');

  await owner.must('setSeeCards', { club: code, memberId: owner.me.id, on: true });
  let v = await owner.whileBotsHoldCards(code, practice);
  assert.ok(revealed(botCards(v)) && v.table.peeking, 'no se ven con la opciÃ³n activada');
  console.log('ok     activado: se ven las cartas de los bots');

  await friend.must('sit', { club: code, table: other, seat: 0 });
  assert.ok(hidden(botCards(await friend.whileBotsHoldCards(code, other))), 'el amigo sin permiso las ve');
  assert.ok(hidden(botCards(await friend.whileBotsHoldCards(code, practice))), 'un espectador sin permiso las ve');
  console.log('ok     quien no tiene la opciÃ³n sigue sin verlas');

  await owner.must('setSeeCards', { club: code, memberId: owner.me.id, on: false });
  assert.ok(hidden(botCards(await owner.whileBotsHoldCards(code, practice))), 'siguen visibles al desactivar');
  console.log('ok     al desactivarlo vuelven a ocultarse');

  /* the cheating bot: owner only, practice with rule bots only, and always visible */
  const trained = (await owner.must('createTable', { club: code, name: 'P3', turn: 60, practice: true, bots: 1 })).table;
  assert.equal((await friend.post('/api/do', { op: 'setBotSees', club: code, table: other, on: true })).status, 400, 'un miembro lo activÃ³');
  assert.equal((await owner.post('/api/do', { op: 'setBotSees', club: code, table: people, on: true })).status, 400, 'se activÃ³ en una mesa con personas');
  assert.equal((await owner.post('/api/do', { op: 'setBotSees', club: code, table: trained, on: true })).status, 400, 'se activÃ³ con el bot entrenado');
  await owner.must('setBotSees', { club: code, table: other, on: true });
  assert.equal((await friend.snapshot(code, other)).table.botSees, true, 'otro jugador no ve el aviso');
  assert.equal((await friend.snapshot(code, other)).club.tables.find(x => x.id === other).botSees, true, 'la lista de mesas no lo muestra');
  await owner.must('setBotSees', { club: code, table: other, on: false });
  console.log('ok     bot tramposo: solo el dueÃ±o, solo en prÃ¡ctica con reglas, siempre visible');

  /* a shared practice table: warning before anyone sits, no extra view for anybody */
  const shared = (await owner.must('createTable', { club: code, name: 'Mixta', turn: 10, practice: true, bots: 2, people: 2 })).table;
  await owner.must('setBotSees', { club: code, table: shared, on: true });
  assert.equal((await friend.snapshot(code, shared)).table.botSees, true, 'el aviso no se ve antes de sentarse');
  await owner.must('stand', { club: code, table: practice });
  await friend.must('stand', { club: code, table: other });
  await owner.must('sit', { club: code, table: shared, seat: 0 });
  await friend.must('sit', { club: code, table: shared, seat: 1 });
  assert.equal((await owner.post('/api/do', { op: 'setBotSees', club: code, table: shared, on: false })).status, 400, 'cambiÃ³ con gente sentada');
  await owner.must('setSeeCards', { club: code, memberId: owner.me.id, on: true });
  let mixed;
  for (let i = 0; i < 300; i++) {
    mixed = await owner.whileBotsHoldCards(code, shared);
    if (mixed.table.seats.find(s => s?.id === friend.me.id).inHand) break;   /* wait out a hand that began before the friend sat down */
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(hidden(botCards(mixed)) && mixed.table.peeking === false, 'ver cartas funcionÃ³ en una mesa compartida');
  const friendCards = mixed.table.seats.find(s => s?.id === friend.me.id).cards;
  assert.ok(friendCards.every(c => c === null), `se vieron cartas de una persona: ${JSON.stringify(friendCards)}`);
  assert.equal(friendCards.length, 2, `el amigo no llegÃ³ a una mano: ${JSON.stringify(friendCards)}`);
  await owner.must('stand', { club: code, table: shared });
  await friend.must('stand', { club: code, table: shared });
  console.log('ok     mesa mixta: aviso antes de sentarse, sin cambios con gente y sin ventajas ocultas');

  /* a table with people: the option on, and the other person's cards stay hidden */
  for (const p of [owner, friend]) await owner.must('grant', { club: code, memberId: p.me.id, amount: 5000 });   /* no gift chips */
  await owner.must('sit', { club: code, table: people, seat: 0, buyIn: 5000 });
  await friend.must('sit', { club: code, table: people, seat: 1, buyIn: 5000 });
  for (let i = 0; i < 100; i++) {
    v = await owner.snapshot(code, people);
    if (v.table.hand && !v.table.hand.done) break;
    await new Promise(r => setTimeout(r, 25));
  }
  const rival = v.table.seats.find(s => s.id === friend.me.id);
  assert.ok(rival.cards.every(c => c === null), `se vieron cartas de una persona: ${JSON.stringify(rival.cards)}`);
  assert.equal(rival.cards.length, 2, `el rival no estaba en la mano: ${JSON.stringify(rival.cards)}`);
  assert.equal(v.table.peeking, false);
  console.log('ok     en una mesa con personas la opciÃ³n no revela nada');

  /* deleting every table during a hand: chips return and everybody lands back in the club */
  assert.equal((await friend.post('/api/do', { op: 'deleteTables', club: code })).status, 400, 'un miembro borrÃ³ las mesas');
  await owner.must('deleteTables', { club: code });
  const after = await owner.snapshot(code, people);
  assert.equal(after.table, null, 'la mesa sigue existiendo');
  assert.equal(after.club.tables.length, 0, 'quedaron mesas');
  assert.equal(after.club.members.reduce((sum, m) => sum + m.balance, 0), 10000, 'las fichas no volvieron');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(server.exitCode, null, 'el servidor se cayÃ³');
  console.log('ok     eliminar mesas: solo el dueÃ±o, en plena mano, y las fichas vuelven');
}
main().then(() => { server.kill(); fs.rmSync(DATA, { force: true }); console.log('todo correcto'); process.exit(0); })
  .catch(err => { console.error('FALLO', err.message); server.kill(); process.exit(1); });
