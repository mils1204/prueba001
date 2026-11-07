'use strict';
/* Plays a practice table through the real page in Edge and saves screenshots to shots/. */
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const OUT = path.join(__dirname, 'shots'), PORT = 18084, BASE = `http://127.0.0.1:${PORT}`, DEBUG = 9334;
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(fs.existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
const dataFile = path.join(os.tmpdir(), `club-uibot-${process.pid}.json`), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'club-edge-'));
const server = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, DATA_FILE: dataFile, ADMIN_OPEN: '1', PAUSE_MS: '1500', START_MS: '300', BOT_MIN_MS: '700' }, stdio: 'ignore' });
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=1200,900', 'about:blank'], { stdio: 'ignore' });

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
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') problems.push(m.params.entry.text);
  };
  const cdp = (method, params = {}) => new Promise(r => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const js = async expr => {
    const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(`${expr}: ${r.result.exceptionDetails.exception?.description}`);
    return r.result.result.value;
  };
  const until = async (expr, label, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await js(expr)) return; await sleep(80); }
    throw new Error(`no ocurriÃ³: ${label}`);
  };
  /* going broke leaves the table, so sit down again as a person would */
  const waitTurn = async (done, label, ms = 45000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await js(`!document.getElementById('actions').hidden || ${done}`)) return;
      await js(`document.querySelector('.sit')?.click()`);
      await sleep(100);
    }
    throw new Error(`no ocurriÃ³: ${label}`);
  };
  const shot = async name => {
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
  };
  await cdp('Runtime.enable'); await cdp('Page.enable'); await cdp('Log.enable');
  await cdp('Page.navigate', { url: BASE });
  await until(`!!document.querySelector('#name')`, 'entrada');
  await js(`document.querySelector('#name').value = 'Daniel'; document.querySelector('form').requestSubmit()`);
  await until(`!!document.querySelector('#clubName')`, 'clubes');
  await js(`document.querySelector('#clubName').value = 'PrÃ¡ctica'; document.querySelector('#clubName').form.requestSubmit()`);
  await until(`!!document.querySelector('#tablePractice')`, 'club');
  await js(`document.querySelector('#grantAmount').value = '12.5'; document.querySelector('#grantAmount').form.requestSubmit()`);
  await until(`document.body.innerText.includes('12,50')`, 'reparto en decimales');
  console.log('reparto de fichas: saldo muestra 12,50 =', await js(`document.body.innerText.includes('12,50')`));
  await js(`document.querySelector('#tablePractice').click()`);
  const fieldState = pick => js(`(() => { const b = document.querySelector('#tableBots'); b.value = '${'${pick}'}'; b.dispatchEvent(new Event('change')); return { personas: document.querySelector('#tablePeople').options.length, oculto: document.getElementById('peopleField').hidden, ciega: document.querySelector('#tableBb').closest('label').hidden, entrada: document.querySelector('#tableDepth').closest('label').hidden, camposDeNombre: [...document.querySelectorAll('#botNameField label')].map(n => n.firstChild.textContent) }; })()`.replace('${pick}', pick));
  for (const pick of ['trained', '1', '2', '5']) console.log('formulario', pick, JSON.stringify(await fieldState(pick)));
  await js(`document.querySelector('#tableBots').value = '${process.argv[2] || 2}'; document.querySelector('#tableBots').dispatchEvent(new Event('change'));`);
  await js(`document.querySelector('#tableBotName1').value = 'Luna'; document.querySelector('#tableRake').value = '3'`);
  await js(`document.querySelector('#tableCategory').value = '${process.argv[3] || ''}'; document.querySelector('#tableCategory').dispatchEvent(new Event('change'));`);
  await js(` document.querySelector('#tableName').value = 'Contra bots'; document.querySelector('#tableName').form.requestSubmit()`);
  await until(`!!document.querySelector('a[href^="#club/"]')`, 'mesa creada');
  await shot('bot-1-club');
  await js(`location.hash = document.querySelector('a[href^="#club/"]').getAttribute('href')`);
  await until(`!!document.querySelector('.sit')`, 'asiento');
  await js(`document.querySelector('.sit').click()`);
  await until(`!document.getElementById('actions').hidden`, 'mi turno');
  await shot('bot-2-mi-turno');
  console.log('bots en la mesa', JSON.stringify(await js(`[...document.querySelectorAll('.seat[data-seat]')].map(n => n.dataset.seat)`)));
  console.log('montos', JSON.stringify(await js(`({ bote: document.querySelector('.pot').textContent, igualar: document.querySelector('#callBtn')?.textContent, subir: document.querySelector('#raiseBtn')?.textContent, exacto: document.querySelector('#raiseTo')?.value, pila: document.querySelector('[data-seat="Daniel"] .chips').textContent })`)));
  await js(`document.querySelector('.sizes button:nth-child(2)').click(); document.querySelector('#raiseBtn').click()`);
  await sleep(400);
  let sawThinking = false;
  for (let i = 0; i < 80 && await js(`document.querySelectorAll('.list button.link').length`) < 3; i++) {
    await waitTurn(`document.querySelectorAll('.list button.link').length >= 3`, 'turno');
    if (await js(`!document.getElementById('actions').hidden`)) await js(`(document.querySelector('#checkBtn') || document.querySelector('#callBtn')).click()`);
    await sleep(120);
    if (!sawThinking && await js(`!!document.querySelector('.seat.turn:not([data-seat="Daniel"]) #clock')`)) {
      sawThinking = true;
      const first = await js(`document.querySelector('.seat.turn #clock')?.getBoundingClientRect().width ?? 0`);
      await sleep(300);
      const second = await js(`document.querySelector('.seat.turn #clock')?.getBoundingClientRect().width ?? 0`);
      console.log('barra del bot:', Math.round(first), '->', Math.round(second));
      await shot('bot-3-pensando');
    }
  }
  await until(`!!document.querySelector('.list button.link')`, 'historial');
  await shot('bot-4-final');
  await js(`document.querySelector('#botSeesBtn').click()`);
  await until(`document.querySelector('#botSeesBtn').textContent === 'ON'`, 'botÃ³n del bot tramposo');
  const button = await js(`document.querySelector('#botSeesBtn').textContent`);
  console.log('chino en la mesa fuera del botÃ³n:', await js(`/[\\u4e00-\\u9fff]/.test(document.getElementById('felt').innerText + document.getElementById('reviewBox').innerText)`));
  await js(`document.querySelector('.list button.link').click()`);
  await until(`!!document.querySelector('dialog.review')`, 'repaso');
  await sleep(300);
  await shot('bot-5-repaso');
  const study = await js(`[...document.querySelectorAll('dialog.review .muted li')].slice(0, 4).map(n => n.textContent)`);
  await js(`document.querySelector('dialog.review').close()`);
  console.log(JSON.stringify({ button, avisoOcultoEnMesaIndividual: await js(`document.getElementById('botSeesNote').hidden`), repasoPlegado: await js(`!document.getElementById('reviewBox').open`), study }, null, 1));
  for (const [width, height] of [[400, 860], [360, 640]]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
    await sleep(500);
    await waitTurn('false', `turno en ${width}x${height}`);
    await sleep(200);
    await js(`scrollTo(0, 0)`);
    await sleep(150);
    await shot(`bot-celular-${height}`);
    console.log(`${width}x${height}`, JSON.stringify(await js(`(() => {
      const a = document.getElementById('actions').getBoundingClientRect();
      const me = document.querySelector('[data-seat="Daniel"] .cards').getBoundingClientRect();
      const buttons = [...document.querySelectorAll('#actions .main button')].map(b => b.getBoundingClientRect());
      const spots = [...document.querySelectorAll('.seat[data-seat]')].map(n => ({ n: n.dataset.seat, r: n.getBoundingClientRect() })), hits = [];
      for (let i = 0; i < spots.length; i++) for (let j = i + 1; j < spots.length; j++) {
        const p = spots[i].r, q = spots[j].r;
        if (p.left < q.right - 1 && q.left < p.right - 1 && p.top < q.bottom - 1 && q.top < p.bottom - 1) hits.push(spots[i].n + '/' + spots[j].n);
      }
      return { botonesVisibles: buttons.every(b => b.top >= 0 && b.bottom <= innerHeight), panelAlto: Math.round(a.height), cartasFondo: Math.round(me.bottom), panelTope: Math.round(a.top), tapaCartas: me.bottom > a.top, solapes: hits };
    })()`)));
    await js(`(document.querySelector('#checkBtn') || document.querySelector('#callBtn')).click()`);
    await sleep(300);
  }
  const finalNote = await js(`document.getElementById('practiceNote')?.textContent ?? ''`);
  const manos = await js(`document.querySelectorAll('.list button.link').length`);
  const overflow = await js(`document.documentElement.scrollWidth - innerWidth`);
  await js(`location.hash = location.hash.split('/').slice(0, 2).join('/')`);
  await until(`!!document.querySelector('#deleteTables')`, 'botÃ³n eliminar');
  console.log('comisiÃ³n en lista y pozo:', JSON.stringify(await js(`({ enLista: document.querySelector('ul.list').innerText.includes('3% comisiÃ³n'), pozo: document.getElementById('clubPool')?.textContent })`)));
  const disabledFirst = await js(`document.querySelector('#deleteTables').disabled`);
  await js(`document.querySelector('ul.list input[type=checkbox]').click()`);     /* mark the first table */
  await until(`!document.querySelector('#deleteTables').disabled`, 'botÃ³n se habilita al marcar');
  await js(`document.querySelector('#deleteTables').click()`);
  await until(`!!document.querySelector('#deleteConfirm')`, 'confirmaciÃ³n');
  await shot('bot-6-eliminar');
  await js(`document.querySelector('#deleteConfirm').click()`);
  await until(`document.body.innerText.includes('Abre la primera mesa')`, 'mesa eliminada');
  console.log('eliminar mesa marcada por la pÃ¡gina: correcto | botÃ³n empezaba deshabilitado =', disabledFirst);
  console.log(JSON.stringify({
    manos,
    nota: finalNote,
    vioPensando: sawThinking,
    desbordeCelular: overflow,
    errores: [...new Set(problems)].slice(0, 5),
  }, null, 1));
}
main().catch(e => { console.error('FALLO', e.message); process.exitCode = 1; }).finally(async () => {
  server.kill(); edge.kill();
  await sleep(800);
  fs.rmSync(dataFile, { force: true });
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Edge may still hold it */ }
  process.exit();
});
