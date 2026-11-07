'use strict';
/* Bots play among themselves while someone watches an empty practice table, and it changes nothing. */
const assert = require('assert'), os = require('os'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');

const PORT = 18087, BASE = `http://127.0.0.1:${PORT}`, DATA = path.join(os.tmpdir(), `club-demo-${process.pid}.json`);
const server = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, DATA_FILE: DATA, ADMIN_OPEN: '1', PAUSE_MS: '30', START_MS: '30', BOT_MIN_MS: '10', DEMO_GRACE_MS: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let cookie = '', view = null, stop = null;
async function post(url, body) {
  const res = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  const c = res.headers.get('set-cookie');
  if (c) cookie = c.split(';')[0];
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  return data;
}
const frames = [];
async function watch(code, table) {
  stop = new AbortController();
  const res = await fetch(`${BASE}/api/stream?club=${code}&table=${table}`, { headers: { Cookie: cookie }, signal: stop.signal });
  (async () => {
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const line = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (line.startsWith('data: ')) { view = JSON.parse(line.slice(6)); frames.push(view.table); }
      }
    }
  })().catch(() => {});
  while (!view) await sleep(5);
}
const until = async (test, label, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (test()) return; await sleep(10); }
  throw new Error(`no ocurriÃ³: ${label}`);
};

