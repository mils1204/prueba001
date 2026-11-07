'use strict';
/* Private poker clubs for friends. Virtual chips only. No dependencies: plain http, Server-Sent Events for pushes.
   The server shuffles, deals and enforces the rules. A browser only ever receives the cards it may see. */
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { Worker } = require('worker_threads');
const { startHand, act, legal, shuffledDeck, potTotal, IllegalAction, STREETS } = require('./engine');

const PORT = Number(process.env.PORT || 8080);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PAUSE_MS = Number(process.env.PAUSE_MS || 6000);    /* how long a finished hand stays on the table */
const START_MS = Number(process.env.START_MS || 1500);
const DEMO_GRACE_MS = Number(process.env.DEMO_GRACE_MS ?? 600000);   /* bots keep playing unwatched for 10 min, then pause until someone opens the table */
const SCHEMA = 2;                                          /* decimal economy: chips are integer hundredths; no gift chips */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'MilthoN1204';   /* the single admin key for the whole site */
const ADMIN_ID = 'admin', ADMIN_NAME = 'Milthon', DEFAULT_CODE = 'MANO01';   /* one reserved admin and one club */
const HISTORY = 100, LEDGER = 200;
/* The bot was trained heads-up at 50/100 with 100 big blinds, so practice tables always play exactly that. */
const MIN_ENTRY_BB = 25;
/* Decimal stakes: chips stay whole numbers, counted in hundredths, and only the page shows decimals. */
const CATEGORIES = { micro: 10, low: 50, mid: 100 };
const BOT = 'bot', PRACTICE_BB = 100, PRACTICE_DEPTH = 100, PRACTICE_STACK = PRACTICE_BB * PRACTICE_DEPTH;
const BOT_LIMIT_SECONDS = 60, BOT_FIXED_MS = process.env.BOT_MIN_MS === undefined ? null : Number(process.env.BOT_MIN_MS);
const BOT_THINK_MIN_MS = 3000, BOT_THINK_MAX_MS = 10000;
/* Tables with 2 to 5 bots use these: they follow rules, they are not trained. */
const RULE_BOTS = [['bot-1', 'Kiko', 'zorro'], ['bot-2', 'Bagre', 'rayo'], ['bot-3', 'Milthon', 'roca'], ['bot-4', 'Elvis', 'muro'], ['bot-5', 'Paluco', 'buho']];
const NAMES = require('./bot/names.js');
const isBot = id => id === BOT || RULE_BOTS.some(b => b[0] === id);
const botSeat = (userId, stack = PRACTICE_STACK) => ({ userId, stack, sittingOut: false, timeouts: 0, leaving: false });
const tableStack = t => t.bb * (t.depth ?? PRACTICE_DEPTH);   /* chips a practice player sits down with */
/* Person-like names exist only at "Solo yo" tables. Anywhere shared with people, a bot keeps its "Bot ..." name. */
function namedBotSeat([id, , style], stack) {
  const pool = NAMES[style];
  return { ...botSeat(id, stack), name: pool[crypto.randomInt(pool.length)] };
}
function shuffled(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
/* Without a "Solo yo" name, a bot always says it is one, whatever its base name. */
function seatName(s) {
  if (s.name) return s.name;
  const name = db.users[s.userId].name;
  return isBot(s.userId) && !/^bot\b/i.test(name) ? `${name} (bot)` : name;
}
/* Only one bot per table can see all cards: the first rule bot seated. */
const seeingBot = t => t.seatList.find(s => s && isBot(s.userId) && s.userId !== BOT)?.userId;
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/* The address friends on the same network can use. Invite links from localhost would only work on this PC. */
function networkAddress() {
  const found = Object.values(os.networkInterfaces()).flat().find(a => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'));
  return found ? `http://${found.address}:${PORT}` : null;
}

class UserError extends Error {}
const fail = message => { throw new UserError(message); };
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const newId = () => crypto.randomBytes(8).toString('hex');

/* ---------- Storage ---------- */
let db = { users: {}, clubs: {} };
const tokens = new Map();                                  /* token hash -> user id */
const runtime = new Map();                                 /* table id -> { hand, timer, next, deadline } */
const streams = new Set();                                 /* { res, userId, club, table } */
const rt = t => { if (!runtime.has(t.id)) runtime.set(t.id, { hand: null, timer: null, next: null, deadline: 0 }); return runtime.get(t.id); };

function load() {
  if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));   /* a broken file stops the server instead of being overwritten */
  db.users[BOT] ??= { id: BOT, name: 'Bot', tokenHash: null };
  for (const [id, name] of RULE_BOTS) db.users[id] = { id, name, tokenHash: null };
  if (db.schema !== SCHEMA) {                              /* one-time reset into the decimal economy */
    for (const club of Object.values(db.clubs)) {
      club.pot = 0;
      club.ledger = [];
      club.tables = {};
      for (const m of Object.values(club.members)) m.balance = 0;
    }
    db.schema = SCHEMA;
  }
  db.users[ADMIN_ID] ??= { id: ADMIN_ID, name: ADMIN_NAME, tokenHash: null };
  db.users[ADMIN_ID].admin = true;
  if (!db.clubs[DEFAULT_CODE]) db.clubs[DEFAULT_CODE] = { code: DEFAULT_CODE, name: 'Mano a Mano', ownerId: ADMIN_ID, createdAt: Date.now(), members: { [ADMIN_ID]: { balance: 0 } }, ledger: [], tables: {}, pot: 0 };
  for (const u of Object.values(db.users)) if (u.tokenHash) tokens.set(u.tokenHash, u.id);
  /* Stacks change only when a hand ends, so a hand cut off by a restart simply never happened. */
  for (const club of Object.values(db.clubs)) {
    for (const t of Object.values(club.tables)) {
      refill(t);
      t.seatList.forEach((s, i) => {
        if (s) { s.timeouts = 0; if (s.leaving || (s.stack === 0 && s.userId !== BOT)) removeSeat(club, t, i); }
      });
      schedule(club, t);
    }
  }
}
let saveTimer = null;
function writeNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db));
  fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
}
const save = () => { if (!saveTimer) saveTimer = setTimeout(writeNow, 300); };

