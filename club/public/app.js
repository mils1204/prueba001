'use strict';
/* Browser client. The server owns all state: this file draws what arrives and sends orders. */
const app = document.getElementById('app'), toastBox = document.getElementById('toast');
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUITS = ['♠', '♥', '♦', '♣'];
const ACTIONS = { sb: 'ciega pequeña', bb: 'ciega grande', fold: 'se retira', check: 'pasa', call: 'iguala', bet: 'apuesta', raise: 'sube a' };
const STREET_NAMES = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' };
/* Optional Chinese for "Solo yo" tables, switched off. */
const CHINESE_TABLES = false;
const ACTIONS_ZH = { sb: '小盲注', bb: '大盲注', fold: '弃牌', check: '过牌', call: '跟注', bet: '下注', raise: '加注到' };
const STREETS_ZH = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌' };
const HANDS_ZH = { 'Carta alta': '高牌', Pareja: '一对', 'Doble pareja': '两对', 'Trío': '三条', Escalera: '顺子', Color: '同花', Full: '葫芦', 'Póker': '四条', 'Escalera de color': '同花顺' };
const chinese = () => CHINESE_TABLES && !!view?.table?.practice && view.table.people === 1;
const tr = (spanish, zh) => (chinese() ? zh : spanish);
const handName = name => tr(name, HANDS_ZH[name] ?? name);
const actionName = type => (chinese() ? ACTIONS_ZH : ACTIONS)[type];
/* Seat spots around the table, as left% / top%. Index 0 is the bottom, where you sit. */
const SPOTS = {
  2: [[50, 86], [50, 14]],
  3: [[50, 86], [14, 26], [86, 26]],
  4: [[50, 86], [12, 50], [50, 14], [88, 50]],
  5: [[50, 86], [12, 62], [22, 16], [78, 16], [88, 62]],
  6: [[50, 86], [12, 66], [12, 24], [50, 14], [88, 24], [88, 66]],
};
/* On a phone the table is tall, so side seats sit above and below the board instead of beside it. */
const PHONE_SPOTS = {
  2: [[50, 87], [50, 13]],
  3: [[50, 87], [22, 14], [78, 14]],
  4: [[50, 87], [16, 71], [50, 13], [84, 71]],
  5: [[50, 87], [16, 71], [16, 23], [84, 23], [84, 71]],
  6: [[50, 87], [16, 71], [16, 25], [50, 12], [84, 25], [84, 71]],
};
const phone = window.matchMedia('(max-width: 640px)');

