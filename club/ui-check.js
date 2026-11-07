'use strict';
/* Plays through the real page in Edge beside simulated friends and saves screenshots. */
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const CLUB = 'C:\\Users\\DANIEL\\TEST REA\\club', OUT = path.join(__dirname, 'shots');
const PORT = 18081, BASE = `http://127.0.0.1:${PORT}`, DEBUG = 9333;
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(fs.existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
const dataFile = path.join(os.tmpdir(), `club-ui-${process.pid}.json`), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'club-edge-'));
const bootServer = () => spawn(process.execPath, ['server.js'], { cwd: CLUB, env: { ...process.env, PORT, DATA_FILE: dataFile, ADMIN_OPEN: '1', PAUSE_MS: '2500', START_MS: '300', BOT_MIN_MS: '700' }, stdio: 'ignore' });
let server = bootServer();
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });

class Friend {
  constructor(name) { this.name = name; }
  async req(url, body) {
    const res = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) }, body: JSON.stringify(body) });
    const c = res.headers.get('set-cookie');
    if (c) this.cookie = c.split(';')[0];
    return res.json();
  }
  async join(code, table, seat) {
    await this.req('/api/login', { name: this.name });
    await this.req('/api/do', { op: 'joinClub', code });
    await this.req('/api/do', { op: 'sit', club: code, table, seat, buyIn: 5000 });
    const res = await fetch(`${BASE}/api/stream?club=${code}&table=${table}`, { headers: { Cookie: this.cookie } });
    (async () => {
      let buf = '';
      const dec = new TextDecoder();
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          if (!line.startsWith('data: ')) continue;
          const t = JSON.parse(line.slice(6)).table;
          if (t?.legal && !this.busy) {
            this.busy = true;
            setTimeout(async () => {
              await this.req('/api/do', { op: 'act', club: code, table, type: t.legal.check ? 'check' : 'call' });
              this.busy = false;
            }, 120);
          }
        }
      }
    })().catch(() => {});
  }
}