/* ---------- Clubs and chips ---------- */
function ledger(club, userId, delta, reason) {
  club.ledger.unshift({ at: Date.now(), userId, name: db.users[userId].name, delta, reason });
  club.ledger.length = Math.min(club.ledger.length, LEDGER);
}
function memberClub(user, code) {
  const club = db.clubs[code];
  if (!club || !club.members[user.id]) fail('No perteneces a ese club');
  return club;
}
function clubTable(club, id) {
  return club.tables[id] || fail('Esa mesa no existe');
}
/* The trained bot only knows 100 big blinds, so its table resets every hand.
   Rule-bot tables keep their chips: only a bot that went broke buys back in. */
const today = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };   /* the PC's local date */
function refill(t) {
  if (!t.practice) return;
  const full = tableStack(t);
  if (t.seatList.some(s => s?.userId === BOT)) {            /* trained heads-up table: top up to 100 BB */
    for (const s of t.seatList) {
      if (!s) continue;
      if (s.userId === BOT) {                                /* always set the bot to exactly 100 BB, funded by its daily reserve (one extra 100 BB) */
        if (s.day !== today()) { s.day = today(); s.bank = full; }
        const need = full - s.stack;
        if (need > 0) { const take = Math.min(need, s.bank ?? 0); s.stack += take; s.bank = (s.bank ?? 0) - take; }   /* a loss is covered from the reserve; when it runs out the bot plays short, then is out */
        else if (need < 0) { s.bank = (s.bank ?? 0) - need; s.stack = full; }                                         /* a win goes back to the reserve, and the stack drops to 100 */
      } else if (s.alwaysFull !== false) {                   /* the human is set to 100 BB only while "Siempre al 100%" is on */
        s.stack = full;
      }
    }
    return;
  }
  /* Rule bots: initial entry + 1 rebuy per day. Out of rebuys, they stay at 0 and are freed from the seat. */
  for (const s of t.seatList) {
    if (!s || !isBot(s.userId) || s.stack > 0) continue;
    if (s.day !== today()) { s.day = today(); s.rebuys = 1; }
    if ((s.rebuys ?? 1) > 0) { s.stack = full; s.rebuys = (s.rebuys ?? 1) - 1; }
  }
}
function removeSeat(club, t, i) {
  const seat = t.seatList[i];
  if (t.practice) {                                        /* practice chips never touch the club; keep yours for when you sit back down */
    if (!isBot(seat.userId) && seat.stack > 0) (t.reserved ??= {})[seat.userId] = { stack: seat.stack, net: seat.net ?? 0 };
    t.seatList[i] = null;
    return;
  }
  club.members[seat.userId].balance += seat.stack;
  if (seat.stack > 0) ledger(club, seat.userId, seat.stack, `Dejó la mesa ${t.name}`);
  t.seatList[i] = null;
}
const seatOf = (t, userId) => t.seatList.findIndex(s => s && s.userId === userId);
function playable(t) {
  const open = t.seatList.map((s, i) => (s && s.stack > 0 && !s.sittingOut && !s.leaving ? i : -1)).filter(i => i >= 0);
  return t.practice && open.every(i => isBot(t.seatList[i].userId)) ? [] : open;     /* bots never play on their own */
}
const whole = (value, min, max, label) => (Number.isInteger(value) && value >= min && value <= max ? value : fail(`${label}: usa un número entero entre ${min} y ${max}`));
function cleanName(value, label) {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim();
  return name.length >= 1 && name.length <= 20 ? name : fail(`${label}: usa de 1 a 20 caracteres`);
}

/* A chosen bot name always ends in "Bot", so everyone can tell. */
function botLabel(value) {
  const name = cleanName(value, 'Nombre del Bot');
  return /\bbot$/i.test(name) ? name : `${name.slice(0, 16).trim()} Bot`;
}

