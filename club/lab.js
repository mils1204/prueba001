'use strict';
/* Experiment: does a bot that sees everyone's cards win, or does it get confused?
   Zorro plays the same seats twice: blind and seeing all cards. Usage: node lab.js [hands per table] */
const { startHand, act, legal, shuffledDeck, potTotal } = require('./engine');
const { decide, equity } = require('./bot/rules.js');

const HANDS = Number(process.argv[2] || 6000), STACK = 10000, rng = Math.random;
const RIVALS = ['rayo', 'roca', 'muro', 'buho', 'zorro'];

function spotFor(h, p, style) {
  const l = legal(h), n = h.players.length, distance = (h.toAct - h.dealer + n) % n;
  return {
    style, hole: p.cards, board: h.board, street: h.street, opponents: h.players.filter(q => q !== p && !q.folded).length,
    pot: potTotal(h), toCall: l.call, currentBet: h.currentBet, canRaise: l.canRaise, minTo: l.minTo, maxTo: l.maxTo, bb: h.bb,
    raises: h.log.filter(e => e.street === h.street && (e.type === 'raise' || e.type === 'bet')).length, late: distance === 0 || distance === n - 1,
  };
}
/* A person-like rival: plays only good hands and does not bluff. */
function patient(h, p) {
  const l = legal(h), eq = equity(p.cards, h.board, 1, 120, rng);
  if (eq > 0.8 && l.canRaise) return { type: 'raise', to: Math.min(l.maxTo, l.minTo * 2) };
  if (l.check) return { type: 'check' };
  return { type: eq > 0.6 ? 'call' : 'fold' };
}

function run(size, seeing, rivalsPatient) {
  const names = ['ojo', ...RIVALS.slice(0, size - 1).map((s, i) => `${s}${i}`)];
  const results = [], tally = { wonHands: 0, showdowns: 0, wonShowdowns: 0, riverCallsBehind: 0, riverFoldsAhead: 0, riverDecisions: 0, leadLost: 0, leads: 0 };
  for (let i = 0; i < HANDS; i++) {
    const players = names.map((id, seat) => ({ id, name: id, seat, stack: STACK }));
    const h = startHand({ players, dealer: i % size, sb: 50, bb: 100, deck: shuffledDeck() });
    let hadLead = false;
    while (!h.done) {
      const p = h.players[h.toAct], me = p.id === 'ojo';
      if (!me && rivalsPatient) { act(h, p.id, patient(h, p)); continue; }
      const spot = spotFor(h, p, me ? 'zorro' : p.id.slice(0, -1));
      if (me && seeing) spot.known = h.players.filter(q => q !== p && !q.folded).map(q => q.cards);
      const move = decide(spot, rng);
      if (me && seeing) {
        const s = spot.why.strength;
        if (h.street === 1 && s >= 0.7) hadLead = true;
        if (h.street === 3 && spot.toCall > 0) {
          tally.riverDecisions++;
          if (move.type === 'call' && s === 0) tally.riverCallsBehind++;
          if (move.type === 'fold' && s === 1) tally.riverFoldsAhead++;
        }
      }
      act(h, p.id, move);
    }
    const net = h.result.final.ojo - STACK;
    results.push(net);
    if (net > 0) tally.wonHands++;
    if (h.result.showdown.some(s => s.id === 'ojo')) { tally.showdowns++; if (net > 0) tally.wonShowdowns++; }
    if (hadLead) { tally.leads++; if (net <= 0) tally.leadLost++; }
  }
  const mean = results.reduce((a, b) => a + b, 0) / results.length;
  const spread = Math.sqrt(results.reduce((a, b) => a + (b - mean) ** 2, 0) / (results.length - 1));
  return { mean, margin: 1.96 * spread / Math.sqrt(results.length), tally };
}

const pct = (a, b) => (b ? (a / b * 100).toFixed(1) : '0.0') + '%';
for (const rivalsPatient of [false, true]) {
  console.log(rivalsPatient ? '\n--- rivales pacientes (solo manos fuertes) ---' : '\n--- rivales: los otros bots ---');
  for (const size of [3, 4, 6]) {
    const blind = run(size, false, rivalsPatient), sees = run(size, true, rivalsPatient), t = sees.tally;
    console.log(`${size} jugadores: sin ver ${blind.mean.toFixed(0)} ±${blind.margin.toFixed(0)} | viendo ${sees.mean.toFixed(0)} ±${sees.margin.toFixed(0)} bb/100`);
    console.log(`   viendo: gana ${pct(t.wonHands, HANDS)} de las manos, ${pct(t.wonShowdowns, t.showdowns)} de sus showdowns | iba +70% en el flop y no ganó: ${pct(t.leadLost, t.leads)} (${t.leads})`);
    console.log(`   errores en river con cartas conocidas: igualó perdiendo ${t.riverCallsBehind}, se retiró ganando ${t.riverFoldsAhead}, de ${t.riverDecisions}`);
  }
}