const NAMES = require('./bot/names.js'), all = Object.values(NAMES).flat();
async function main() {
  await new Promise(r => server.stdout.once('data', r));
  await post('/api/login', { name: 'Tester' });
  const { code } = await post('/api/do', { op: 'createClub', name: 'Prueba' });
  let { table } = await post('/api/do', { op: 'createTable', club: code, name: 'P', turn: 60, practice: true, bots: 3 });
  let { table: trained } = await post('/api/do', { op: 'createTable', club: code, name: 'T', turn: 60, practice: true, bots: 1 });

  /* trained bot: exactly one person. One rule bot: can fill the other five seats */
  const refused = await post('/api/do', { op: 'createTable', club: code, name: 'X', turn: 60, practice: true, trained: true, bots: 1, people: 2 }).then(() => false, () => true);
  assert.ok(refused, 'el bot entrenado aceptÃ³ dos personas');
  const { table: oneRule } = await post('/api/do', { op: 'createTable', club: code, name: 'R', turn: 60, practice: true, trained: false, bots: 1, people: 5 });
  const { table: duel } = await post('/api/do', { op: 'createTable', club: code, name: 'D', turn: 60, practice: true, trained: false, bots: 1, people: 1 });
  const { table: real } = await post('/api/do', { op: 'createTable', club: code, name: 'E', turn: 60, practice: true, trained: true, bots: 1, people: 1 });
  await watch(code, oneRule);
  assert.equal(view.table.size, 6);
  assert.ok(view.table.seats.filter(s => s?.bot).every(s => s.id !== 'bot' && /\(bot\)$|^bot\b/i.test(s.name)), 'con varias personas debe ser un bot con reglas');
  stop.abort();
  view = null;
  await watch(code, duel);
  assert.ok(view.table.seats[1].id !== 'bot' && all.includes(view.table.seats[1].name), '1 bot con reglas debe tener un nombre automÃ¡tico');
  stop.abort();
  view = null;
  await watch(code, real);
  assert.equal(view.table.seats[1].id, 'bot', 'la mesa entrenada no tiene al bot entrenado');
  stop.abort();
  view = null;
  console.log('ok     bot entrenado: solo 1 persona; 1 bot con reglas: hasta 5 personas');

  /* a chosen bot name always ends in Bot */
  for (const [typed, expected, extra] of [['Kiko', 'Kiko Bot', { trained: true }], ['Tigre Bot', 'Tigre Bot', { trained: true }], ['Robot', 'Robot Bot', { trained: false }], ['Nombre muy largo aqu', 'Nombre muy largo Bot',{ trained: false, people: 3 }]]) {
    const { table: named } = await post('/api/do', { op: 'createTable', club: code, name: 'N', turn: 60, practice: true, bots: 1, botName: typed, ...extra });
    await watch(code, named);
    assert.equal(view.table.seats.find(s => s?.bot).name, expected);
    stop.abort();
    view = null;
  }
  const { table: several } = await post('/api/do', { op: 'createTable', club: code, name: 'V', turn: 60, practice: true, bots: 3, botNames: ['Luna', '', 'Tigre Bot'] });
  await watch(code, several);
  const givenNames = view.table.seats.filter(s => s?.bot).map(s => s.name);
  assert.equal(givenNames[0], 'Luna Bot');
  assert.ok(all.includes(givenNames[1]), `el campo vacÃ­o debe usar nombre automÃ¡tico: ${givenNames[1]}`);
  assert.equal(givenNames[2], 'Tigre Bot');
  stop.abort();
  view = null;
  await post('/api/do', { op: 'deleteTables', club: code });
  const refreshed = await post('/api/do', { op: 'createTable', club: code, name: 'P', turn: 60, practice: true, bots: 3 });
  table = refreshed.table;
  trained = (await post('/api/do', { op: 'createTable', club: code, name: 'T', turn: 60, practice: true, bots: 1 })).table;
  console.log('ok     Nombre del Bot: siempre termina en Bot');

  /* decimal stakes */
  for (const [category, bb, entry] of [['micro', 10, 1000], ['low', 50, 5000], ['mid', 100, 10000]]) {
    const { table: staked } = await post('/api/do', { op: 'createTable', club: code, name: category, turn: 60, practice: true, trained: true, bots: 1, category });
    await watch(code, staked);
    const row = view.club.tables.find(x => x.id === staked);
    assert.deepEqual([view.table.bb, view.table.sb, row.entry, row.cents], [bb, bb / 2, entry, true], `categorÃ­a ${category}`);
    stop.abort();
    view = null;
  }
  console.log('ok     categorÃ­as 0,05/0,10, 0,25/0,50 y 0,50/1 con 100 BB');

  /* configurable blinds and entry */
  const { table: custom } = await post('/api/do', { op: 'createTable', club: code, name: 'BB', turn: 60, practice: true, bots: 2, bb: 20, depth: 50 });
  const { table: fixed } = await post('/api/do', { op: 'createTable', club: code, name: 'Fija', turn: 60, practice: true, bots: 1, bb: 20, depth: 50 });
  await post('/api/do', { op: 'sit', club: code, table: custom, seat: 0 });
  await watch(code, custom);
  await until(() => view.table.hand && !view.table.hand.demo, 'mano con ciegas propias');
  const seated = view.table.seats.filter(Boolean);
  assert.equal(view.table.bb, 20);
  assert.equal(view.table.sb, 10);
  assert.ok(seated.every(s => s.stack + s.bet === 1000), 'la entrada no es de 50 BB');
  const listed = view.club.tables.find(x => x.id === custom), trainedRow = view.club.tables.find(x => x.id === fixed);
  assert.equal(listed.entry, 1000);
  assert.deepEqual([trainedRow.bb, trainedRow.entry], [20, 2000], 'el bot entrenado debe usar la ciega elegida y siempre 100 BB');
  const odd = await post('/api/do', { op: 'createTable', club: code, name: 'I', turn: 60, practice: true, trained: true, bots: 1, bb: 15 }).then(() => false, () => true);
  assert.ok(odd, 'el bot entrenado aceptÃ³ una ciega impar');
  await post('/api/do', { op: 'stand', club: code, table: custom });
  stop.abort();
  view = null;
  console.log('ok     BB y entrada configurables; el bot entrenado acepta BB par y siempre 100 BB');

  /* names: 25 per style with no repeats, person-like only when you are alone */
  assert.ok(Object.values(NAMES).every(list => list.length === 25), 'no hay 25 nombres por estilo');
  assert.equal(new Set(all).size, 125, 'hay nombres repetidos');
  const { table: shared } = await post('/api/do', { op: 'createTable', club: code, name: 'M', turn: 60, practice: true, bots: 3, people: 2 });
  const line = [];
  for (let i = 0; i < 12; i++) {
    const { table: t2 } = await post('/api/do', { op: 'createTable', club: code + '', name: `N${i}`, turn: 60, practice: true, bots: 3 }).catch(() => ({}));
    if (t2) line.push(t2);
  }
  await watch(code, shared);
  assert.ok(view.table.seats.filter(s => s?.bot).every(s => /^bot\b|\(bot\)$/i.test(s.name)), 'en mesa compartida un bot debe decir que lo es');
  stop.abort();
  view = null;
  const lineups = new Set();
  for (const id of line) {
    await watch(code, id);
    const bots = view.table.seats.filter(s => s?.bot);
    assert.equal(bots.length, 3);
    for (const b of bots) assert.ok(all.includes(b.name), `nombre raro: ${b.name}`);
    lineups.add(bots.map(b => b.id).sort().join());
    stop.abort();
    view = null;
  }
  assert.ok(lineups.size > 1, 'los estilos no entran al azar');
  console.log(`ok     125 nombres; mesa compartida con "Bot", mesa individual con nombre y 4 nÃºmeros, ${lineups.size} combinaciones de estilos`);
  frames.length = 0;

  await watch(code, table);
  await until(() => view.table.hand?.demo, 'empieza la demostraciÃ³n');
  console.log('ok     con la mesa vacÃ­a y abierta, los bots juegan solos');

  const finished = () => frames.filter(t => t.hand?.demo && t.hand.done).length;
  await until(() => finished() >= 25, '25 manos de demostraciÃ³n', 60000);
  const ends = frames.filter(x => x.hand?.demo && x.hand.done);
  for (const t of ends) {
    const total = t.seats.reduce((sum, s) => sum + (s ? s.stack : 0), 0);
    assert.equal(total % 10000, 0, 'las fichas no cuadran (solo pueden crecer por recompras de 10.000)');
    assert.ok(total >= 30000, 'desaparecieron fichas');
  }
  assert.ok(ends.at(-1).seats.some(s => s && s.stack !== 10000), 'las fichas no cambiaron entre manos');
  assert.equal(view.table.history.length, 0, 'la demostraciÃ³n entrÃ³ al historial');
  assert.ok(frames.every(t => !t.hand || t.hand.done || t.seats.every(s => !s || s.cards.every(c => c === null))), 'se vieron cartas de bots');
  console.log(`ok     ${finished()} finales de mano con fichas que cuadran y cambian, sin historial y con cartas ocultas`);

  await post('/api/do', { op: 'sit', club: code, table, seat: 0 });
  await until(() => view.table.hand && !view.table.hand.demo, 'entra a una mano normal', 15000);
  const me = view.table.seats[0], entered = frames.filter(x => x.hand?.demo && x.hand.done).at(-1);
  assert.equal(view.table.hand.no, 1);
  assert.equal(me.cards.length, 2);
  assert.equal(me.stack + me.bet, 10000, 'no entraste con 10.000');
  for (const s of view.table.seats) {
    if (!s?.bot) continue;
    const before = entered.seats[s.seat].stack;
    assert.equal(s.stack + s.bet, before === 0 ? 10000 : before, `${s.name} no conservÃ³ sus fichas al entrar`);
  }
  console.log('ok     entras en la siguiente mano con 10.000 y los bots conservan sus fichas');

  await post('/api/do', { op: 'stand', club: code, table });
  await until(() => view.table.mySeat === -1 && view.table.hand?.demo, 'vuelven a jugar solos', 15000);
  console.log('ok     al levantarte vuelven a jugar solos');

  stop.abort();
  await sleep(600);
  view = null;
  frames.length = 0;
  await watch(code, table);
  assert.ok(!frames[0].hand || frames[0].hand.done, 'siguieron jugando sin nadie mirando');
  console.log('ok     si nadie mira la mesa, se detienen');
  stop.abort();

  view = null;
  frames.length = 0;
  await watch(code, trained);
  await sleep(500);
  assert.ok(frames.every(t => !t.hand), 'la mesa del bot entrenado empezÃ³ sola');
  console.log('ok     la mesa del bot entrenado no juega sola');
}
main().then(() => { server.kill(); fs.rmSync(DATA, { force: true }); console.log('todo correcto'); process.exit(0); })
  .catch(err => { console.error('FALLO', err.message); server.kill(); process.exit(1); });