/* ---------- Hand flow ---------- */
/* With nobody seated, rule bots play for whoever is watching. Their chips really move; the hands are not recorded. */
const demoSeats = t => t.seatList.map((s, i) => (s && isBot(s.userId) && s.userId !== BOT ? i : -1)).filter(i => i >= 0);
function demoReady(t) {
  if (!t.practice || demoSeats(t).length < 2 || !t.seatList.every(s => !s || isBot(s.userId) || s.sittingOut)) return false;
  const watched = [...streams].some(s => s.table === t.id);
  return watched || Date.now() - (t.lastSeen ?? 0) < DEMO_GRACE_MS;    /* play while watched, or for 10 min after */
}
/* An absent player loses the seat after the button goes round twice. Their chips wait for them at this table. */
function countAbsence(t) {
  const seated = t.seatList.filter(Boolean).length;
  t.seatList.forEach((s, i) => {
    if (!s?.sittingOut) return;
    s.missed = (s.missed ?? 0) + 1;
    if (s.missed < 2 * seated) return;
    (t.reserved ??= {})[s.userId] = { stack: s.stack, net: s.net ?? 0 };
    t.seatList[i] = null;
  });
}
function schedule(club, t) {
  const r = rt(t);
  if (r.next || (r.hand && !r.hand.done) || (playable(t).length < 2 && !demoReady(t))) return;
  r.next = setTimeout(() => { r.next = null; begin(club, t); }, START_MS);
}
function begin(club, t) {
  const r = rt(t);
  if (r.hand && !r.hand.done) return;
  r.hand = null;
  refill(t);
  t.seatList.forEach((s, i) => { if (s && (s.leaving || (s.stack === 0 && s.userId !== BOT))) removeSeat(club, t, i); });   /* a rule bot out of rebuys leaves the seat for a person; the trained bot stays */
  const demo = playable(t).length < 2 && demoReady(t);
  const open = demo ? demoSeats(t) : playable(t);
  if (open.length < 2) { save(); return broadcast(club.code); }
  const button = open.find(i => i > t.button) ?? open[0];
  t.button = button;
  if (!demo) t.handNo++;
  r.hand = startHand({
    players: open.map(i => ({ id: t.seatList[i].userId, name: seatName(t.seatList[i]), seat: i, stack: t.seatList[i].stack })),
    dealer: open.indexOf(button), sb: t.sb, bb: t.bb, deck: shuffledDeck(),
  });
  r.hand.no = demo ? 0 : t.handNo;
  r.hand.demo = demo;
  r.hand.key = newId();
  countAbsence(t);
  turn(club, t);
}
function autoAct(h, id) {
  act(h, id, { type: legal(h).check ? 'check' : 'fold' });
}

