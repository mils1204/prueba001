'use strict';
/* A rule bot that loses its entry + 1 rebuy leaves the seat (becomes free). The trained bot never leaves. */
const assert = require('assert'), os = require('os'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const PORT = 18099, BASE = `http://127.0.0.1:${PORT}`, DATA = path.join(os.tmpdir(), `club-lv-${process.pid}.json`);
const server = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, DATA_FILE: DATA, ADMIN_OPEN: '1', PAUSE_MS: '10', START_MS: '10', BOT_MIN_MS: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let cookie = '';
async function post(url, body) { const r = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) }); const c = r.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: r.status, body: await r.json() }; }
const must = async (op, f) => { const r = await post('/api/do', { op, ...f }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

async function main() {
  await new Promise(r => server.stdout.once('data', r));
  await post('/api/login', { name: 'Tester' });
  const { code } = await must('createClub', { name: 'Lv' });
  const { table } = await must('createTable', { club: code, name: 'Mesa', turn: 60, practice: true, bots: 2, bb: 100 });
  await must('sit', { club: code, table, seat: 0 });

  let view = null, busy = false, freed = false, botsGone = 0, resits = 0;
  const res = await fetch(`${BASE}/api/stream?club=${code}&table=${table}`, { headers: { Cookie: cookie } });
  (async () => {
    let buf = ''; const d = new TextDecoder();
    for await (const c of res.body) { buf += d.decode(c, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); if (!line.startsWith('data: ')) continue;
        view = JSON.parse(line.slice(6)); const t = view.table;
        if (t.seats.filter(s => s?.bot).length < 2) freed = true;
        if (t.mySeat === -1 && !busy) { busy = true; post('/api/do', { op: 'sit', club: code, table, seat: 0 }).then(r => { if (r.status === 200) resits++; busy = false; }); }
        else if (t.legal && !busy) { busy = true; const l = t.legal; const move = l.canRaise ? { type: 'raise', to: l.maxTo } : (l.check ? { type: 'check' } : { type: 'call' }); post('/api/do', { op: 'act', club: code, table, ...move }).finally(() => { busy = false; }); }
      } } })().catch(() => {});

  const end = Date.now() + 120000;
  while (!freed && Date.now() < end) await sleep(50);
  assert.ok(freed, 'ningÃºn bot dejÃ³ la silla tras perder su entrada + recarga');
  botsGone = 2 - view.table.seats.filter(s => s?.bot).length;
  const emptyNow = view.table.seats.some(s => s === null);
  assert.ok(emptyNow, 'la silla del bot no quedÃ³ libre');
  console.log(`ok     un bot sin fichas del dÃ­a deja la silla libre (${botsGone} bot(s) se fueron)`);

  /* the trained bot never leaves its seat */
  const { table: tr } = await must('createTable', { club: code, name: 'Entrenada', turn: 60, practice: true, trained: true, bots: 1, bb: 100 });
  const vt = (await post('/api/do', { op: 'sit', club: code, table: tr, seat: 0 })) && null;
  await sleep(50);
  const snapC = new AbortController();
  const r2 = await fetch(`${BASE}/api/stream?club=${code}&table=${tr}`, { headers: { Cookie: cookie }, signal: snapC.signal });
  let txt = ''; for await (const ch of r2.body) { txt += Buffer.from(ch).toString(); if (txt.includes('\n\n')) break; } snapC.abort();
  const tv = JSON.parse(txt.slice(txt.indexOf('data: ') + 6, txt.indexOf('\n\n'))).table;
  assert.ok(tv.seats.some(s => s?.bot && s.id === 'bot'), 'la mesa entrenada perdiÃ³ su bot');
  console.log('ok     el bot entrenado se queda en su silla');
}
main().then(() => { server.kill(); fs.rmSync(DATA, { force: true }); console.log('todo correcto'); process.exit(0); })
  .catch(e => { console.error('FALLO', e.message); server.kill(); process.exit(1); });
