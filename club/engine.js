'use strict';
/* No-Limit Texas Hold'em rules for 2 to 6 players. Pure logic: no network, no timers.
   A hand is a plain object, so tests can drive it with a fixed deck. */
const crypto = require('crypto');
const { evalHand } = require('./evaluator');

const CATEGORIES = ['Carta alta', 'Pareja', 'Doble pareja', 'Trío', 'Escalera', 'Color', 'Full', 'Póker', 'Escalera de color'];
const STREETS = ['preflop', 'flop', 'turn', 'river'];

class IllegalAction extends Error {
  constructor(message) { super(message); this.name = 'IllegalAction'; }
}

function shuffledDeck() {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function pay(p, amount) {
  p.stack -= amount;
  p.bet += amount;
  p.total += amount;
  if (p.stack === 0) p.allIn = true;
}

function record(h, p, type, amount, to) {
  h.log.push({ street: h.street, id: p.id, name: p.name, type, amount, to });
}

function post(h, i, blind, type) {
  const p = h.players[i], amount = Math.min(p.stack, blind);
  pay(p, amount);
  record(h, p, type, amount, p.bet);
}

function needsAction(h, i) {
  const p = h.players[i];
  if (p.folded || p.allIn) return false;
  const others = h.players.filter(q => q !== p && !q.folded);
  if (!others.some(q => !q.allIn) && p.bet >= Math.max(...others.map(q => q.bet))) return false;
  return !p.acted || p.bet < h.currentBet;
}

function nextToAct(h, from) {
  const n = h.players.length;
  for (let k = 0; k < n; k++) {
    const i = (from + k) % n;
    if (needsAction(h, i)) return i;
  }
  return -1;
}

/* players: [{ id, name, seat, stack }] in seat order, all with chips. dealer: index into players. */
function startHand({ players, dealer, sb, bb, deck }) {
  const n = players.length;
  if (n < 2 || n > 6) throw new Error('Una mano necesita de 2 a 6 jugadores');
  const h = {
    players: players.map(p => ({
      id: p.id, name: p.name, seat: p.seat, start: p.stack, stack: p.stack,
      bet: 0, total: 0, folded: false, allIn: false, acted: false, level: -1, cards: [],
    })),
    dealer, sb, bb, deck: deck.slice(), dealt: 0, board: [], street: 0,
    currentBet: bb, minRaise: bb, raiseLevel: 0, fullBase: bb,
    toAct: -1, done: false, log: [], result: null,
  };
  for (let round = 0; round < 2; round++) {
    for (let k = 1; k <= n; k++) h.players[(dealer + k) % n].cards.push(h.deck[h.dealt++]);
  }
  const sbSeat = n === 2 ? dealer : (dealer + 1) % n, bbSeat = (sbSeat + 1) % n;
  post(h, sbSeat, sb, 'sb');
  post(h, bbSeat, bb, 'bb');
  const first = nextToAct(h, (bbSeat + 1) % n);
  if (first >= 0) h.toAct = first; else closeStreet(h);
  return h;
}

function legal(h) {
  const p = h.players[h.toAct];
  const toCall = Math.min(Math.max(h.currentBet - p.bet, 0), p.stack);
  const someoneCanRespond = h.players.some(q => q !== p && !q.folded && !q.allIn);
  const maxTo = p.bet + p.stack;
  return {
    check: toCall === 0,
    call: toCall,
    canRaise: p.stack > toCall && p.level !== h.raiseLevel && someoneCanRespond,
    minTo: Math.min(h.currentBet + h.minRaise, maxTo),
    maxTo,
    isBet: h.currentBet === 0,
  };
}

function act(h, id, { type, to }) {
  if (h.done) throw new IllegalAction('La mano ya terminó');
  const p = h.players[h.toAct];
  if (p.id !== id) throw new IllegalAction('No es tu turno');
  const l = legal(h);
  if (type === 'fold') {
    p.folded = true;
    record(h, p, 'fold', 0, p.bet);
  } else if (type === 'check') {
    if (!l.check) throw new IllegalAction('No puedes pasar: hay una apuesta');
    record(h, p, 'check', 0, p.bet);
  } else if (type === 'call') {
    if (l.call === 0) throw new IllegalAction('No hay nada que igualar');
    pay(p, l.call);
    record(h, p, 'call', l.call, p.bet);
  } else if (type === 'raise') {
    if (!l.canRaise) throw new IllegalAction('No puedes subir ahora');
    if (!Number.isInteger(to) || to < l.minTo || to > l.maxTo) throw new IllegalAction(`La apuesta debe estar entre ${l.minTo} y ${l.maxTo}`);
    const increase = to - h.currentBet, amount = to - p.bet;
    if (increase >= h.minRaise) {
      h.minRaise = increase;
      h.raiseLevel++;
      h.fullBase = to;
    } else if (to - h.fullBase >= h.minRaise) {      /* short all-ins that add up to a full raise reopen the betting */
      h.raiseLevel++;
      h.fullBase = to;
    }
    h.currentBet = to;
    pay(p, amount);
    record(h, p, l.isBet ? 'bet' : 'raise', amount, to);
  } else {
    throw new IllegalAction('Acción desconocida');
  }
  p.acted = true;
  p.level = h.raiseLevel;
  if (h.players.filter(q => !q.folded).length === 1) return finish(h, false);
  const next = nextToAct(h, (h.toAct + 1) % h.players.length);
  if (next >= 0) h.toAct = next; else closeStreet(h);
}

function closeStreet(h) {
  while (h.street < 3) {
    h.street++;
    const cards = h.street === 1 ? 3 : 1;
    for (let i = 0; i < cards; i++) h.board.push(h.deck[h.dealt++]);
    for (const p of h.players) { p.bet = 0; p.acted = false; p.level = -1; }
    h.currentBet = 0; h.minRaise = h.bb; h.raiseLevel = 0; h.fullBase = 0;
    const first = nextToAct(h, (h.dealer + 1) % h.players.length);
    if (first >= 0) { h.toAct = first; return; }
  }
  finish(h, true);
}

/* One layer per distinct contribution. Chips only one player put in come back as a refund. */
function buildPots(h) {
  const levels = [...new Set(h.players.map(p => p.total).filter(t => t > 0))].sort((a, b) => a - b);
  const pots = [];
  let previous = 0, carry = 0;
  for (const level of levels) {
    const payers = h.players.filter(p => p.total > previous);
    const amount = payers.reduce((sum, p) => sum + Math.min(p.total, level) - previous, 0) + carry;
    const eligible = h.players.filter(p => !p.folded && p.total >= level).map(p => p.id);
    previous = level;
    carry = 0;
    const last = pots[pots.length - 1];
    if (eligible.length === 0) {
      if (last) last.amount += amount; else carry = amount;
    } else if (last && last.eligible.join() === eligible.join()) {
      last.amount += amount;
      last.refund = false;
    } else {
      pots.push({ amount, eligible, refund: payers.length === 1 });
    }
  }
  return pots;
}

function finish(h, showdown) {
  h.toAct = -1;
  h.done = true;
  const n = h.players.length, scores = new Map();
  const live = h.players.filter(p => !p.folded);
  if (showdown) for (const p of live) scores.set(p.id, evalHand([...p.cards, ...h.board], 7));
  const final = Object.fromEntries(h.players.map(p => [p.id, p.stack]));
  const leftOfDealer = [];
  for (let k = 1; k <= n; k++) leftOfDealer.push(h.players[(h.dealer + k) % n].id);
  const pots = buildPots(h).map(pot => {
    const best = showdown ? Math.max(...pot.eligible.map(id => scores.get(id))) : 0;
    const winners = showdown ? pot.eligible.filter(id => scores.get(id) === best) : pot.eligible;
    const share = Math.floor(pot.amount / winners.length);
    let odd = pot.amount - share * winners.length;
    const paid = leftOfDealer.filter(id => winners.includes(id)).map(id => {
      const amount = share + (odd > 0 ? 1 : 0);
      if (odd > 0) odd--;
      final[id] += amount;
      return { id, name: h.players.find(p => p.id === id).name, amount };
    });
    return { amount: pot.amount, refund: pot.refund, winners: paid };
  });
  h.result = {
    pots, final,
    showdown: showdown ? live.map(p => ({
      id: p.id, name: p.name, cards: p.cards, hand: CATEGORIES[scores.get(p.id) >> 20],
    })) : [],
  };
}

const potTotal = h => h.players.reduce((sum, p) => sum + p.total, 0);

module.exports = { startHand, act, legal, shuffledDeck, potTotal, buildPots, IllegalAction, STREETS, CATEGORIES };