/* ---------- Bot ---------- */
let botWorker = null, botAsked = 0;
const botReplies = new Map();
function bot() {
  if (botWorker) return botWorker;
  botWorker = new Worker(path.join(__dirname, 'bot', 'worker.js'));
  botWorker.on('message', m => { botReplies.get(m.id)?.(m); botReplies.delete(m.id); });
  botWorker.on('error', err => { console.error('bot: el hilo falló', err); botWorker = null; });
  return botWorker;
}
/* The bot thinks in a 50/100 game with 100 BB, so chips are scaled to that. Only proportions matter to its strategy. */
const toBotChips = (h, chips) => Math.round(chips * PRACTICE_BB / h.bb);
/* The bot counts total chips per hand. The engine counts bets per street. */
function publicActions(h) {
  const totals = {}, actions = [];
  for (const e of h.log) {
    totals[e.id] = (totals[e.id] ?? 0) + e.amount;
    if (e.type === 'sb' || e.type === 'bb') continue;
    if (e.type === 'fold') actions.push({ t: 'f' });
    else if (e.type === 'check' || e.type === 'call') actions.push({ t: 'c' });
    else actions.push({ t: 'r', to: toBotChips(h, totals[e.id]) });
  }
  return actions;
}
function playBot(h, reply) {
  const p = h.players[h.toAct], l = legal(h), { action, move } = reply;
  if (move) return act(h, p.id, move);
  if (action.t === 'f') return act(h, p.id, { type: 'fold' });
  if (action.t === 'r') {
    const to = Math.round(action.to * h.bb / PRACTICE_BB) - (p.total - p.bet);
    return act(h, p.id, { type: 'raise', to: Math.max(l.minTo, Math.min(l.maxTo, to)) });
  }
  act(h, p.id, { type: l.check ? 'check' : 'call' });
}
function ruleSpot(h, p) {
  const l = legal(h), n = h.players.length, distance = (h.toAct - h.dealer + n) % n;
  return {
    style: RULE_BOTS.find(b => b[0] === p.id)[2], hole: p.cards, board: h.board, street: h.street,
    opponents: h.players.filter(q => q !== p && !q.folded).length, pot: potTotal(h), toCall: l.call, currentBet: h.currentBet,
    canRaise: l.canRaise, minTo: l.minTo, maxTo: l.maxTo, bb: h.bb, late: distance === 0 || distance === n - 1,
    raises: h.log.filter(e => e.street === h.street && (e.type === 'raise' || e.type === 'bet')).length,
  };
}
/* The same human-looking pause everywhere, including when bots play only among themselves. */
function thinkTime() {
  if (BOT_FIXED_MS !== null) return BOT_FIXED_MS;
  return crypto.randomInt(BOT_THINK_MIN_MS, BOT_THINK_MAX_MS + 1);
}
function askBot(club, t) {
  const r = rt(t), h = r.hand, moment = h.log.length, asked = Date.now(), id = ++botAsked, wait = thinkTime();
  const p = h.players[h.toAct];
  botReplies.set(id, reply => {
    setTimeout(() => {
      if (r.hand !== h || h.done || h.log.length !== moment) return;
      try {
        if (reply.error) throw new Error(reply.error);
        playBot(h, reply);
        h.log[moment].why = reply.why ?? reply.move?.why;   /* shown only in the review, after the hand */
      } catch (err) {
        console.error(`bot: jugada rechazada en la mano ${h.no}: ${err.message}`);
        const l = legal(h);
        act(h, p.id, { type: l.check ? 'check' : 'call' });
      }
      turn(club, t);
    }, Math.max(0, wait - (Date.now() - asked)));
  });
  if (p.id !== BOT) {
    const spot = ruleSpot(h, p);
    if (t.botSees && p.id === seeingBot(t)) spot.known = h.players.filter(q => q !== p && !q.folded).map(q => q.cards);
    return bot().postMessage({ id, spot });
  }
  bot().postMessage({
    id, table: t.id, key: h.key, seat: h.players[h.dealer].id === BOT ? 0 : 1,
    hole: p.cards, board: h.board, actions: publicActions(h),
    chips: [toBotChips(h, h.players[h.dealer].total), toBotChips(h, h.players[1 - h.dealer].total)],
  });
}
function turn(club, t) {
  const r = rt(t), h = r.hand;
  clearTimeout(r.timer);
  while (!h.done) {
    const p = h.players[h.toAct], seat = t.seatList[p.seat];
    if (!seat.leaving && !seat.sittingOut) break;
    autoAct(h, p.id);
  }
  if (h.done) return endHand(club, t);
  const p = h.players[h.toAct];
  const limit = (isBot(p.id) ? BOT_LIMIT_SECONDS : t.turn) * 1000;
  r.deadline = Date.now() + t.turn * 1000;                 /* what the clock shows; a bot's safety limit is longer */
  r.timer = setTimeout(() => {
    const seat = t.seatList[p.seat];
    if (isBot(p.id)) console.error(`bot: sin respuesta en la mano ${h.no}`);
    else if (++seat.timeouts >= 2) seat.sittingOut = true;
    autoAct(h, p.id);
    turn(club, t);
  }, limit);
  if (isBot(p.id)) askBot(club, t);
  broadcast(club.code);
}
/* Commission: a slice of the pot moves to the club pool, taken from the winners. "No flop, no drop". */
function applyRake(club, t, h) {
  const pct = t.rake || 0;
  if (!pct || h.board.length < 3) return 0;
  let rake = Math.floor(potTotal(h) * pct / 100);
  if (rake <= 0) return 0;
  const final = h.result.final;
  const winners = h.players.map(p => ({ id: p.id, gain: final[p.id] - p.start })).filter(w => w.gain > 0);
  const gain = winners.reduce((s, w) => s + w.gain, 0);
  if (gain <= 0) return 0;
  rake = Math.min(rake, gain);
  const parts = winners.map(w => { const exact = rake * w.gain / gain; return { id: w.id, base: Math.floor(exact), frac: exact - Math.floor(exact) }; });
  const left = rake - parts.reduce((s, p) => s + p.base, 0);
  parts.sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < left; i++) parts[i].base++;
  for (const p of parts) final[p.id] -= p.base;
  club.pot = (club.pot || 0) + rake;
  return rake;
}
function endHand(club, t) {
  const r = rt(t), h = r.hand;
  const rake = applyRake(club, t, h);
  if (h.demo) {
    for (const p of h.players) t.seatList[p.seat].stack = h.result.final[p.id];
    save();
    r.next = setTimeout(() => { r.next = null; begin(club, t); }, PAUSE_MS);
    return broadcast(club.code);
  }
  for (const p of h.players) {
    const seat = t.seatList[p.seat];
    seat.stack = h.result.final[p.id];
    if (t.practice) seat.net = (seat.net ?? 0) + seat.stack - p.start;
  }
  t.history.unshift({
    no: h.no, at: Date.now(), board: h.board, sb: h.sb, bb: h.bb, pot: potTotal(h), rake,
    dealer: h.players[h.dealer].id,
    players: h.players.map(p => ({ id: p.id, name: p.name, start: p.start, end: h.result.final[p.id], cards: p.cards })),
    log: h.log, pots: h.result.pots, showdown: h.result.showdown,
  });
  t.history.length = Math.min(t.history.length, HISTORY);
  save();
  r.next = setTimeout(() => { r.next = null; begin(club, t); }, PAUSE_MS);
  broadcast(club.code);
}