async function main() {
  let targets;
  for (let i = 0; i < 50 && !targets; i++) { await sleep(200); targets = await fetch(`http://127.0.0.1:${DEBUG}/json/list`).then(r => r.json()).catch(() => null); }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let id = 0;
  const waiting = new Map(), problems = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id) { waiting.get(m.id)(m); waiting.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(m.params.args.map(a => a.value ?? a.description).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/fonts\.g/.test(m.params.entry.url ?? '')) problems.push(`${m.params.entry.text} ${m.params.entry.url ?? ''}`);
  };
  const cdp = (method, params = {}) => new Promise(r => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const js = async expr => {
    const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(`${expr}: ${r.result.exceptionDetails.exception?.description}`);
    return r.result.result.value;
  };
  const until = async (expr, label, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await js(expr)) return; await sleep(80); }
    throw new Error(`no ocurriÃ³: ${label}`);
  };
  const shot = async name => {
    const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
  };
  const layout = () => js(`(() => {
    const over = document.documentElement.scrollWidth - innerWidth;
    const rects = [...document.querySelectorAll('.seat, .center')].map(n => ({ n: n.dataset.seat || n.className, r: n.getBoundingClientRect() }));
    const hits = [];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i].r, b = rects[j].r;
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) hits.push(rects[i].n + ' / ' + rects[j].n);
    }
    const felt = document.querySelector('.felt')?.getBoundingClientRect();
    const out = felt ? rects.filter(x => x.r.left < felt.left - 1 || x.r.right > felt.right + 1 || x.r.top < felt.top - 1 || x.r.bottom > felt.bottom + 1).map(x => x.n) : [];
    return { horizontalOverflow: over, overlaps: hits, outsideTable: out };
  })()`);
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Log.enable');
  await cdp('Page.navigate', { url: BASE });
  await until(`!!document.querySelector('#name')`, 'pantalla de entrada');
  await shot('1-entrada');
  await js(`document.querySelector('#name').value = 'Daniel'; document.querySelector('form').requestSubmit()`);
  await until(`!!document.querySelector('#clubName')`, 'lista de clubes');
  await js(`document.querySelector('#clubName').value = 'Los viernes'; document.querySelector('#clubName').form.requestSubmit()`);
  await until(`!!document.querySelector('#clubCodeShown')`, 'pantalla del club');
  await js(`document.querySelector('#tableName').form.requestSubmit()`);
  await until(`!!document.querySelector('a[href*="/"][href^="#club"]')`, 'mesa creada');
  await shot('2-club');
  const code = await js(`document.querySelector('#clubCodeShown').textContent`);
  await js(`location.hash = document.querySelector('a[href^="#club/"]').getAttribute('href')`);
  await until(`!!document.querySelector('#felt')`, 'mesa');
  const table = await js(`location.hash.split('/')[2]`);
  await js(`document.querySelector('.sit').click()`);
  await until(`!!document.querySelector('#buyIn')`, 'diÃ¡logo de fichas');
  await js(`document.querySelector('#sitConfirm').click()`);
  await until(`!document.querySelector('.sit') || document.querySelectorAll('[data-seat]').length === 1`, 'sentado');
  for (const [i, name] of ['Ana LucÃ­a', 'Beto', 'Carolina', 'Dani', 'Fernanda'].entries()) await new Friend(name).join(code, table, i + 1);
  await until(`!document.getElementById('actions').hidden`, 'mi turno');
  await shot('3-mesa-escritorio');
  const report = { escritorio: await layout() };

  /* two hands through the buttons: one raise, then calls */
  await js(`document.querySelector('.sizes button:nth-child(1)').click()`);
  const label = await js(`document.querySelector('#raiseBtn')?.textContent`);
  report.botonSubida = label;
  await js(`document.querySelector('#raiseBtn').click()`);
  for (let i = 0; i < 60; i++) {
    await until(`!document.getElementById('actions').hidden || [...document.querySelectorAll('.list button.link')].length >= 2`, 'turno o manos terminadas', 30000);
    if (await js(`document.querySelectorAll('.list button.link').length >= 2`)) break;
    await js(`(document.querySelector('#checkBtn') || document.querySelector('#callBtn')).click()`);
    await sleep(200);
    if (await js(`!!document.querySelector('.seat.win')`)) await shot('4-final-mano');
  }
  await until(`!!document.querySelector('.list button.link')`, 'historial');
  await js(`document.querySelector('.list button.link').click()`);
  await until(`!!document.querySelector('dialog.review')`, 'repaso');
  await shot('5-repaso');
  report.repaso = await js(`document.querySelector('dialog.review').innerText.slice(0, 240)`);
  await js(`document.querySelector('dialog.review').close()`);

  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(300);
  await shot('6-oscuro-escritorio');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 400, height: 860, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  await until(`!document.getElementById('actions').hidden`, 'turno en celular', 30000);
  report.celular = await layout();
  await shot('7-oscuro-celular');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await sleep(300);
  await shot('8-claro-celular');
  report.invitacion = await fetch(`${BASE}/api/me`).then(() => js(`view.network`));

  /* the page must notice a dropped server and come back to the same seat by itself */
  const before = await js(`view.table.mySeat`);
  await new Promise(r => { server.once('exit', r); server.kill(); });
  await until(`!document.getElementById('status').hidden`, 'aviso de conexiÃ³n perdida', 15000);
  server = bootServer();
  await until(`document.getElementById('status').hidden`, 'reconexiÃ³n automÃ¡tica', 30000);
  report.reconexion = { avisoYRegreso: true, mismoAsiento: before === await js(`view.table.mySeat`) };
  problems.length = 0;                         /* the refused requests during the outage are expected */
  report.errores = [...new Set(problems.map(p => p.slice(0, 200)))].slice(0, 10);
  console.log(JSON.stringify(report, null, 1));
}
main().catch(e => { console.error('FALLO', e.message); process.exitCode = 1; }).finally(async () => {
  server.kill(); edge.kill();
  await sleep(800);
  fs.rmSync(dataFile, { force: true });
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Edge may still hold it */ }
  process.exit();
});
