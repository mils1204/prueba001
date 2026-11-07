'use strict';
/* Starts a real server on a spare port and plays through HTTP, as browsers would.
   Usage: node test-server.js [hands] */
const assert = require('assert'), os = require('os'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');

const PORT = 18080, BASE = `http://127.0.0.1:${PORT}`, HANDS = Number(process.argv[2] || 60);
const DATA = path.join(os.tmpdir(), `club-test-${process.pid}.json`);
let server;
function boot() {
  server = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, DATA_FILE: DATA, ADMIN_OPEN: '1', PAUSE_MS: '20', START_MS: '20' }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise(resolve => server.stdout.once('data', resolve));
}
function halt() {
  return new Promise(resolve => { server.once('exit', resolve); server.kill(); });
}

class Friend {
  constructor(name) { this.name = name; this.leaks = []; }
  async call(url, options = {}) {
    const res = await fetch(BASE + url, { ...options, headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) } });
    const cookie = res.headers.get('set-cookie');
    if (cookie) this.cookie = cookie.split(';')[0];
    const body = await res.json();
    return { status: res.status, body };
  }
  async login() { this.me = (await this.call('/api/login', { method: 'POST', body: JSON.stringify({ name: this.name }) })).body; }
  async do(op, fields = {}) { return this.call('/api/do', { method: 'POST', body: JSON.stringify({ op, ...fields }) }); }
  async must(op, fields) { const r = await this.do(op, fields); assert.equal(r.status, 200, `${op}: ${JSON.stringify(r.body)}`); return r.body; }
  async watch(club, table) {
    this.stop = new AbortController();
    const res = await fetch(`${BASE}/api/stream?club=${club}&table=${table}`, { headers: { Cookie: this.cookie }, signal: this.stop.signal });
    this.reader = (async () => {
      let buffer = '';
      const decoder = new TextDecoder();
      try {
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let cut;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const line = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            if (line.startsWith('data: ')) this.see(JSON.parse(line.slice(6)));
          }
        }
      } catch { /* the test closed the stream */ }
    })();
    while (!this.view) await new Promise(r => setTimeout(r, 5));
  }
  see(view) {
    this.view = view;
    const t = view.table;
    if (!t) return;
    for (const s of t.seats) {
      if (s && s.id !== view.me.id && !t.hand?.done && s.cards.some(c => c !== null)) this.leaks.push(s.name);
    }
    if (t.legal && !this.busy) this.play(t);
  }
  async play(t) {
    this.busy = true;
    const l = t.legal, r = Math.random();
    let move = l.check ? { type: 'check' } : r < 0.2 ? { type: 'fold' } : { type: 'call' };
    if (l.canRaise && r > 0.75) move = { type: 'raise', to: r > 0.95 ? l.maxTo : l.minTo };
    await this.do('act', { club: this.club, table: this.table, ...move }).catch(() => {});   /* the restart check cuts the server on purpose */
    this.busy = false;
    if (this.view?.table?.legal) this.see(this.view);
  }
}
const total = v => v.club.members.reduce((sum, m) => sum + m.balance, 0) + v.table.seats.reduce((sum, s) => sum + (s ? s.stack : 0), 0)
  + (v.table.hand && !v.table.hand.done ? v.table.hand.pot : 0);
function savedTotal(code) {
  const club = JSON.parse(fs.readFileSync(DATA, 'utf8')).clubs[code];
  return Object.values(club.members).reduce((sum, m) => sum + m.balance, 0)
    + Object.values(club.tables).flatMap(t => t.seatList).reduce((sum, s) => sum + (s ? s.stack : 0), 0);
}