/* ---------- What each person may see ---------- */
/* Only ever bots' cards, only for the one person at a solo practice table. Never at tables shared with other people. */
const solo = t => !!t.practice && (t.people ?? 1) === 1;
const canPeek = (club, t, user) => solo(t) && !!club.members[user.id]?.seeCards && seatOf(t, user.id) >= 0;
function tableView(user, club, t) {
  const r = rt(t), h = r.hand;
  const shown = new Map((h?.result?.showdown ?? []).map(s => [s.id, s]));
  const peeking = canPeek(club, t, user);
  const seats = t.seatList.map((s, i) => {
    if (!s) return null;
    const p = h?.players.find(q => q.seat === i && q.id === s.userId);
    let cards = [];
    if (p) {
      if (p.id === user.id || shown.has(p.id)) cards = p.cards;
      else if (!p.folded) cards = peeking && isBot(p.id) ? p.cards : [null, null];
    }
    return {
      seat: i, id: s.userId, name: seatName(s),
      stack: p && !h.done ? p.stack : s.stack,
      bet: p && !h.done ? p.bet : 0,
      inHand: !!p, folded: !!p?.folded, allIn: !!p?.allIn && !h.done, cards,
      hand: shown.get(s.userId)?.hand ?? null,
      won: h?.done ? (h.result.final[s.userId] ?? 0) - (p?.start ?? 0) : 0,
      bot: isBot(s.userId), net: s.net ?? 0,
      dayNet: isBot(s.userId)                                 /* running result beside the stack: the trained bot's day, each bot's session, and your own */
        ? (s.userId === BOT ? (s.day === today() ? (s.bank ?? tableStack(t)) : tableStack(t)) - tableStack(t) : (s.net ?? 0))
        : (t.practice && s.userId === user.id ? (s.net ?? 0) : null),
      outToday: s.userId === BOT ? (s.day === today() && (s.bank ?? 0) <= 0 && s.stack === 0) : false,
      online: isBot(s.userId) || isOnline(s.userId), sittingOut: !!s.sittingOut, leaving: !!s.leaving,
      turn: !!h && !h.done && h.players[h.toAct].seat === i,
      dealer: !!h && t.button === i,
    };
  });
  const mine = h && !h.done && h.players[h.toAct].id === user.id;
  const trainedSeat = t.seatList.find(s => s?.userId === BOT);
  const mySeatObj = t.seatList[seatOf(t, user.id)];
  return {
    id: t.id, name: t.name, size: t.seatList.length, sb: t.sb, bb: t.bb, turnSeconds: t.turn, practice: !!t.practice, people: t.people ?? 1, cents: !!t.cents, peeking, botSees: !!t.botSees, reserved: t.reserved?.[user.id]?.stack ?? null, seats,
    trained: !!trainedSeat, alwaysFull: mySeatObj ? mySeatObj.alwaysFull !== false : true,
    botReserve: trainedSeat ? (trainedSeat.day === today() ? (trainedSeat.bank ?? tableStack(t)) : tableStack(t)) : null,
    mySeat: seatOf(t, user.id),
    hand: h ? {
      no: h.no, demo: !!h.demo, street: STREETS[h.street], board: h.board, pot: potTotal(h), done: h.done,
      remainingMs: h.done ? 0 : Math.max(0, r.deadline - Date.now()),
      summary: h.done ? h.result.pots.filter(p => !p.refund).map(p => ({ amount: p.amount, winners: p.winners.map(w => w.name) })) : [],
      last: h.log.length ? (({ why, ...entry }) => entry)(h.log[h.log.length - 1]) : null,
    } : null,
    legal: mine ? { ...legal(h), pot: potTotal(h), bet: h.players[h.toAct].bet, currentBet: h.currentBet, bb: h.bb } : null,
    history: t.history.slice(0, 20).map(x => ({
      no: x.no, at: x.at, pot: x.pot, rake: x.rake || 0,
      winners: [...new Set(x.pots.filter(p => !p.refund).flatMap(p => p.winners.map(w => w.name)))],
      mine: (x.players.find(p => p.id === user.id)?.end ?? 0) - (x.players.find(p => p.id === user.id)?.start ?? 0),
    })),
  };
}
function handView(user, club, t, no) {
  const x = t.history.find(item => item.no === no) || fail('Esa mano ya no está en el historial');
  const shown = new Set(x.showdown.map(s => s.id)), peeking = canPeek(club, t, user);
  /* A bot's reasoning could hint at another person's folded cards, so shared tables leave it out. */
  const log = solo(t) ? x.log : x.log.map(({ why, ...entry }) => entry);
  return { ...x, log, players: x.players.map(p => ({ ...p, cards: p.id === user.id || shown.has(p.id) || (peeking && isBot(p.id)) ? p.cards : [] })) };
}
function view(user, code, tableId) {
  const out = {
    me: { id: user.id, name: user.name, admin: !!user.admin, club: DEFAULT_CODE },
    adminSet: true,
    network: networkAddress(),
    clubs: Object.values(db.clubs).filter(c => c.members[user.id]).map(c => ({
      code: c.code, name: c.name, balance: c.members[user.id].balance, owner: c.ownerId === user.id,
      active: Object.values(c.tables).reduce((sum, t) => sum + t.seatList.filter(Boolean).length, 0),   /* seated players + bots in play */
    })),
    club: null, table: null,
  };
  const club = db.clubs[code];
  if (!club || !club.members[user.id]) return out;
  out.club = {
    code: club.code, name: club.name, isOwner: club.ownerId === user.id, balance: club.members[user.id].balance,
    pot: club.ownerId === user.id ? (club.pot || 0) : null,     /* the commission pool: only the club creator sees it */
    members: club.ownerId === user.id                       /* the members list is only for the club creator */
      ? Object.entries(club.members).map(([id, m]) => ({ id, name: db.users[id].name, balance: m.balance, online: isOnline(id), owner: id === club.ownerId, seeCards: !!m.seeCards }))
      : [],
    ledger: club.ownerId === user.id ? club.ledger.slice(0, 20) : [],
    tables: Object.values(club.tables).map(t => ({
      id: t.id, name: t.name, size: t.seatList.length, sb: t.sb, bb: t.bb, turnSeconds: t.turn, practice: !!t.practice, people: t.people ?? 1, botSees: !!t.botSees, entry: tableStack(t), cents: !!t.cents, rake: t.rake || 0, mine: seatOf(t, user.id) >= 0,
      seated: t.seatList.filter(Boolean).map(seatName), playing: !!rt(t).hand && !rt(t).hand.done,
    })),
  };
  if (club.tables[tableId]) out.table = tableView(user, club, club.tables[tableId]);
  return out;
}
const isOnline = userId => [...streams].some(s => s.userId === userId);
function broadcast(code) {
  for (const s of streams) {
    if (s.club === code) s.res.write(`data: ${JSON.stringify(view(db.users[s.userId], s.club, s.table))}\n\n`);
  }
}

