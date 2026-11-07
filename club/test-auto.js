'use strict';
/* Bots play unwatched during the grace window, pause after it, and resume when the table is opened. */
const assert = require('assert'), os = require('os'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(grace) {
  const PORT = 18101 + (grace ? 0 : 1), BASE = `http://127.0.0.1:${PORT}`, DATA = path.join(os.tmpdir(), `club-au-${process.pid}-${grace}.json`);
  const server = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, DATA_FILE: DATA, ADMIN_OPEN: '1', PAUSE_MS: '20', START_MS: '20', BOT_MIN_MS: '0', DEMO_GRACE_MS: String(grace) }, stdio: ['ignore', 'pipe', 'inherit'] });
  let cookie = '';
  const post = async (url, body) => { const r = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) }); const c = r.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return r.json(); };
  const snap = async (code, table) => { const s = new AbortController(); const r = await fetch(`${BASE}/api/stream?club=${code}&table=${table}`, { headers: { Cookie: cookie }, signal: s.signal }); let t = ''; for await (const c of r.body) { t += Buffer.from(c).toString(); if (t.includes('\n\n')) break; } s.abort(); return JSON.parse(t.slice(t.indexOf('data: ') + 6, t.indexOf('\n\n'))); };
  try {
    await new Promise(r => server.stdout.once('data', r));
    await post('/api/login', { name: 'Dan' });
    const { code } = await post('/api/do', { op: 'createClub', name: 'A' });
    const { table } = await post('/api/do', { op: 'createTable', club: code, name: 'M', turn: 60, practice: true, bots: 3 });
    await sleep(1500);                                   /* nobody watching */
    const v = await snap(code, table);
    return v.table.hand?.demo === true || v.table.seats.some(s => s?.bot && s.stack !== 10000);   /* a hand in play or chips that moved means they played */
  } finally { server.kill(); await sleep(300); fs.rmSync(DATA, { force: true }); }
}

async function main() {
  assert.ok(await run(5000), 'con gracia, los bots no jugaron sin pÃºblico');
  console.log('ok     con la gracia activa los bots juegan sin que nadie mire');
  assert.equal(await run(0), false, 'sin gracia no deberÃ­an jugar sin pÃºblico');
  console.log('ok     sin gracia, en pausa hasta que alguien abre la mesa');
}
main().then(() => { console.log('todo correcto'); process.exit(0); }).catch(e => { console.error('FALLO', e.message); process.exit(1); });
