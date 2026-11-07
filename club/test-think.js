'use strict';
/* Measures real bot pauses with the default settings. Usage: node test-think.js [decisions] */
const assert = require('assert'), os = require('os'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');

const PORT = 18086, BASE = `http://127.0.0.1:${PORT}`, DATA = path.join(os.tmpdir(), `club-think-${process.pid}.json`), WANT = Number(process.argv[2] || 12);
const env = { ...process.env, PORT, DATA_FILE: DATA, ADMIN_OPEN: '1', PAUSE_MS: '50', START_MS: '50' };
delete env.BOT_MIN_MS;
const server = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'inherit'] });

let cookie = '';
async function post(url, body) {
  const res = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  const c = res.headers.get('set-cookie');
  if (c) cookie = c.split(';')[0];
  return res.json();
}
async function main() {
  await new Promise(r => server.stdout.once('data', r));
  await post('/api/login', { name: 'Tester' });
  const { code } = await post('/api/do', { op: 'createClub', name: 'Prueba' });
  const { table } = await post('/api/do', { op: 'createTable', club: code, name: 'P', turn: 120, practice: true, bots: 2 });
  await post('/api/do', { op: 'sit', club: code, table, seat: 0 });
  const res = await fetch(`${BASE}/api/stream?club=${code}&table=${table}`, { headers: { Cookie: cookie } });
  const waits = [], quick = [];
  let started = 0, key = '', folding = false, busy = false, buffer = '', humanOut = false;
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const line = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      if (!line.startsWith('data: ')) continue;
      const t = JSON.parse(line.slice(6)).table, h = t.hand;
      const thinker = t.seats.find(s => s?.bot && s.turn);
      const now = h && !h.done && thinker ? `${h.no}-${thinker.id}-${h.pot}-${h.street}` : '';
      if (now !== key) {
        if (key && started) (humanOut ? quick : waits).push((Date.now() - started) / 1000);
        key = now;
        started = now ? Date.now() : 0;
        humanOut = !!t.seats[0]?.folded;
      }
      if (t.legal && !busy) {
        busy = true;
        folding = waits.length >= WANT;
        post('/api/do', { op: 'act', club: code, table, type: folding ? 'fold' : t.legal.check ? 'check' : 'call' }).then(() => { busy = false; });
      }
      if (quick.length >= 2) {
        const low = Math.min(...waits), high = Math.max(...waits);
        console.log(`dato   ${waits.length} pausas: de ${low.toFixed(1)} a ${high.toFixed(1)} s`, waits.map(w => w.toFixed(1)).join(' '));
        console.log(`dato   entre bots, tras retirarte: ${quick.map(w => w.toFixed(1)).join(' ')} s`);
        assert.ok(low >= 2.9 && high <= 10.6, 'pausa fuera de 3 a 10 segundos');
        assert.ok(high - low > 2, 'las pausas no varÃ­an');
        assert.ok(quick.every(w => w >= 2.9 && w <= 10.6), 'entre bots la pausa no es de 3 a 10 segundos');
        return;
      }
    }
  }
}
main().then(() => { server.kill(); fs.rmSync(DATA, { force: true }); console.log('todo correcto'); process.exit(0); })
  .catch(err => { console.error('FALLO', err.message); server.kill(); process.exit(1); });