/* ---------- Commands ---------- */
const ops = {
  createClub(user, b) {
    if (!user.admin && process.env.ADMIN_OPEN !== '1') fail('Solo el administrador puede crear clubes');
    let code;
    do code = Array.from({ length: 6 }, () => CODE_LETTERS[crypto.randomInt(CODE_LETTERS.length)]).join(''); while (db.clubs[code]);
    db.clubs[code] = { code, name: cleanName(b.name, 'Nombre del club'), ownerId: user.id, createdAt: Date.now(), members: { [user.id]: { balance: 0 } }, ledger: [], tables: {}, pot: 0 };
    return { code };
  },
  joinClub(user, b) {
    const code = String(b.code ?? '').trim().toUpperCase();
    const club = db.clubs[code] || fail('No hay ningún club con ese código');
    if (!club.members[user.id]) club.members[user.id] = { balance: 0 };
    return { code };
  },
  grant(user, b, club) {
    if (club.ownerId !== user.id) fail('Solo quien creó el club puede repartir fichas');
    const member = club.members[b.memberId] || fail('Esa persona no está en el club');
    const amount = whole(b.amount, -1e9, 1e9, 'Cantidad');
    if (amount === 0) fail('La cantidad no puede ser 0');
    if (member.balance + amount < 0) fail('No tiene tantas fichas fuera de la mesa');
    member.balance += amount;
    ledger(club, b.memberId, amount, `Ajuste de ${user.name}`);
  },
  /* Hands in progress are void: stacks only change when a hand ends, so seated chips go back as they were. */
  deleteTables(user, b, club) {
    if (club.ownerId !== user.id) fail('Solo quien creó el club puede eliminar las mesas');
    const ids = Array.isArray(b.ids) ? b.ids : null;             /* no ids means every table, kept for callers that expect it */
    const targets = Object.values(club.tables).filter(t => !ids || ids.includes(t.id));
    if (ids && targets.length === 0) fail('No hay mesas marcadas para eliminar');
    for (const t of targets) {
      const r = rt(t);
      clearTimeout(r.timer);
      clearTimeout(r.next);
      r.hand = null;
      t.seatList.forEach((s, i) => { if (s) removeSeat(club, t, i); });
      if (!t.practice) {
        for (const [id, saved] of Object.entries(t.reserved ?? {})) {
          club.members[id].balance += saved.stack;
          ledger(club, id, saved.stack, `Fichas guardadas de ${t.name}`);
        }
      }
      runtime.delete(t.id);
      delete club.tables[t.id];
    }
  },
  /* Always shown to everyone at the table: this mode must never be secret. */
  setBotSees(user, b, club, t) {
    if (club.ownerId !== user.id) fail('Solo quien creó el club puede cambiar esta opción');
    if (!t.practice) fail('Esta opción solo existe en mesas de práctica');
    if (t.seatList.some(s => s?.userId === BOT)) fail('El bot entrenado no puede usar esta opción. Abre una mesa con 2 o más bots');
    /* Everyone must see the warning before sitting down, so it cannot change once people are playing together. */
    if (!solo(t) && t.seatList.some(s => s && !isBot(s.userId))) fail('En mesas con varias personas solo se puede cambiar con la mesa vacía');
    t.botSees = b.on === true;
  },
  /* "Siempre al 100%" at the trained-bot table: refill the human to 100 BB each hand. The bot is always on. */
  setAlwaysFull(user, b, club, t) {
    const seat = t.seatList[seatOf(t, user.id)] || fail('No estás sentado en esta mesa');
    if (!t.seatList.some(s => s?.userId === BOT)) fail('Esta opción solo existe en la mesa del bot entrenado');
    seat.alwaysFull = b.on === true;
    schedule(club, t);
  },
  setSeeCards(user, b, club) {
    if (club.ownerId !== user.id) fail('Solo quien creó el club puede cambiar esta opción');
    const member = club.members[b.memberId] || fail('Esa persona no está en el club');
    member.seeCards = b.on === true;
  },
  createTable(user, b, club) {
    if (club.ownerId !== user.id) fail('Solo quien creó el club puede abrir mesas');
    if (Object.keys(club.tables).length >= 20) fail('Este club ya tiene 20 mesas');
    const practice = b.practice === true;
    const bots = practice ? whole(b.bots ?? 1, 1, 5, 'Rivales') : 0;
    const people = practice ? whole(b.people ?? 1, 1, 6 - bots, 'Personas') : 0;
    const trainedBot = practice && (b.trained === undefined ? bots === 1 && people === 1 : b.trained === true);
    if (trainedBot && (bots !== 1 || people !== 1)) fail('El bot entrenado juega contra una sola persona');
    const category = practice && Object.hasOwn(CATEGORIES, b.category ?? '') ? CATEGORIES[b.category] : null;
    const bb = category ?? whole(practice ? b.bb ?? PRACTICE_BB : b.bb, 2, 1e6, 'Ciega grande');
    if (trainedBot && bb % 2) fail('Con el bot entrenado la ciega grande debe ser un número par');
    const depth = practice && !trainedBot ? whole(b.depth ?? PRACTICE_DEPTH, MIN_ENTRY_BB, 500, 'Entrada en BB') : PRACTICE_DEPTH;
    const rake = whole(b.rake ?? 0, 0, 5, 'Comisión (%)');
    const stack = bb * depth;
    const t = {
      id: newId(), name: cleanName(b.name, 'Nombre de la mesa'), sb: Math.floor(bb / 2), bb, depth, rake, practice, people, cents: !!category,
      turn: whole(b.turn, 10, 120, 'Tiempo por turno'),
      seatList: !practice ? Array(whole(b.seats, 2, 6, 'Asientos')).fill(null)
        : [...Array(people).fill(null), ...(trainedBot ? [botSeat(BOT)]
          : people === 1 ? shuffled(RULE_BOTS).slice(0, bots).map(x => namedBotSeat(x, stack))
            : RULE_BOTS.slice(0, bots).map(x => botSeat(x[0], stack)))],
      button: -1, handNo: 0, history: [],
    };
    if (practice) {
      const names = Array.isArray(b.botNames) ? b.botNames : [b.botName];
      t.seatList.filter(s => s && isBot(s.userId)).forEach((s, i) => { if (names[i]) s.name = botLabel(names[i]); });
    }
    club.tables[t.id] = t;
    t.lastSeen = Date.now();
    schedule(club, t);                                 /* bots begin playing right away (for up to 10 min unwatched) */
    return { table: t.id };
  },
  sit(user, b, club, t) {
    if (seatOf(t, user.id) >= 0) fail('Ya estás en esta mesa');
    const seat = whole(b.seat, 0, t.seatList.length - 1, 'Asiento');
    if (t.seatList[seat]) fail('Ese asiento ya está ocupado');
    const saved = t.reserved?.[user.id];
    if (saved) {
      /* back after being removed for absence: the same chips, no new buy-in */
      delete t.reserved[user.id];
      t.seatList[seat] = { userId: user.id, stack: saved.stack, sittingOut: false, timeouts: 0, leaving: false, net: saved.net };
      return schedule(club, t);
    }
    if (t.practice) {
      /* like a real table: you join on the next hand and the bots keep the chips they have */
      t.seatList[seat] = { userId: user.id, stack: tableStack(t), sittingOut: false, timeouts: 0, leaving: false, net: 0, alwaysFull: true };
      return schedule(club, t);
    }
    const balance = club.members[user.id].balance, min = t.bb * MIN_ENTRY_BB;
    if (balance < min) fail(`Necesitas al menos ${min} fichas. Pide más a quien creó el club`);
    const buyIn = whole(b.buyIn, min, Math.min(t.bb * 200, balance), 'Fichas para la mesa');
    club.members[user.id].balance -= buyIn;
    ledger(club, user.id, -buyIn, `Se sentó en ${t.name}`);
    t.seatList[seat] = { userId: user.id, stack: buyIn, sittingOut: false, timeouts: 0, leaving: false };
    schedule(club, t);
  },
  stand(user, b, club, t) {
    const i = seatOf(t, user.id);
    if (i < 0) fail('No estás sentado en esta mesa');
    const h = rt(t).hand;
    if (h && !h.done && h.players.some(p => p.seat === i)) {
      t.seatList[i].leaving = true;
      if (h.players[h.toAct].id === user.id) { autoAct(h, user.id); turn(club, t); }
    } else {
      removeSeat(club, t, i);
    }
  },
  back(user, b, club, t) {
    const seat = t.seatList[seatOf(t, user.id)] || fail('No estás sentado en esta mesa');
    seat.sittingOut = false;
    seat.timeouts = 0;
    seat.missed = 0;
    schedule(club, t);
  },
  act(user, b, club, t) {
    const r = rt(t);
    if (!r.hand || r.hand.done) fail('No hay ninguna mano en juego');
    act(r.hand, user.id, { type: b.type, to: b.to });
    t.seatList[seatOf(t, user.id)].timeouts = 0;
    turn(club, t);
  },
};

