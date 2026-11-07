'use strict';
/* Standing up from a practice table and sitting back down keeps the same chips and the same result. */
const assert = require('assert'), os = require('os'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const PORT = 18100, BASE = `http://127.0.0.1:${PORT}`, DATA = path.join(os.tmpdir(), `club-rs-${process.pid}.json`);
const server = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, DATA_FILE: DATA, ADMIN_OPEN: '1', PAUSE_MS: '40', START_MS: '40', BOT_MIN_MS: '0' }, stdio: ['ignore', 'pipe', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let cookie = '';
async function post(url, body) { const r = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) }); const c = r.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return { status: r.status, body: await r.json() }; }
const must = async (op, f) => { const r = await post('/api/do', { op, ...f }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

async function main() {
  await new Promise(r => server.stdout.once('data', r));
  await post('/api/login', { name: 'Tester' });
  const { code } = await must('createClub', { name: 'RS' });
  const { table } = await must('createTable', { club: code, name: 'Mesa', turn: 60, practice: true, bots: 2, bb: 100 });
  await must('sit', { club: code, table, seat: 0 });

  let view = null, busy = false, play = true;
  const res = await fetch(`${BASE}/api/stream?club=${code}&table=${table}`, { headers: { Cookie: cookie } });
  (async () => { let buf = ''; const d = new TextDecoder();
    for await (const c of res.body) { buf += d.decode(c, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); if (!line.startsWith('data: ')) continue;
        view = JSON.parse(line.slice(6)); const l = view.table?.legal;
        if (play && l && !busy) { busy = true; post('/api/do', { op: 'act', club: code, table, type: l.check ? 'check' : 'fold' }).finally(() => { busy = false; }); }   /* check or fold: lose only blinds, never bust */
      } } })().catch(() => {});

  /* play a handful of hands so the chips and result move off their starting values */
  const end = Date.now() + 60000;
  while ((view?.table.history[0]?.no ?? 0) < 6 && Date.now() < end) await sleep(30);
  play = false;
  await sleep(300);                                 /* let the current hand settle */
  while (view.table.hand && !view.table.hand.done) await sleep(30);
  const me = view.table.seats.find(s => s && !s.bot);
  const stack = me.stack, net = me.net;
  assert.ok(net !== 0, `el resultado no se moviÃ³ (net=${net})`);

  await must('stand', { club: code, table });
  await sleep(200);
  assert.equal(view.table.mySeat, -1, 'no se levantÃ³');
  assert.equal(view.table.reserved, stack, 'no guardÃ³ las fichas al levantarse');

  await must('sit', { club: code, table, seat: 0 });
  await sleep(100);
  const back = view.table.seats.find(s => s && !s.bot);
  assert.equal(back.stack + back.bet, stack, `volviÃ³ con otras fichas: ${back.stack + back.bet} vs ${stack}`);
  assert.equal(back.net, net, `volviÃ³ con otro resultado: ${back.net} vs ${net}`);
  console.log(`ok     al volver conservas ${(stack / 100).toFixed(2)} fichas y resultado ${(net / 100).toFixed(2)}`);
}
main().then(() => { server.kill(); fs.rmSync(DATA, { force: true }); console.log('todo correcto'); process.exit(0); })
  .catch(e => { console.error('FALLO', e.message); server.kill(); process.exit(1); });