let me = null, view = null, source = null, screen = '', shell = null, legalKey = '', clockEnd = 0, clockTotal = 1, offline = false;

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'style') Object.assign(node.style, value);      /* the CSP blocks style attributes, not the style object */
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  node.append(...kids.flat().filter(k => k != null && k !== false));
  return node;
}
/* Every chip amount is stored as an integer number of hundredths; the page always shows 2 decimals. */
function chips(n) {
  return (Number(n) / 100).toLocaleString('es', { useGrouping: 'always', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const bbs = n => Number(n).toLocaleString('es', { maximumFractionDigits: 1 });   /* a count of big blinds, not money */
function toast(text) {
  toastBox.textContent = text;
  toastBox.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { toastBox.hidden = true; }, 3500);
}
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}
async function send(op, fields = {}) {
  try {
    return await post('/api/do', { op, club: route().club, table: route().table, ...fields });
  } catch (err) {
    toast(err.message);
    return null;
  }
}
function route() {
  const [kind, a, b] = location.hash.slice(1).split('/');
  if (kind === 'club') return { club: a, table: b };
  if (kind === 'join') return { join: a };
  return {};
}
function connect() {
  source?.close();
  const { club = '', table = '' } = route();
  source = new EventSource(`/api/stream?club=${encodeURIComponent(club)}&table=${encodeURIComponent(table)}`);
  source.onmessage = event => { offline = false; view = JSON.parse(event.data); draw(); };
  source.onerror = () => { offline = true; drawStatus(); };
}
function drawStatus() {
  const box = document.getElementById('status');
  if (box) box.hidden = !offline;
}
const statusBar = () => el('p', { id: 'status', class: 'banner', hidden: !offline }, 'Conexión perdida. Reconectando…');

/* ---------- Screens ---------- */
function drawLogin() {
  const name = el('input', { maxlength: 20, required: true, autocomplete: 'nickname', id: 'name' });
  app.replaceChildren(el('form', {
    class: 'panel login', onsubmit: async e => {
      e.preventDefault();
      try { me = await post('/api/login', { name: name.value }); start(); } catch (err) { toast(err.message); }
    },
  },
    el('h1', {}, 'Mano a Mano Club'),
    el('p', { class: 'muted' }, 'Póker entre amigos con fichas virtuales. Las fichas no tienen valor.'),
    el('label', {}, 'Tu nombre en la mesa', name),
    el('button', { class: 'primary' }, 'Entrar')));
  name.focus();
}
function header(title, back) {
  return el('header', { class: 'row between' },
    el('div', { class: 'stack' },
      back ? el('a', { href: back[0], class: 'back' }, `← ${back[1]}`) : el('span', { class: 'brand' }, 'Mano a Mano Club'),
      el('h1', {}, title)),
    el('span', { class: 'muted small' }, view.me.name));
}
function drawHome() {
  if (screen !== 'home') {
    screen = 'home';
    const name = el('input', { maxlength: 20, required: true, id: 'clubName' }), code = el('input', { maxlength: 6, required: true, id: 'clubCode', autocapitalize: 'characters' });
    const pass = el('input', { type: 'password', required: true, maxlength: 40, id: 'adminPass' });
    shell = { grid: el('div', { class: 'club-grid' }) };
    const createForm = el('form', {
      class: 'panel', onsubmit: async e => {
        e.preventDefault();
        const r = await send('createClub', { name: name.value });
        if (r) location.hash = `club/${r.code}`;
      },
    }, el('h2', {}, 'Crear un club'), el('label', {}, 'Nombre', name), el('button', { class: 'primary' }, 'Crear'));
    const adminForm = el('form', {
      class: 'panel', onsubmit: async e => {
        e.preventDefault();
        try { await post('/api/admin', { password: pass.value }); screen = ''; connect(); } catch (err) { toast(err.message); }
      },
    }, el('h2', {}, view.adminSet ? 'Entrar como administrador' : 'Crear clave de administrador'),
      el('p', { class: 'small muted' }, view.adminSet ? 'Solo el administrador puede crear clubes.' : 'Elige una clave; con ella podrás crear clubes. Guárdala.'),
      el('label', {}, 'Clave', pass), el('button', { class: 'primary' }, view.adminSet ? 'Entrar' : 'Crear clave'));
    app.replaceChildren(statusBar(),
      el('div', { class: 'hero' },
        el('div', {}, el('div', { class: 'brand-lg' }, 'Mano a Mano Club'), el('p', {}, 'Póker entre amigos y práctica con bots · fichas virtuales')),
        el('div', { class: 'who' }, el('div', {}, view.me.name), view.me.admin ? el('div', { class: 'adminbadge' }, 'Administrador') : null),
        el('div', { class: 'suits', 'aria-hidden': 'true' }, '♠♥♦♣')),
      el('div', { class: 'lobby-head' }, el('h1', {}, 'Tus clubes')),
      shell.grid,
      el('div', { class: 'cols' },
        view.me.admin ? createForm : adminForm,
        el('form', {
          class: 'panel', onsubmit: async e => {
            e.preventDefault();
            const r = await send('joinClub', { code: code.value });
            if (r) location.hash = `club/${r.code}`;
          },
        }, el('h2', {}, 'Unirme con un código'), el('label', {}, 'Código de 6 letras', code), el('button', {}, 'Unirme'))));
  }
  shell.grid.replaceChildren(...(view.clubs.length ? view.clubs.map(c => el('a', { class: 'club-card', href: `#club/${c.code}` },
    el('div', { class: 'strip' }),
    el('div', { class: 'in' },
      el('div', { class: 'top' }, el('h2', {}, c.name), el('span', { class: 'pips' }, '♠♥♦♣')),
      el('div', { class: 'meta' },
        el('span', { class: 'active' }, el('span', { class: 'dot on' }), `Miembros Activos ${c.active}`),
        el('span', { class: 'cardbal' }, chips(c.balance))),
      el('span', { class: 'enter' }, 'Entrar →')))) : [el('p', { class: 'muted' }, 'Aún no estás en ningún club. Crea uno con la clave de administrador, o usa el código de un amigo.')]));
}
function copyInvite(text, field) {
  const fallback = () => { field.select(); toast('Selecciona el enlace y cópialo'); };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Enlace copiado'), fallback);
  else fallback();
}
function drawClub() {
  const c = view.club;
  if (screen !== `club:${c.code}`) {
    screen = `club:${c.code}`;
    app.classList.remove('at-table');
    const danger = el('div', { class: 'stack', id: 'deleteBox' });
    const selected = new Set();
    const renderDanger = () => {
      for (const id of [...selected]) if (!c.tables.some(t => t.id === id)) selected.delete(id);   /* drop ids that are already gone */
      const n = selected.size;
      if (shell.confirming && n) {
        danger.replaceChildren(
          el('span', { class: 'small' }, `Se ${n === 1 ? 'borrará la mesa marcada' : `borrarán las ${n} mesas marcadas`} y su historial. No se puede deshacer. Las fichas del club que estén en una mesa vuelven a su dueño.`),
          el('div', { class: 'row' },
            el('button', { class: 'primary', id: 'deleteConfirm', onclick: async () => { const ids = [...selected]; shell.confirming = false; selected.clear(); await send('deleteTables', { ids }); renderDanger(); } }, `Sí, eliminar (${n})`),
            el('button', { onclick: () => { shell.confirming = false; renderDanger(); } }, 'Cancelar')));
      } else {
        shell.confirming = false;
        danger.replaceChildren(el('button', { id: 'deleteTables', disabled: n === 0, onclick: () => { shell.confirming = true; renderDanger(); } },
          n ? `Eliminar seleccionadas (${n})` : 'Marca las mesas a eliminar'));
      }
    };
    shell = { danger, selected, renderDanger, confirming: false, tables: el('ul', { class: 'list' }), members: el('ul', { class: 'list' }), ledger: el('ul', { class: 'list small' }), balance: el('p', { class: 'mono saldo' }), pot: el('p', { class: 'mono saldo', id: 'clubPool' }), select: el('select', { id: 'grantTo' }) };
    const onThisPc = ['localhost', '127.0.0.1'].includes(location.hostname);
    const link = `${onThisPc && view.network ? view.network : location.origin}/#join/${c.code}`, invite = el('input', { readonly: true, value: link, 'aria-label': 'Enlace de invitación' });
    const tableName = el('input', { maxlength: 20, required: true, value: 'Mesa 1', id: 'tableName' });
    const seats = el('select', { id: 'tableSeats' }, [2, 3, 4, 5, 6].map(n => el('option', { value: n, selected: n === 6 }, n)));
    const bb = el('input', { type: 'number', min: 0.02, step: 'any', value: 1, required: true, id: 'tableBb' }), turn = el('input', { type: 'number', min: 10, max: 120, value: 30, required: true, id: 'tableTurn' });
    const rake = el('input', { type: 'number', min: 0, max: 5, value: 0, required: true, id: 'tableRake' });
    const amount = el('input', { type: 'number', step: 'any', required: true, placeholder: '50,00 o -50,00', id: 'grantAmount' });
    const practice = el('input', { type: 'checkbox', id: 'tablePractice' });
    const category = el('select', { id: 'tableCategory' },
      el('option', { value: '' }, 'Elegir ciega'), el('option', { value: 'micro' }, '0,05 / 0,10'), el('option', { value: 'low' }, '0,25 / 0,50'), el('option', { value: 'mid' }, '0,50 / 1'));
    const categoryField = el('label', { hidden: true }, 'Categoría', category);
    const depth = el('input', { type: 'number', min: 25, max: 500, value: 100, required: true, id: 'tableDepth' });
    const seatsField = el('label', {}, 'Asientos', seats), bbField = el('label', {}, 'Ciega grande (BB)', bb), depthField = el('label', { hidden: true }, 'Entrada en BB', depth);
    const humanFields = el('div', { class: 'formgrid' }, seatsField, categoryField, bbField, depthField);
    const bots = el('select', { id: 'tableBots' },
      el('option', { value: 'trained' }, '1 bot entrenado'), [1, 2, 3, 4, 5].map(n => el('option', { value: n, selected: n === 2 }, `${n} ${n === 1 ? 'bot' : 'bots'} con reglas`)));
    const people = el('select', { id: 'tablePeople' });
    const peopleField = el('label', { id: 'peopleField' }, 'Personas', people);
    const nameInputs = [1, 2, 3, 4, 5].map(n => el('input', { id: `tableBotName${n}`, maxlength: 20, placeholder: 'Kiko Bot' }));
    const botNameField = el('div', { class: 'stack', id: 'botNameField' });
    const botCount = () => (bots.value === 'trained' ? 1 : Number(bots.value));
    const botFields = el('div', { class: 'stack', hidden: true }, el('label', {}, 'Rivales', bots), botNameField, peopleField);
    /* The trained bot only knows 100 BB deep, but any even big blind works: its strategy depends on proportions. */
    const fitForm = () => {
      const trained = practice.checked && bots.value === 'trained';
      /* six seats in total, and the trained bot only ever faces one person */
      const room = bots.value === 'trained' ? 1 : 6 - Number(bots.value), chosen = Math.min(Number(people.value) || 1, room);
      people.replaceChildren(...Array.from({ length: room }, (_, i) => el('option', { value: i + 1 }, i === 0 ? 'Solo yo' : `${i + 1} personas`)));
      people.value = chosen;
      peopleField.hidden = trained;
      botNameField.replaceChildren(...nameInputs.slice(0, botCount()).map((input, i) => el('label', {}, botCount() === 1 ? 'Nombre del Bot' : `Nombre del Bot ${i + 1}`, input)));
      seatsField.hidden = practice.checked;
      categoryField.hidden = !practice.checked;
      bbField.hidden = practice.checked && category.value !== '';
      depthField.hidden = !practice.checked || trained;
      botFields.hidden = !practice.checked;
      bb.required = !bbField.hidden;                 /* a hidden preset blind must not block the form */
      depth.required = practice.checked && !trained;
    };
    [practice, bots, category].forEach(field => field.addEventListener('change', fitForm));
    fitForm();
    app.replaceChildren(statusBar(), header(c.name, ['#', 'Tus clubes']),
      el('section', { class: 'panel' },
        el('div', { class: 'row between' }, el('span', {}, 'Código para invitar'), el('span', { class: 'code', id: 'clubCodeShown' }, c.code)),
        el('div', { class: 'row' }, invite, el('button', { onclick: () => copyInvite(link, invite) }, 'Copiar enlace')),
        el('div', { class: 'row between' }, el('span', {}, 'Tus fichas fuera de la mesa'), shell.balance),
        c.isOwner ? el('div', { class: 'row between' }, el('span', {}, 'Pozo del club (comisión)'), shell.pot) : null),
      el('section', { class: 'panel' }, el('h2', {}, 'Mesas'), shell.tables, c.isOwner ? shell.danger : null),
      c.isOwner && el('div', { class: 'cols' },
        el('form', {
          class: 'panel', onsubmit: async e => {
            e.preventDefault();
            await send('createTable', { name: tableName.value, seats: Number(seats.value), bb: Math.round(Number(bb.value) * 100), turn: Number(turn.value), practice: practice.checked, trained: bots.value === 'trained', bots: bots.value === 'trained' ? 1 : Number(bots.value), people: Number(people.value), depth: Number(depth.value), rake: Number(rake.value), category: practice.checked ? category.value : '', botNames: nameInputs.slice(0, botCount()).map(input => input.value) });
          },
        }, el('h2', {}, 'Abrir una mesa'),
        el('label', { class: 'check' }, practice, 'Práctica con bots: ciegas 50/100, sin usar fichas del club'),
        el('div', { class: 'formgrid' }, el('label', {}, 'Nombre', tableName), el('label', {}, 'Segundos por turno', turn), el('label', {}, 'Comisión (%)', rake)), botFields, humanFields,
        el('button', { class: 'primary' }, 'Abrir mesa')),
        el('form', {
          class: 'panel', onsubmit: async e => {
            e.preventDefault();
            if (await send('grant', { memberId: shell.select.value, amount: Math.round(Number(amount.value) * 100) })) amount.value = '';
          },
        }, el('h2', {}, 'Repartir fichas'), el('div', { class: 'formgrid' }, el('label', {}, 'Para', shell.select), el('label', {}, 'Cantidad', amount)), el('button', {}, 'Aplicar'))),
      el('div', { class: 'cols' },
        c.isOwner ? el('section', { class: 'panel' }, el('h2', {}, 'Miembros'), shell.members) : null,
        c.isOwner ? el('section', { class: 'panel' }, el('h2', {}, 'Movimientos de fichas'), shell.ledger) : null));
  }
  shell.balance.textContent = chips(c.balance);
  if (c.isOwner) shell.pot.textContent = chips(c.pot);
  shell.danger.hidden = c.tables.length === 0;
  shell.tables.replaceChildren(...(c.tables.length ? c.tables.map(t => el('li', { class: 'row between' },
    el('div', { class: 'row', style: { gap: '8px' } },
      c.isOwner ? el('input', { type: 'checkbox', 'aria-label': `Marcar ${t.name}`, style: { width: 'auto', margin: 0 }, checked: shell.selected.has(t.id), onchange: e => { e.target.checked ? shell.selected.add(t.id) : shell.selected.delete(t.id); shell.renderDanger(); } }) : null,
      el('a', { href: `#club/${c.code}/${t.id}` }, t.name),
      t.mine ? el('span', { class: 'here' }, 'Estás aquí') : null),
    el('span', { class: 'small muted mono' }, (t.practice ? `BB ${chips(t.bb)} · Entrada mínima ${chips(t.entry)}${t.botSees ? ' · Un bot ve todas las cartas' : ''}` : `${chips(t.sb)}/${chips(t.bb)} · ${t.seated.length}/${t.size} · ${t.turnSeconds} s`) + (t.rake ? ` · ${t.rake}% comisión` : '')))) : [el('li', { class: 'muted' }, c.isOwner ? 'Abre la primera mesa aquí abajo.' : 'Quien creó el club aún no abrió mesas.')]));
  if (c.isOwner) shell.renderDanger();
  shell.members.replaceChildren(...c.members.map(m => el('li', { class: 'stack' },
    el('div', { class: 'row between' },
      el('span', {}, el('span', { class: `dot${m.online ? ' on' : ''}`, title: m.online ? 'Conectado' : 'Desconectado' }), m.name, m.owner ? ' (dueño)' : ''),
      el('span', { class: 'mono small' }, chips(m.balance))),
    c.isOwner
      ? el('label', { class: 'check small' }, el('input', { type: 'checkbox', checked: m.seeCards, 'data-see': m.name, onchange: e => send('setSeeCards', { memberId: m.id, on: e.target.checked }) }), 'Ver cartas de los bots en práctica')
      : m.seeCards ? el('span', { class: 'small muted' }, 'Ve las cartas de los bots en práctica') : null)));
  shell.ledger.replaceChildren(...(c.ledger.length ? c.ledger.map(x => el('li', { class: 'row between' },
    el('span', {}, `${x.name}: ${x.reason}`),
    el('span', { class: `mono ${x.delta > 0 ? 'gain' : 'loss'}` }, `${x.delta > 0 ? '+' : ''}${chips(x.delta)}`))) : [el('li', { class: 'muted' }, 'Sin movimientos.')]));
  if (shell.select.childElementCount !== c.members.length) {
    const kept = shell.select.value;
    shell.select.replaceChildren(...c.members.map(m => el('option', { value: m.id }, m.name)));
    if (kept) shell.select.value = kept;
  }
}

function cardNode(c, slot) {
  if (slot) return el('div', { class: 'card slot', 'aria-hidden': 'true' });
  if (c === null) return el('div', { class: 'card back', role: 'img', 'aria-label': 'Carta oculta' });
  const suit = c & 3;
  return el('div', { class: `card${suit === 1 || suit === 2 ? ' red' : ''}`, role: 'img', 'aria-label': `${RANKS[c >> 2]} ${['picas', 'corazones', 'diamantes', 'tréboles'][suit]}` },
    el('span', {}, RANKS[c >> 2]), el('span', {}, SUITS[suit]));
}
function seatNode(t, seat, index, spot) {
  const [left, top] = spot;
  const style = { left: `${left}%`, top: `${top}%` };
  if (!seat) {
    return el('div', { class: 'seat', style },
      t.mySeat < 0 ? el('button', { class: 'sit', onclick: () => (t.practice || t.reserved !== null ? send('sit', { seat: index }) : askBuyIn(t, index)) }, tr('Sentarme', '入座')) : el('span', { class: 'tag' }, tr('Libre', '空位')));
  }
  const notes = [];
  if (seat.hand) notes.push(handName(seat.hand));
  if (seat.allIn) notes.push(tr('All-in', '全下'));
  if (seat.sittingOut) notes.push(tr('Ausente', '暂离'));
  if (seat.leaving) notes.push(tr('Se va', '即将离座'));
  if (!seat.online && !seat.sittingOut) notes.push(tr('Sin conexión', '已断线'));
  return el('div', { class: `seat${seat.turn ? ' turn' : ''}${seat.folded ? ' folded' : ''}${seat.won > 0 ? ' win' : ''}`, style, 'data-seat': seat.name },
    el('div', { class: 'cards' }, seat.cards.map(c => cardNode(c))),
    el('div', { class: 'plate' },
      seat.dealer && el('span', { class: 'dealer', title: 'Repartidor' }, 'D'),
      el('div', { class: 'name' }, seat.name),
      el('div', { class: 'chips' }, chips(seat.stack)),
      notes.length ? el('div', { class: 'tag' }, notes.join(' · ')) : null,
      seat.turn ? el('div', { class: 'clock', id: 'clock' }) : null),
    el('div', { class: 'bet' }, seat.won > 0 ? `+${chips(seat.won)}` : seat.bet ? chips(seat.bet) : ''));
}
function handMessage(t) {
  const h = t.hand;
  if (!h) return t.seats.filter(Boolean).length < 2 ? tr('Esperando jugadores', '等待玩家') : tr('Empieza la próxima mano', '下一手牌即将开始');
  if (h.done) return h.summary.map(p => `${p.winners.join(tr(' y ', '、'))} ${p.winners.length > 1 ? tr('reparten', '平分') : tr('gana', '赢得')} ${chips(p.amount)}`).join(' · ');
  if (!h.last) return '';
  const verb = actionName(h.last.type);
  return `${h.last.name} ${verb}${['raise', 'bet', 'call'].includes(h.last.type) ? ` ${chips(h.last.type === 'call' ? h.last.amount : h.last.to)}` : ''}`;
}
function drawTable() {
  const t = view.table;
  if (screen !== `table:${t.id}`) {
    screen = `table:${t.id}`;
    legalKey = '';
    shell = { felt: el('div', { class: 'felt', id: 'felt' }), actions: el('section', { class: 'panel actions', id: 'actions', hidden: true }), info: el('div', { class: 'row between' }), history: el('ul', { class: 'list small' }) };
    shell.warning = el('p', { class: 'banner', id: 'botSeesNote', hidden: true }, 'Bot tramposo activado: un bot de esta mesa ve las cartas de todos. 作弊机器人已开启：本桌有一个机器人能看到所有人的牌。');
    const top = header(t.name, [`#club/${view.club.code}`, view.club.name]);
    top.querySelector('h1')?.remove();                 /* the table name now lives inside the felt */
    top.classList.add('compact');
    app.classList.add('at-table');
    app.replaceChildren(statusBar(), top, shell.warning, shell.felt, shell.actions, shell.info,
      el('details', { class: 'panel', id: 'reviewBox' }, el('summary', {}, el('h2', {}, tr('Repaso de manos', '牌局回顾'))), shell.history));
  }
  /* Alone at their own table the owner already has the button; everyone else must still see the warning. */
  shell.warning.hidden = !t.botSees || (t.people === 1 && view.club.isOwner);
  const size = t.size, base = t.mySeat >= 0 ? t.mySeat : 0, h = t.hand;
  const board = h ? h.board : [];
  shell.felt.replaceChildren(
    el('div', { class: 'center' },
      el('div', { class: 'pot' }, h ? `${tr('Bote', '底池')} ${chips(h.pot)}` : `${tr('Ciegas', '盲注')} ${chips(t.sb)}/${chips(t.bb)}`),
      el('div', { class: 'cards', id: 'board' }, [0, 1, 2, 3, 4].map(i => (i < board.length ? cardNode(board[i]) : cardNode(0, true)))),
      el('div', { class: 'message', id: 'message' }, handMessage(t)),
      el('div', { class: 'tablename' }, t.name)),
    ...t.seats.map((seat, i) => seatNode(t, seat, i, (phone.matches ? PHONE_SPOTS : SPOTS)[size][(i - base + size) % size])));
  clockTotal = t.turnSeconds * 1000;
  clockEnd = h && !h.done ? performance.now() + h.remainingMs : 0;
  drawActions(t);
  const mine = t.seats[t.mySeat];
  shell.info.replaceChildren(
    el('div', { class: 'stack' },
      el('span', { class: 'muted small', id: 'handLine' }, h?.demo ? (t.mySeat >= 0 ? tr('Entras en la próxima mano.', '下一手牌入局。') : '') : h ? `${tr(`Mano ${h.no}`, `第 ${h.no} 手`)}${h.done ? '' : ` · ${tr(STREET_NAMES[h.street], STREETS_ZH[h.street])}`}` : tr('Sin mano en juego', '暂无牌局')),
      t.practice && mine ? el('span', { class: 'muted small', id: 'practiceNote' }, `${tr('Sesión', '本局')}: ${mine.net > 0 ? '+' : ''}${bbs(mine.net / t.bb)} ${tr('ciegas', '大盲')}${t.peeking ? tr(' · Ves las cartas de los bots', ' · 你能看到机器人的牌') : ''}`) : null),
    el('div', { class: 'row' },
      t.trained && t.mySeat >= 0 ? el('button', { id: 'alwaysBtn', onclick: () => send('setAlwaysFull', { on: !t.alwaysFull }) }, `Siempre al 100%: ${t.alwaysFull ? 'ON' : 'OFF'}`) : null,
      t.practice && t.size > 2 && view.club.isOwner ? el('button', { id: 'botSeesBtn', onclick: () => send('setBotSees', { on: !t.botSees }) }, t.people === 1 ? (t.botSees ? 'ON' : 'OFF') : `Bot tramposo: ${t.botSees ? 'activado' : 'desactivado'}`) : null,
      mine?.sittingOut ? el('button', { class: 'primary', onclick: () => send('back') }, tr('Volver a jugar', '继续游戏')) : null,
      mine ? el('button', { disabled: mine.leaving, onclick: () => send('stand') }, mine.leaving ? tr('Saldrás al terminar la mano', '本手结束后离座') : tr('Levantarme', '离座')) : null));
  shell.history.replaceChildren(...(t.history.length ? t.history.map(x => el('li', { class: 'row between' },
    el('button', { class: 'link', onclick: () => review(x.no) }, `${tr(`Mano ${x.no}`, `第 ${x.no} 手`)}: ${x.winners.join(', ') || tr('sin ganador', '无赢家')}`),
    el('span', { class: `mono ${x.mine > 0 ? 'gain' : x.mine < 0 ? 'loss' : 'muted'}` }, x.mine ? `${x.mine > 0 ? '+' : ''}${chips(x.mine)}` : chips(x.pot)))) : [el('li', { class: 'muted' }, tr('Aún no se jugó ninguna mano.', '还没有牌局。'))]));
}
function drawActions(t) {
  const l = t.legal;
  const key = l ? JSON.stringify([t.hand.no, t.hand.street, l]) : '';
  if (key === legalKey) return;
  legalKey = key;
  shell.actions.hidden = !l;
  if (!l) return shell.actions.replaceChildren();
  const send_ = (type, to) => { shell.actions.hidden = true; legalKey = ''; send('act', { type, to }); };
  const kids = [];
  if (l.canRaise) {
    const range = el('input', { type: 'range', min: l.minTo, max: l.maxTo, value: l.minTo, step: 1, 'aria-label': 'Tamaño de la apuesta' });
    const shown = value => (value / 100).toFixed(2), typed = value => Math.round(value * 100);
    const exact = el('input', { type: 'number', min: shown(l.minTo), max: shown(l.maxTo), value: shown(l.minTo), step: 0.01, id: 'raiseTo', 'aria-label': 'Apuesta exacta' });
    const raise = el('button', { class: 'primary', id: 'raiseBtn' });
    const set = value => {
      const to = Math.max(l.minTo, Math.min(l.maxTo, Math.round(value) || l.minTo));
      range.value = to; exact.value = shown(to);
      raise.textContent = `${to === l.maxTo ? tr('All-in', '全下') : l.isBet ? tr('Apostar', '下注') : tr('Subir a', '加注到')} ${chips(to)}`;
    };
    range.addEventListener('input', () => set(Number(range.value)));
    exact.addEventListener('change', () => set(typed(Number(exact.value))));
    raise.addEventListener('click', () => send_('raise', Number(range.value)));
    set(l.minTo);
    /* pot-sized raise: call first, then add the fraction of the pot that results */
    const size = f => l.currentBet + (l.pot + l.call) * f;
    kids.push(el('div', { class: 'sizes' },
      [[tr('½ bote', '½底池'), .5], [tr('¾ bote', '¾底池'), .75], [tr('Bote', '底池'), 1]].map(([label, f]) => el('button', { type: 'button', onclick: () => set(size(f)) }, label)),
      el('button', { type: 'button', onclick: () => set(l.maxTo) }, tr('All-in', '全下'))),
    el('div', { class: 'sizer' }, range, exact));
    kids.push(mainActions(l, send_, raise));
  } else {
    kids.push(mainActions(l, send_, null));
  }
  shell.actions.replaceChildren(...kids);
}
function mainActions(l, act, raise) {
  return el('div', { class: 'main' },
    el('button', { id: 'foldBtn', onclick: () => act('fold') }, tr('Retirarme', '弃牌')),
    l.check ? el('button', { id: 'checkBtn', onclick: () => act('check') }, tr('Pasar', '过牌')) : el('button', { id: 'callBtn', onclick: () => act('call') }, `${tr('Igualar', '跟注')} ${chips(l.call)}`),
    raise);
}
function askBuyIn(t, seat) {
  const min = t.bb * 25, max = Math.min(t.bb * 200, view.club.balance);
  if (max < min) return toast(`Necesitas al menos ${chips(min)} fichas. Pide más a quien creó el club`);
  const amount = el('input', { type: 'number', min: min / 100, max: max / 100, step: 'any', value: Math.min(t.bb * 100, max) / 100, required: true, id: 'buyIn' });
  const box = el('dialog', {}, el('form', {
    class: 'stack', onsubmit: async e => {
      e.preventDefault();
      if (await send('sit', { seat, buyIn: Math.round(Number(amount.value) * 100) })) box.close();
    },
  },
    el('h2', {}, 'Sentarte en la mesa'),
    el('label', {}, `Fichas para la mesa (de ${chips(min)} a ${chips(max)})`, amount),
    el('div', { class: 'row' }, el('button', { class: 'primary', id: 'sitConfirm' }, 'Sentarme'), el('button', { type: 'button', onclick: () => box.close() }, 'Cancelar'))));
  box.addEventListener('close', () => box.remove());
  document.body.append(box);
  box.showModal();
}
const percent = value => `${Math.round(value * 100)} %`;
function whyText(why) {
  const parts = [`${why.saw ? tr('probabilidad de ganarte viendo tus cartas', '看牌后的胜率') : tr('fuerza estimada', '估计牌力')} ${percent(why.strength)}`];
  if (why.price > 0) parts.push(`${tr('precio de igualar', '跟注赔率')} ${percent(why.price)}`);
  if (why.mix) {
    const names = chinese() ? { f: '弃牌', c: '过牌或跟注', r: '加注' } : { f: 'retirarse', c: 'pasar o igualar', r: 'subir' };
    parts.push(`${tr('dudó entre', '选择比例：')} ${why.mix.filter(m => m.p > 0).map(m => `${names[m.t]}${m.to ? `${tr(' a ', ' 到 ')}${chips(m.to)}` : ''} ${percent(m.p)}`).join(', ')}`);
  }
  if (why.solved) parts.push(tr('recalculado en el river', '河牌重新计算'));
  return parts.join(' · ');
}
async function review(no) {
  const { club, table } = route();
  const res = await fetch(`/api/hand?club=${club}&table=${table}&no=${no}`);
  const x = await res.json();
  if (!res.ok) return toast(x.error);
  const names = chinese() ? { 0: '翻牌前', 1: '翻牌', 2: '转牌', 3: '河牌' } : { 0: 'Preflop', 1: 'Flop', 2: 'Turn', 3: 'River' };
  const streets = [0, 1, 2, 3].filter(s => x.log.some(e => e.street === s)).map(s => el('div', { class: 'stack' },
    el('strong', {}, names[s]),
    el('p', { class: 'small' }, x.log.filter(e => e.street === s).map(e =>
      `${e.name} ${actionName(e.type)}${e.type === 'raise' || e.type === 'bet' ? ` ${chips(e.to)}` : e.amount ? ` ${chips(e.amount)}` : ''}`).join(' · ')),
    x.log.some(e => e.street === s && e.why) ? el('ul', { class: 'list small muted' }, x.log.filter(e => e.street === s && e.why).map(e => el('li', {}, `${e.name}: ${whyText(e.why)}`))) : null));
  const box = el('dialog', { class: 'review' }, el('div', { class: 'stack' },
    el('h2', {}, tr(`Mano ${x.no}`, `第 ${x.no} 手`)),
    x.board.length ? el('div', { class: 'cards' }, x.board.map(c => cardNode(c))) : null,
    el('ul', { class: 'list small' }, x.players.map(p => {
      const diff = p.end - p.start, shown = x.showdown.find(s => s.id === p.id);
      return el('li', { class: 'row between' },
        el('span', { class: 'row' }, p.cards.length ? el('span', { class: 'cards' }, p.cards.map(c => cardNode(c))) : null, p.name, shown ? ` · ${handName(shown.hand)}` : ''),
        el('span', { class: `mono ${diff > 0 ? 'gain' : diff < 0 ? 'loss' : 'muted'}` }, `${diff > 0 ? '+' : ''}${chips(diff)}`));
    })),
    streets,
    el('button', { onclick: () => box.close() }, tr('Cerrar', '关闭'))));
  box.addEventListener('close', () => box.remove());
  document.body.append(box);
  box.showModal();
  box.scrollTop = 0;
}

function draw() {
  const r = route();
  if (r.club && !view.club) { toast('No perteneces a ese club'); location.hash = ''; return; }
  if (r.club && r.table && view.table) drawTable();
  else if (r.club) drawClub();
  else drawHome();
  drawStatus();
}
function tick() {
  const bar = document.getElementById('clock');
  if (bar && clockEnd) bar.style.transform = `scaleX(${Math.max(0, (clockEnd - performance.now()) / clockTotal)})`;
  requestAnimationFrame(tick);
}
async function start() {
  const r = route();
  if (r.join) {
    const joined = await post('/api/do', { op: 'joinClub', code: r.join }).catch(err => { toast(err.message); return null; });
    location.replace(joined ? `#club/${joined.code}` : '#');
    if (location.hash !== '#' && location.hash !== '') return;
  }
  connect();
}
phone.addEventListener('change', () => { if (view) draw(); });
window.addEventListener('hashchange', () => { if (!me) return; screen = ''; app.classList.remove('at-table'); if (route().join) start(); else connect(); });
(async () => {
  me = await (await fetch('/api/me')).json();
  requestAnimationFrame(tick);
  if (me) start(); else drawLogin();
})();
