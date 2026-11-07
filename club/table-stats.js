'use strict';
/* How lively is a table of bots alone? Usage: node table-stats.js [hands per table] */
const { startHand, act, legal, shuffledDeck, potTotal } = require('./engine');
const { decide } = require('./bot/rules.js');

const HANDS = Number(process.argv[2] || 3000), STYLES = ['zorro', 'rayo', 'roca', 'muro', 'buho'], rng = Math.random;

function run(size) {
  const names = STYLES.slice(0, size);
  const stats = { sawFlop: 0, walks: 0, showdowns: 0, pots: [], postflopBets: 0, entered: Object.fromEntries(names.map(n => [n, 0])), raised: Object.fromEntries(names.map(n => [n, 0])) };
  for (let i = 0; i < HANDS; i++) {
    const players = names.map((id, seat) => ({ id, name: id, seat, stack: 10000 }));
    const h = startHand({ players, dealer: i % size, sb: 50, bb: 100, deck: shuffledDeck() });
    const entered = new Set(), raised = new Set();
    while (!h.done) {
      const p = h.players[h.toAct], l = legal(h), n = h.players.length, distance = (h.toAct - h.dealer + n) % n;
      const move = decide({
        style: p.id, hole: p.cards, board: h.board, street: h.street, opponents: h.players.filter(q => q !== p && !q.folded).length,
        pot: potTotal(h), toCall: l.call, currentBet: h.currentBet, canRaise: l.canRaise, minTo: l.minTo, maxTo: l.maxTo, bb: h.bb,
        raises: h.log.filter(e => e.street === h.street && (e.type === 'raise' || e.type === 'bet')).length, late: distance === 0 || distance === n - 1,
      }, rng);
      if (h.street === 0 && (move.type === 'call' || move.type === 'raise')) entered.add(p.id);
      if (h.street === 0 && move.type === 'raise') raised.add(p.id);
      if (h.street > 0 && move.type === 'raise') stats.postflopBets++;
      act(h, p.id, move);
    }
    for (const id of entered) stats.entered[id]++;
    for (const id of raised) stats.raised[id]++;
    if (h.board.length >= 3) stats.sawFlop++; else if (potTotal(h) <= 150) stats.walks++;
    if (h.result.showdown.length) stats.showdowns++;
    stats.pots.push(potTotal(h));
  }
  return stats;
}
const pct = n => `${(n / HANDS * 100).toFixed(0)}%`;
for (const size of [2, 3, 4, 5]) {
  const s = run(size), pots = s.pots.sort((a, b) => a - b);
  console.log(`${size} bots: ven flop ${pct(s.sawFlop)} | ciega gana sin pelea ${pct(s.walks)} | showdown ${pct(s.showdowns)} | bote mediano ${pots[HANDS >> 1]} | apuestas tras el flop por mano ${(s.postflopBets / HANDS).toFixed(2)}`);
  console.log(`   entran: ${Object.entries(s.entered).map(([k, v]) => `${k} ${pct(v)}`).join(' ')} | suben: ${Object.entries(s.raised).map(([k, v]) => `${k} ${pct(v)}`).join(' ')}`);
}