async function main() {
  await boot();
  const friends = ['Ana', 'Beto', 'Caro', 'Dani', 'Eli', 'Fer'].map(n => new Friend(n));
  for (const f of friends) await f.login();
  const [ana, beto] = friends, stranger = new Friend('Extra');
  await stranger.login();

  const { code } = await ana.must('createClub', { name: 'Los viernes' });
  for (const f of friends.slice(1)) await f.must('joinClub', { code });
  const { table } = await ana.must('createTable', { club: code, name: 'Principal', seats: 6, bb: 20, turn: 10 });

  /* permissions */
  assert.equal((await beto.do('grant', { club: code, memberId: beto.me.id, amount: 5000 })).status, 400, 'alguien sin permiso se dio fichas');
  assert.equal((await beto.do('createTable', { club: code, name: 'x', seats: 2, bb: 20, turn: 10 })).status, 400);
  assert.equal((await stranger.do('sit', { club: code, table, seat: 0, buyIn: 2000 })).status, 400, 'un extraÃ±o se sentÃ³');
  assert.equal((await stranger.call(`/api/hand?club=${code}&table=${table}&no=1`)).status, 400);
  assert.equal((await new Friend('Nadie').call('/api/do', { method: 'POST', body: '{"op":"sit"}' })).status, 401);
  assert.equal((await ana.do('constructor', { club: code })).status, 400);
  assert.equal((await ana.do('sit', { club: code, table, seat: 9, buyIn: 2000 })).status, 400);
  assert.equal((await ana.do('sit', { club: code, table, seat: 0, buyIn: 1e9 })).status, 400);
  assert.equal((await ana.do('sit', { club: code, table, seat: 0, buyIn: 1.5 })).status, 400);
  const gate = await fetch(`${BASE}/api/do`, { method: 'POST', headers: { Cookie: ana.cookie, 'Content-Type': 'text/plain' }, body: '{"op":"createClub","name":"x"}' });
  assert.equal(gate.status, 400, 'aceptÃ³ una peticiÃ³n que no era JSON');
  console.log('ok     permisos y validaciÃ³n');

  for (const f of friends) await ana.must('grant', { club: code, memberId: f.me.id, amount: 10000 });   /* no gift chips: the owner funds everyone */
  for (const f of friends) { f.club = code; f.table = table; await f.watch(code, table); }
  const start = total(ana.view);
  assert.equal(start, 6 * 10000);
  for (const [i, f] of friends.entries()) await f.must('sit', { club: code, table, seat: i, buyIn: 2000 });

  const deadline = Date.now() + 120000;
  while ((ana.view.table.history[0]?.no ?? 0) < HANDS) {
    assert.ok(Date.now() < deadline, `se atascÃ³ en la mano ${ana.view.table.history[0]?.no}`);
    await new Promise(r => setTimeout(r, 25));
    for (const f of friends) { const s = f.view.table.seats.find(x => x?.id === f.me.id); if (!s && f.view.club.balance >= 500) { const free = f.view.table.seats.indexOf(null); if (free >= 0) await f.do('sit', { club: code, table, seat: free, buyIn: 500 }); } }
  }
  assert.deepEqual(friends.flatMap(f => f.leaks), [], 'alguien recibiÃ³ cartas ajenas');
  console.log(`ok     ${ana.view.table.history[0].no} manos jugadas por HTTP con 6 jugadores, sin filtrar cartas`);

  /* hand history keeps folded cards private */
  const no = ana.view.table.history.at(-1).no;
  for (const f of friends) {
    const hand = (await f.call(`/api/hand?club=${code}&table=${table}&no=${no}`)).body;
    const shown = new Set(hand.showdown.map(s => s.id));
    for (const p of hand.players) if (p.id !== f.me.id && !shown.has(p.id)) assert.deepEqual(p.cards, [], 'el historial filtrÃ³ cartas');
  }
  console.log('ok     el historial no revela cartas no mostradas');

  /* reconnecting mid-game returns your seat and your own cards */
  const seated = friends.find(f => f.view.table.mySeat >= 0);
  seated.stop.abort();
  await seated.reader;
  seated.view = null;
  await seated.watch(code, table);
  assert.ok(seated.view.table.mySeat >= 0, 'perdiÃ³ el asiento al reconectar');
  console.log('ok     reconexiÃ³n conserva el asiento');

  /* everyone leaves: every chip must come back */
  for (const f of friends) { f.do = f.do.bind(f); if (f.view.table.mySeat >= 0) { const r = await f.do('stand', { club: code, table }); assert.ok(r.status === 200 || r.body.error === 'No estÃ¡s sentado en esta mesa', JSON.stringify(r.body)); } }   /* a stale view may not know the player already went broke */
  const end = Date.now() + 15000;
  while (ana.view.table.seats.some(Boolean) && Date.now() < end) await new Promise(r => setTimeout(r, 25));
  assert.ok(!ana.view.table.seats.some(Boolean), 'quedÃ³ alguien sentado');
  assert.equal(total(ana.view), start, 'las fichas del club no cuadran');
  console.log(`ok     al levantarse todos el club sigue con ${start} fichas`);

  /* a restart in the middle of a hand voids the hand and keeps every chip */
  await ana.must('sit', { club: code, table, seat: 0, buyIn: 500 });
  await beto.must('sit', { club: code, table, seat: 1, buyIn: 500 });
  await new Promise(r => setTimeout(r, 450));
  for (const f of friends) f.stop.abort();
  await halt();
  assert.equal(savedTotal(code), start, 'el archivo guardado no cuadra tras cortar el servidor');
  await boot();
  await ana.watch(code, table);
  assert.equal(total(ana.view), start, 'el reinicio perdiÃ³ fichas');
  assert.equal(ana.view.table.seats.filter(Boolean).length >= 1, true);
  console.log('ok     reiniciar el servidor no pierde fichas');
  ana.stop.abort();
  await halt();
}

main().then(() => { fs.rmSync(DATA, { force: true }); console.log('todo correcto'); process.exit(0); })
  .catch(err => { console.error('FALLO', err); server?.kill(); process.exit(1); });
