'use strict';
/* Only someone with the admin password can create clubs; players still join with a code. */
const assert = require('assert'), os = require('os'), fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const PORT = 18102, BASE = `http://127.0.0.1:${PORT}`, DATA = path.join(os.tmpdir(), `club-ad-${process.pid}.json`);
const server = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, DATA_FILE: DATA }, stdio: ['ignore', 'pipe', 'inherit'] });
class P {
  async login(name) { const r = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); this.cookie = r.headers.get('set-cookie').split(';')[0]; this.me = await r.json(); return this; }
  async api(url, body) { const r = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: this.cookie }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; }
  do(op, f = {}) { return this.api('/api/do', { op, ...f }); }
  async me2() { const r = await fetch(`${BASE}/api/me`, { headers: { Cookie: this.cookie } }); return r.json(); }
}
async function main() {
  await new Promise(r => server.stdout.once('data', r));
  const a = await new P().login('Dueño'), b = await new P().login('Amigo');

  assert.equal((await a.do('createClub', { name: 'X' })).status, 400, 'creó club sin ser admin');
  console.log('ok     sin la clave, nadie crea clubes');

  assert.equal((await a.api('/api/admin', { password: 'otra-cosa' })).status, 400, 'aceptó clave incorrecta');
  assert.equal((await a.api('/api/admin', { password: 'MilthoN1204' })).status, 200, 'no aceptó la clave correcta');
  assert.equal((await a.me2()).admin, true, 'no quedó como admin');
  const made = await a.do('createClub', { name: 'Los viernes' });
  assert.equal(made.status, 200, 'el admin no pudo crear club');
  console.log('ok     con la clave correcta, el admin crea clubes');

  /* a player without the password cannot create, but can join */
  assert.equal((await b.api('/api/admin', { password: 'otra' })).status, 400, 'aceptó clave incorrecta');
  assert.equal((await b.do('createClub', { name: 'Y' })).status, 400, 'un jugador creó club');
  assert.equal((await b.do('joinClub', { code: made.body.code })).status, 200, 'un jugador no pudo unirse');
  console.log('ok     un jugador sin la clave no crea clubes pero sí se une');

  /* the password persists across restart */
  await new Promise(r => setTimeout(r, 500));             /* let the debounced save flush to disk */
  server.kill(); await new Promise(r => setTimeout(r, 400));
  const s2 = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, DATA_FILE: DATA }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise(r => s2.stdout.once('data', r));
  assert.equal((await a.me2()).adminSet, true, 'la clave se perdió al reiniciar');
  assert.equal((await a.me2()).admin, true, 'el admin perdió su sesión al reiniciar');
  s2.kill();
  console.log('ok     la clave y la sesión de admin sobreviven al reinicio');
}
main().then(() => { fs.rmSync(DATA, { force: true }); console.log('todo correcto'); process.exit(0); })
  .catch(e => { console.error('FALLO', e.message); server.kill(); process.exit(1); });
