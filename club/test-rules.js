'use strict';
/* Plays the rule bots straight on the engine. Usage: node test-rules.js [hands per rival] */
const assert = require('assert');
const { startHand, act, legal, shuffledDeck, potTotal } = require('./engine');
const { decide, equity, STYLES } = require('./bot/rules.js');

const HANDS = Number(process.argv[2] || 3000), STACK = 10000, rng = Math.random;
const close = (value, target, room, label) => assert.ok(Math.abs(value - target) < room, `${label}: ${value.toFixed(3)} y se esperaba ${target}`);
const card = text => '23456789TJQKA'.indexOf(text[0]) * 4 + 'shdc'.indexOf(text[1]);

close(equity([card('As'), card('Ah')], [], 1, 40000, rng), 0.852, 0.01, 'AA contra 1');
close(equity([card('7s'), card('2h')], [], 1, 40000, rng), 0.346, 0.01, '72 contra 1');
close(equity([card('As'), card('Ah')], [], 2, 40000, rng), 0.734, 0.012, 'AA contra 2');
console.log('ok     la simulación de fuerza coincide con valores conocidos');

const rivals = {
  'siempre iguala': (l) => ({ type: l.check ? 'check' : 'call' }),
  'al azar agresivo': (l) => {
    const r = rng();
    if (l.canRaise && r < 0.35) return { type: 'raise', to: r < 0.07 ? l.maxTo : l.minTo + Math.floor(rng() * Math.min(l.maxTo - l.minTo + 1, 3000)) };
    if (l.check) return { type: 'check' };
    return { type: r > 0.8 ? 'fold' : 'call' };
  },
  'solo manos fuertes': (l, h, p) => {
    const eq = equity(p.cards, h.board, 1, 150, rng);
    if (eq > 0.8 && l.canRaise) return { type: 'raise', to: Math.min(l.maxTo, l.minTo * 2) };
    if (l.check) return { type: 'check' };
    return { type: eq > 0.6 ? 'call' : 'fold' };
  },
};

function spotFor(h, p, style) {
  const l = legal(h), n = h.players.length, distance = (h.toAct - h.dealer + n) % n;
  return {
    style, hole: p.cards, board: h.board, street: h.street, opponents: h.players.filter(q => q !== p && !q.folded).length,
    pot: potTotal(h), toCall: l.call, currentBet: h.currentBet, canRaise: l.canRaise, minTo: l.minTo, maxTo: l.maxTo, bb: h.bb,
    raises: h.log.filter(e => e.street === h.street && (e.type === 'raise' || e.type === 'bet')).length, late: distance === 0 || distance === n - 1,
  };
}
function session(bots, rival, cheating = false) {
  const styles = Object.keys(STYLES).slice(0, bots), results = [], actions = { fold: 0, check: 0, call: 0, raise: 0 };
  const seen = Object.fromEntries(styles.map(s => [s, { hands: 0, entered: 0 }]));
  for (let i = 0; i < HANDS; i++) {
    const players = [{ id: 'human', name: 'H', seat: 0, stack: STACK }, ...styles.map((s, k) => ({ id: s, name: s, seat: k + 1, stack: STACK }))];
    const h = startHand({ players, dealer: i % players.length, sb: 50, bb: 100, deck: shuffledDeck() });
    while (!h.done) {
      const p = h.players[h.toAct], l = legal(h);
      if (p.id === 'human') { act(h, p.id, rival(l, h, p)); continue; }
      const spot = spotFor(h, p, p.id);
      if (cheating && p.id === 'zorro') spot.known = h.players.filter(q => q !== p && !q.folded).map(q => q.cards);
      const move = decide(spot, rng);
      actions[move.type]++;
      if (h.street === 0 && move.type !== 'fold' && move.type !== 'check') seen[p.id].entered++;
      act(h, p.id, move);                                  /* an illegal move throws and fails the test */
    }
    for (const s of styles) seen[s].hands++;
    assert.equal(Object.values(h.result.final).reduce((a, b) => a + b, 0), players.length * STACK);
    results.push(h.result.final.human - STACK);
  }
  const mean = results.reduce((a, b) => a + b, 0) / results.length;
  const spread = Math.sqrt(results.reduce((a, b) => a + (b - mean) ** 2, 0) / (results.length - 1));
  return { mean: -mean, margin: 1.96 * spread / Math.sqrt(results.length), actions, seen };
}

for (const bots of [2, 5]) {
  for (const [name, rival] of Object.entries(rivals)) {
    const r = session(bots, rival);
    const entry = Object.entries(r.seen).map(([s, v]) => `${s} ${(v.entered / v.hands * 100).toFixed(0)}%`).join(' ');
    console.log(`dato   ${bots} bots contra "${name}": rival pierde ${r.mean.toFixed(0)} ±${r.margin.toFixed(0)} bb/100 | entran: ${entry} | ${JSON.stringify(r.actions)}`);
  }
}
for (const [name, rival] of Object.entries(rivals)) {
  const r = session(2, rival, true);
  console.log(`dato   Zorro VE todas las cartas, contra "${name}": rival pierde ${r.mean.toFixed(0)} ±${r.margin.toFixed(0)} bb/100`);
}
console.log('todo correcto');
