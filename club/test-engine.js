'use strict';
/* Rule scenarios plus random hands. Usage: node test-engine.js [random hands] */
const assert = require('assert');
const { startHand, act, legal, shuffledDeck, potTotal, IllegalAction } = require('./engine');

const card = text => '23456789TJQKA'.indexOf(text[0]) * 4 + 'shdc'.indexOf(text[1]);
const seats = stacks => stacks.map((stack, i) => ({ id: 'p' + i, name: 'P' + i, seat: i, stack }));

/* holes[i] belongs to the player at that index. Cards go one at a time from left of the dealer. */
function deckFor(holes, board, dealer = 0) {
  const n = holes.length, top = [];
  for (let round = 0; round < 2; round++) {
    for (let k = 1; k <= n; k++) top.push(card(holes[(dealer + k) % n][round]));
  }
  top.push(...board.map(card));
  return [...top, ...shuffledDeck().filter(c => !top.includes(c))];
}
const who = h => h.players[h.toAct].id;
const play = (h, ...moves) => { for (const [type, to] of moves) act(h, who(h), { type, to }); };
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('heads-up: the dealer posts the small blind, acts first preflop and last after', () => {
  const h = startHand({ players: seats([1000, 1000]), dealer: 0, sb: 5, bb: 10, deck: shuffledDeck() });
  assert.equal(h.players[0].bet, 5);
  assert.equal(h.players[1].bet, 10);
  assert.equal(who(h), 'p0');
  play(h, ['call'], ['check']);
  assert.equal(h.street, 1);
  assert.equal(who(h), 'p1');
});

test('three players: the player left of the big blind starts, the big blind keeps the option', () => {
  const h = startHand({ players: seats([1000, 1000, 1000]), dealer: 0, sb: 5, bb: 10, deck: shuffledDeck() });
  assert.equal(h.players[1].bet, 5);
  assert.equal(h.players[2].bet, 10);
  assert.equal(who(h), 'p0');
  play(h, ['call'], ['call']);
  assert.equal(who(h), 'p2');
  assert.equal(legal(h).canRaise, true);
  play(h, ['check']);
  assert.equal(h.street, 1);
  assert.equal(who(h), 'p1');
});

test('minimum raise follows the last full raise', () => {
  const h = startHand({ players: seats([1000, 1000, 1000]), dealer: 0, sb: 5, bb: 10, deck: shuffledDeck() });
  assert.equal(legal(h).minTo, 20);
  assert.throws(() => act(h, 'p0', { type: 'raise', to: 19 }), IllegalAction);
  play(h, ['raise', 40]);
  assert.equal(legal(h).minTo, 70);
});

test('only the player in turn can act', () => {
  const h = startHand({ players: seats([1000, 1000, 1000]), dealer: 0, sb: 5, bb: 10, deck: shuffledDeck() });
  assert.throws(() => act(h, 'p1', { type: 'fold' }), IllegalAction);
  assert.throws(() => act(h, 'p0', { type: 'check' }), IllegalAction);
});

test('a short all-in does not reopen the betting for players who already acted', () => {
  const s = startHand({ players: seats([1000, 145, 1000]), dealer: 0, sb: 5, bb: 10, deck: shuffledDeck() });
  /* p0 first, p1 sb with 145, p2 bb */
  play(s, ['raise', 100], ['raise', 145]);
  assert.equal(who(s), 'p2');
  assert.equal(legal(s).canRaise, true);
  play(s, ['call']);
  assert.equal(who(s), 'p0');
  assert.equal(legal(s).call, 45);
  assert.equal(legal(s).canRaise, false);
  assert.throws(() => act(s, 'p0', { type: 'raise', to: 300 }), IllegalAction);
});

test('side pots: the short stack only wins what it could match', () => {
  const holes = [['As', 'Ah'], ['Ks', 'Kh'], ['Qs', 'Qh']];
  const h = startHand({ players: seats([100, 300, 500]), dealer: 0, sb: 5, bb: 10, deck: deckFor(holes, ['2c', '7d', '9h', 'Jc', '3s']) });
  play(h, ['raise', 100], ['raise', 300], ['call']);
  assert.equal(h.done, true);
  assert.deepEqual(h.result.final, { p0: 300, p1: 400, p2: 200 });
  assert.equal(h.result.pots[0].amount, 300);
  assert.equal(h.result.pots[1].amount, 400);
});

test('uncalled chips return to the bettor', () => {
  const holes = [['2s', '3h'], ['As', 'Ah']];
  const h = startHand({ players: seats([1000, 200]), dealer: 0, sb: 5, bb: 10, deck: deckFor(holes, ['Kc', 'Qd', '9h', 'Jc', '4s']) });
  play(h, ['raise', 1000], ['call']);
  assert.equal(h.done, true);
  assert.deepEqual(h.result.final, { p0: 800, p1: 400 });
  assert.equal(h.result.pots.find(p => p.refund).amount, 800);
});

