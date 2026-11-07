'use strict';
/* Plays against the real bot through HTTP. Usage: node test-bot.js [hands]
   The opponent always checks or calls, a rival the bot should beat. */
const assert = require('assert'), os = require('os'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');

const PORT = 18083, BASE = `http://127.0.0.1:${PORT}`, HANDS = Number(process.argv[2] || 150), WILD = process.argv[3] === 'agresivo', BOTS = Number(process.argv[4] || 1), BIG = Number(process.argv[5] || 100);
const DATA = path.join(os.tmpdir(), `club-bot-${process.pid}.json`);
const server = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, DATA_FILE: DATA, ADMIN_OPEN: '1', PAUSE_MS: '5', START_MS: '5', BOT_MIN_MS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
const complaints = [];
server.stderr.on('data', d => complaints.push(String(d)));

let cookie = '';
async function post(url, body) {
  const res = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  const c = res.headers.get('set-cookie');
  if (c) cookie = c.split(';')[0];
  return { status: res.status, body: await res.json() };
}
const must = async (op, fields) => { const r = await post('/api/do', { op, ...fields }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

async function main() {
  await new Promise(r => server.stdout.once('data', r));
  await post('/api/login', { name: 'Tester' });
  const { code } = await must('createClub', { name: 'Prueba' });
  const { table } = await must('createTable', { club: code, name: 'PrÃ¡ctica', turn: 120, practice: true, bots: BOTS, bb: BIG });
  await must('sit', { club: code, table, seat: 0 });

  let view = null, busy = false, longest = 0, askedAt = 0, peeks = 0, counted = 0, stale = 0;
  const results = [];
  const res = await fetch(`${BASE}/api/stream?club=${code}&table=${table}`, { headers: { Cookie: cookie } });
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
        view = JSON.parse(line.slice(6));
        const t = view.table;
        assert.equal(t.hand?.last?.why, undefined, 'la explicaciÃ³n llegÃ³ durante la mano');
        const latest = t.history[0];
        if (latest && latest.no > counted) { results.push(-latest.mine); counted = latest.no; }
        const bots = t.seats.filter(s => s?.bot), botTurn = bots.some(b => b.turn);
        assert.equal(bots.length, BOTS);
        if (t.hand && !t.hand.done && bots.some(b => b.cards.some(c => c !== null))) peeks++;
        if (botTurn && !askedAt) askedAt = Date.now();
        if (!botTurn && askedAt) { longest = Math.max(longest, Date.now() - askedAt); askedAt = 0; }
        if (t.legal && !busy) {
          busy = true;
          const l = t.legal, r = Math.random();
          let move = { type: l.check ? 'check' : 'call' };
          if (WILD && l.canRaise && r < 0.4) move = { type: 'raise', to: r < 0.08 ? l.maxTo : l.minTo + Math.floor(Math.random() * Math.min(l.maxTo - l.minTo + 1, BIG * 30)) };
          else if (WILD && !l.check && r > 0.85) move = { type: 'fold' };
          post('/api/do', { op: 'act', club: code, table, ...move }).then(r2 => {
            /* the stream and the reply travel separately, so a stale view can ask twice; the server must refuse that */
            if (r2.status === 200 || r2.body.error === 'No es tu turno') { stale += r2.status === 200 ? 0 : 1; busy = false; return; }
            complaints.push(JSON.stringify(r2.body));
            busy = false;
          });
        }
      }
    }
  })().catch(() => {});

  const limit = Date.now() + 3000000;
  let restarts = 0, checked = 0, previous = null, explained = 0;
  while ((view?.table.history[0]?.no ?? 0) < HANDS) {
    assert.ok(Date.now() < limit, `se atascÃ³ en la mano ${view?.table.history[0]?.no}`);
    await new Promise(r => setTimeout(r, 100));
    if (view?.table.mySeat === -1) {
      const again = await post('/api/do', { op: 'sit', club: code, table, seat: 0 });
      if (again.status === 200) { restarts++; previous = null; }
    }
    /* chips must carry from each hand to the next */
    const newest = view?.table.history[0]?.no ?? 0;
    while (checked < newest) {
      const hand = (await fetch(`${BASE}/api/hand?club=${code}&table=${table}&no=${++checked}`, { headers: { Cookie: cookie } }).then(r => r.json()));
      for (const e of hand.log) {
        if (e.id.startsWith('bot') && e.type !== 'sb' && e.type !== 'bb') {
          assert.ok(e.why && Number.isFinite(e.why.strength), `decisiÃ³n sin explicaciÃ³n en la mano ${hand.no}`);
          explained++;
        }
      }
      for (const p of hand.players) {
        const was = previous?.players.find(q => q.id === p.id);
        if (BOTS === 1) { if (p.id.startsWith('bot')) assert.ok(p.start <= BIG * 100, 'el bot entrenado empezÃ³ con mÃ¡s de 100 BB'); else assert.equal(p.start, BIG * 100, 'el jugador no se recargÃ³ a 100 BB'); }
        else if (was && hand.no === previous.no + 1 && !hand.reset) assert.equal(p.start, was.end === 0 ? BIG * 100 : was.end, `las fichas de ${p.name} no pasaron a la mano ${hand.no}`);
      }
      const human = hand.players.find(p => !p.id.startsWith('bot'));
      previous = human.end === 0 ? null : hand;           /* going broke starts a new game */
    }
  }
  const t = view.table;
  assert.deepEqual(complaints, [], 'el bot tuvo problemas');
  assert.equal(peeks, 0, 'el cliente vio cartas del bot');
  assert.equal(view.club.balance, 0, 'la prÃ¡ctica tocÃ³ las fichas del club');
  assert.equal(view.club.ledger.length, 0, 'la prÃ¡ctica escribiÃ³ movimientos');
  const hands = t.history[0].no;
  console.log(`ok     ${hands} manos sin jugadas rechazadas ni fallos del bot`);
  console.log('ok     sin cartas del bot visibles y sin tocar las fichas del club');
  const mean = results.reduce((a, b) => a + b, 0) / results.length;
  const spread = Math.sqrt(results.reduce((a, b) => a + (b - mean) ** 2, 0) / (results.length - 1));
  console.log(`dato   rival ${WILD ? 'agresivo al azar' : 'que siempre iguala'}: bot ${mean.toFixed(1)} Â±${(1.96 * spread / Math.sqrt(results.length)).toFixed(1)} bb/100 en ${results.length} manos`);
  console.log(`dato   espera mÃ¡s larga de los bots: ${(longest / 1000).toFixed(1)} s`);

  /* once the human stands up, the bots must stop */
  console.log(`ok     ${checked} manos con las fichas correctas de una a otra (${restarts} partidas nuevas tras quedarse en 0)`);
  console.log(`ok     ${explained} decisiones de bots explicadas en el repaso y ninguna durante la mano`);
  console.log(`dato   Ã³rdenes duplicadas por vista vieja, rechazadas por el servidor: ${stale}`);
  if (view.table.mySeat >= 0) { const r = await post('/api/do', { op: 'stand', club: code, table }); assert.ok(r.status === 200 || r.body.error === 'No estÃ¡s sentado en esta mesa', JSON.stringify(r.body)); }   /* may have just gone broke */
  const end = Date.now() + 30000;
  while (view.table.mySeat >= 0 && Date.now() < end) await new Promise(r => setTimeout(r, 50));
  assert.equal(view.table.mySeat, -1, 'no pudo levantarse');
  const last = view.table.handNoSeen = view.table.history[0].no;
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(view.table.history[0].no, last, 'las manos de demostraciÃ³n entraron al historial');
  console.log('ok     al levantarte no se registran mÃ¡s manos');
}

main().then(() => { server.kill(); fs.rmSync(DATA, { force: true }); console.log('todo correcto'); process.exit(0); })
  .catch(err => { console.error('FALLO', err.message, complaints.slice(0, 5)); server.kill(); process.exit(1); });