/* ---------- HTTP ---------- */
const PUBLIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
};
function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY, ...headers });
  res.end(JSON.stringify(body));
}
function currentUser(req) {
  const match = /(?:^|;\s*)club_token=([a-f0-9]{64})/.exec(req.headers.cookie ?? '');
  return match ? db.users[tokens.get(sha(match[1]))] ?? null : null;
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return reject(new UserError('Petición no válida'));
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; if (body.length > 8192) { reject(new UserError('Petición demasiado grande')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new UserError('Petición no válida')); } });
    req.on('error', reject);
  });
}
async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  if (req.method === 'GET' && PUBLIC[url.pathname]) {
    const [file, type] = PUBLIC[url.pathname];
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...SECURITY });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', file)));
  }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const body = await readJson(req);
    const name = cleanName(body.name, 'Tu nombre');
    const token = crypto.randomBytes(32).toString('hex');
    const cookie = { 'Set-Cookie': `club_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` };
    if (name.toLowerCase() === ADMIN_NAME.toLowerCase()) {       /* "Milthon" is reserved for the admin */
      if (String(body.password ?? '') !== ADMIN_PASSWORD) return sendJson(res, 400, { error: 'Clave incorrecta' });
      const admin = db.users[ADMIN_ID];
      if (admin.tokenHash) tokens.delete(admin.tokenHash);
      admin.tokenHash = sha(token);
      admin.admin = true;
      tokens.set(admin.tokenHash, ADMIN_ID);
      save();
      return sendJson(res, 200, { id: ADMIN_ID, name: ADMIN_NAME, admin: true, club: DEFAULT_CODE }, cookie);
    }
    const user = { id: newId(), name, tokenHash: sha(token), createdAt: Date.now() };
    db.users[user.id] = user;
    tokens.set(user.tokenHash, user.id);
    const club = db.clubs[DEFAULT_CODE];
    if (club && !club.members[user.id]) club.members[user.id] = { balance: 0 };   /* auto-join the single club */
    save();
    return sendJson(res, 200, { id: user.id, name: user.name, admin: false, club: DEFAULT_CODE }, cookie);
  }
  const user = currentUser(req);
  if (req.method === 'GET' && url.pathname === '/api/me') return sendJson(res, 200, user ? { id: user.id, name: user.name, admin: !!user.admin, adminSet: true, club: DEFAULT_CODE } : null);
  if (!user) return sendJson(res, 401, { error: 'Entra con tu nombre primero' });
  if (req.method === 'POST' && url.pathname === '/api/admin') {
    const body = await readJson(req);
    if (String(body.password ?? '') !== ADMIN_PASSWORD) return sendJson(res, 400, { error: 'Clave incorrecta' });
    user.admin = true;
    save();
    return sendJson(res, 200, { admin: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    const code = url.searchParams.get('club') ?? '', table = url.searchParams.get('table') ?? '';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SECURITY });
    const stream = { res, userId: user.id, club: code, table };
    streams.add(stream);
    res.write(`data: ${JSON.stringify(view(user, code, table))}\n\n`);
    const watched = db.clubs[code]?.members[user.id] ? db.clubs[code].tables[table] : null;
    if (watched) { watched.lastSeen = Date.now(); schedule(db.clubs[code], watched); }
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); streams.delete(stream); if (watched) watched.lastSeen = Date.now(); if (db.clubs[code]) broadcast(code); });
    if (db.clubs[code]) broadcast(code);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/hand') {
    const club = memberClub(user, url.searchParams.get('club'));
    return sendJson(res, 200, handView(user, club, clubTable(club, url.searchParams.get('table')), Number(url.searchParams.get('no'))));
  }
  if (req.method === 'POST' && url.pathname === '/api/do') {
    const body = await readJson(req);
    const op = Object.hasOwn(ops, body.op) ? ops[body.op] : fail('Orden desconocida');
    const club = body.club && body.op !== 'joinClub' ? memberClub(user, body.club) : null;
    const table = club && body.table ? clubTable(club, body.table) : null;
    if (['sit', 'stand', 'back', 'act', 'setBotSees', 'setAlwaysFull'].includes(body.op) && !table) fail('Falta la mesa');
    if (['grant', 'createTable', 'setSeeCards', 'deleteTables'].includes(body.op) && !club) fail('Falta el club');
    const result = op(user, body, club, table) ?? {};
    save();
    broadcast(club?.code ?? result.code);
    return sendJson(res, 200, result);
  }
  sendJson(res, 404, { error: 'No encontrado' });
}

load();
const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    if (err instanceof UserError || err instanceof IllegalAction) return sendJson(res, 400, { error: err.message });
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Error del servidor' });
  });
});
server.listen(PORT, () => {
  console.log(`Club abierto en http://localhost:${PORT}`);
  if (networkAddress()) console.log(`Amigos en tu misma red: ${networkAddress()}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { writeNow(); process.exit(0); });