test('split pot gives the odd chip to the first winner left of the dealer', () => {
  const holes = [['2s', '3h'], ['2d', '3c'], ['4h', '5c']];
  const h = startHand({ players: seats([100, 100, 100]), dealer: 2, sb: 5, bb: 10, deck: deckFor(holes, ['Ac', 'Ad', 'Ah', 'Kd', 'Kh'], 2) });
  /* p2 raises to 21 and everyone calls (63). On the flop p0 bets 10, p1 calls, p2 folds: 83 split in two */
  play(h, ['raise', 21], ['call'], ['call']);
  assert.equal(h.street, 1);
  assert.equal(who(h), 'p0');
  play(h, ['raise', 10], ['call'], ['fold']);
  assert.equal(h.street, 2);
  play(h, ['check'], ['check'], ['check'], ['check']);
  assert.equal(h.done, true);
  assert.deepEqual(h.result.final, { p0: 111, p1: 110, p2: 79 });
  assert.deepEqual(h.result.pots[0].winners.map(w => [w.id, w.amount]), [['p0', 42], ['p1', 41]]);
});

test('a short big blind still sets the price, and the extra comes back', () => {
  const h = startHand({ players: seats([1000, 60]), dealer: 0, sb: 50, bb: 100, deck: shuffledDeck() });
  assert.equal(who(h), 'p0');
  assert.equal(legal(h).canRaise, false);
  play(h, ['call']);
  assert.equal(h.done, true);
  assert.equal(h.result.final.p0 + h.result.final.p1, 1060);
  assert.equal(h.result.pots.find(p => p.refund).amount, 40);
});

test('blinds that put everyone all-in run the board without asking anyone', () => {
  const h = startHand({ players: seats([5, 10]), dealer: 0, sb: 5, bb: 10, deck: shuffledDeck() });
  assert.equal(h.done, true);
  assert.equal(h.board.length, 5);
  assert.equal(h.result.final.p0 + h.result.final.p1, 15);
});

test('nobody is asked to act against a player who is already all-in for less', () => {
  const h = startHand({ players: seats([50, 1000]), dealer: 0, sb: 50, bb: 100, deck: shuffledDeck() });
  assert.equal(h.done, true);
  assert.equal(h.result.final.p0 + h.result.final.p1, 1050);
  const g = startHand({ players: seats([1000, 30, 1000]), dealer: 0, sb: 50, bb: 100, deck: shuffledDeck() });
  play(g, ['fold']);
  assert.equal(g.done, true);
  assert.equal(g.board.length, 5);
  assert.equal(g.result.final.p0, 1000);
  assert.equal(g.result.final.p0 + g.result.final.p1 + g.result.final.p2, 2030);
  assert.deepEqual(g.result.showdown.map(s => s.id), ['p1', 'p2']);
});

test('everyone folding ends the hand without showing cards', () => {
  const h = startHand({ players: seats([1000, 1000, 1000]), dealer: 0, sb: 5, bb: 10, deck: shuffledDeck() });
  play(h, ['fold'], ['fold']);
  assert.equal(h.done, true);
  assert.deepEqual(h.result.final, { p0: 1000, p1: 995, p2: 1005 });
  assert.equal(h.result.showdown.length, 0);
});

function randomHands(count) {
  const totals = { hands: 0, sidePots: 0, showdowns: 0, splits: 0 };
  for (let i = 0; i < count; i++) {
    const n = 2 + Math.floor(Math.random() * 5);
    const stacks = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * (Math.random() < 0.3 ? 40 : 1500)));
    const dealer = Math.floor(Math.random() * n);
    const h = startHand({ players: seats(stacks), dealer, sb: 5, bb: 10, deck: shuffledDeck() });
    let steps = 0;
    while (!h.done) {
      assert.ok(++steps < 300, 'la mano no termina');
      const l = legal(h), p = h.players[h.toAct], r = Math.random();
      assert.ok(!p.folded && !p.allIn, 'turno de un jugador que no puede actuar');
      if (l.canRaise && r < 0.35) {
        const to = r < 0.1 ? l.maxTo : l.minTo + Math.floor(Math.random() * (l.maxTo - l.minTo + 1));
        act(h, p.id, { type: 'raise', to });
      } else if (l.check) act(h, p.id, { type: r > 0.97 ? 'fold' : 'check' });
      else act(h, p.id, { type: r > 0.75 ? 'fold' : 'call' });
    }
    const paid = Object.values(h.result.final);
    assert.equal(paid.reduce((a, b) => a + b, 0), stacks.reduce((a, b) => a + b, 0), 'las fichas no cuadran');
    assert.ok(paid.every(v => Number.isInteger(v) && v >= 0), 'saldo inválido');
    assert.equal(h.result.pots.reduce((a, p) => a + p.amount, 0), potTotal(h), 'botes distintos a lo apostado');
    if (h.result.showdown.length) {
      assert.equal(h.board.length, 5);
      totals.showdowns++;
    }
    h.players.forEach((p, k) => { if (p.folded) assert.ok(paid[k] <= stacks[k], 'un jugador retirado ganó fichas'); });
    if (h.result.pots.filter(p => !p.refund).length > 1) totals.sidePots++;
    if (h.result.pots.some(p => p.winners.length > 1)) totals.splits++;
    totals.hands++;
  }
  return totals;
}

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log('ok    ', name); }
  catch (e) { failed++; console.log('FALLO ', name, '\n      ', e.message); }
}
try { console.log('azar  ', randomHands(Number(process.argv[2] || 200000))); }
catch (e) { failed++; console.log('FALLO  manos al azar\n      ', e.stack); }
console.log(failed ? `${failed} fallos` : 'todo correcto');
process.exit(failed ? 1 : 0);
