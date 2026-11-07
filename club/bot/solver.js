/* Real-time river solver: CFR+ over exact hands, with card removal, from the real pot and stacks.
   Needs core.js. A spot is { board, c, toAct, lastRaise, raises, ranges: [Float64Array, Float64Array] }
   with ranges indexed like riverHands(board). */
if (typeof module !== 'undefined') {
  var { STACK, evalHand } = require('./core.js');
}

function riverHands(board) {
  const dead = new Set(board), hands = [], seven = new Uint8Array(7);
  for (let i = 0; i < 5; i++) seven[i + 2] = board[i];
  for (let a = 0; a < 52; a++) {
    if (dead.has(a)) continue;
    for (let b = a + 1; b < 52; b++) {
      if (dead.has(b)) continue;
      seven[0] = a; seven[1] = b;
      hands.push({ a, b, score: evalHand(seven, 7) });
    }
  }
  return hands;
}

const SUB_BETS = [0.33, 0.75, 1.25, 2.5], SUB_RAISES = [0.75, 1.5];
function subTargets(c, me, raises, lastRaise, sizes) {
  const opp = c[1 - me], pot = c[0] + c[1], call = opp - c[me];
  if (raises >= 3 || opp >= STACK) return [];
  const minTo = Math.min(STACK, opp + lastRaise);
  const fr = call === 0 ? sizes.bets : sizes.raises, out = [];
  for (const f of fr) {
    let to = Math.max(minTo, Math.round((opp + (pot + call) * f) / 50) * 50);
    if (to >= STACK * 0.7) to = STACK;
    if (!out.includes(to)) out.push(to);
  }
  if (sizes.allIn !== false && !out.includes(STACK)) out.push(STACK);
  return out;
}
function subTree(c, player, raises, lastRaise, checked, sizes, n) {
  const opp = 1 - player, facing = c[opp] > c[player];
  const node = { kind: 0, player, c, acts: [], kids: [] };
  if (facing) { node.acts.push({ t: 'f', to: c[player] }); node.kids.push({ kind: 1, folder: player, c }); }
  const c2 = c.slice(); c2[player] = c[opp];
  node.acts.push({ t: 'c', to: c[opp] });
  node.kids.push(facing || checked ? { kind: 2, c: c2 } : subTree(c2, opp, raises, lastRaise, true, sizes, n));
  for (const to of subTargets(c, player, raises, lastRaise, sizes)) {
    const c3 = c.slice(); c3[player] = to;
    node.acts.push({ t: 'r', to });
    node.kids.push(subTree(c3, opp, raises + 1, Math.max(to - c[opp], lastRaise), false, sizes, n));
  }
  node.regret = node.acts.map(() => new Float64Array(n));
  node.cum = node.acts.map(() => new Float64Array(n));
  node.sigma = node.acts.map(() => new Float64Array(n));
  return node;
}

class RiverGame {
  constructor(hands, ranges) {
    this.hands = hands; this.n = hands.length; this.ranges = ranges;
    this.order = hands.map((_, i) => i).sort((x, y) => hands[x].score - hands[y].score);
    this.perCard = new Float64Array(52);
  }
  /* Terminal values for the traverser against opponent weights w, blockers included. */
  fold(pay, w, out) {
    const { hands, n, perCard } = this;
    perCard.fill(0);
    let total = 0;
    for (let i = 0; i < n; i++) { total += w[i]; perCard[hands[i].a] += w[i]; perCard[hands[i].b] += w[i]; }
    for (let i = 0; i < n; i++) out[i] = pay * (total - perCard[hands[i].a] - perCard[hands[i].b] + w[i]);
  }
  showdown(stake, w, out) {
    const { hands, n, perCard, order } = this;
    out.fill(0);
    for (let pass = 0; pass < 2; pass++) {       /* ascending counts wins, descending counts losses */
      const sign = pass === 0 ? stake : -stake;
      perCard.fill(0);
      let sum = 0, i = 0;
      while (i < n) {
        const at = k => order[pass === 0 ? k : n - 1 - k];
        const s = hands[at(i)].score;
        let j = i;
        while (j < n && hands[at(j)].score === s) {
          const h = at(j);
          out[h] += sign * (sum - perCard[hands[h].a] - perCard[hands[h].b]);
          j++;
        }
        for (; i < j; i++) {
          const h = at(i);
          sum += w[h]; perCard[hands[h].a] += w[h]; perCard[hands[h].b] += w[h];
        }
      }
    }
  }
  terminal(node, trav, w, out) {
    if (node.kind === 1) this.fold(node.folder === trav ? -node.c[trav] : node.c[node.folder], w, out);
    else this.showdown(node.c[0], w, out);
  }
  match(node) {                                  /* regret matching, all hands at once */
    const A = node.acts.length, n = this.n;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let a = 0; a < A; a++) s += node.regret[a][i];
      for (let a = 0; a < A; a++) node.sigma[a][i] = s > 0 ? node.regret[a][i] / s : 1 / A;
    }
  }
  walk(node, trav, own, opp, t, out) {
    if (node.kind !== 0) return this.terminal(node, trav, opp, out);
    const A = node.acts.length, n = this.n;
    this.match(node);
    const tmp = new Float64Array(n);
    out.fill(0);
    if (node.player !== trav) {
      const w = new Float64Array(n);
      for (let a = 0; a < A; a++) {
        const sg = node.sigma[a];
        for (let i = 0; i < n; i++) w[i] = opp[i] * sg[i];
        this.walk(node.kids[a], trav, own, w, t, tmp);
        for (let i = 0; i < n; i++) out[i] += tmp[i];
      }
      return;
    }
    const vals = [], next = new Float64Array(n);
    for (let a = 0; a < A; a++) {
      const v = new Float64Array(n), sg = node.sigma[a];
      for (let i = 0; i < n; i++) next[i] = own[i] * sg[i];
      this.walk(node.kids[a], trav, next, opp, t, v);
      vals.push(v);
      for (let i = 0; i < n; i++) out[i] += sg[i] * v[i];
    }
    for (let a = 0; a < A; a++) {
      const r = node.regret[a], cu = node.cum[a], sg = node.sigma[a], v = vals[a];
      for (let i = 0; i < n; i++) {
        const x = r[i] + v[i] - out[i];
        r[i] = x > 0 ? x : 0;
        cu[i] += t * own[i] * sg[i];
      }
    }
  }
  average(node, h) {
    let s = 0;
    const m = node.cum.map(c => { s += c[h]; return c[h]; });
    return s > 0 ? m.map(x => x / s) : m.map(() => 1 / m.length);
  }
  /* Best-response value against the average strategy: used by tests to measure convergence. */
  best(node, trav, opp, out) {
    if (node.kind !== 0) return this.terminal(node, trav, opp, out);
    const A = node.acts.length, n = this.n, tmp = new Float64Array(n);
    if (node.player === trav) {
      out.fill(-Infinity);
      for (let a = 0; a < A; a++) {
        this.best(node.kids[a], trav, opp, tmp);
        for (let i = 0; i < n; i++) if (tmp[i] > out[i]) out[i] = tmp[i];
      }
      return;
    }
    out.fill(0);
    const w = new Float64Array(n);
    for (let a = 0; a < A; a++) {
      for (let i = 0; i < n; i++) { const s = this.average(node, i)[a]; w[i] = opp[i] * s; }
      this.best(node.kids[a], trav, w, tmp);
      for (let i = 0; i < n; i++) out[i] += tmp[i];
    }
  }
  /* Chips per hand a perfect opponent gains over the game value, averaged over both seats. */
  exploitability(root) {
    const { ranges, n, hands } = this, out = new Float64Array(n);
    const mass = (x, y) => {
      let s = 0;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        if (hands[i].a === hands[j].a || hands[i].a === hands[j].b || hands[i].b === hands[j].a || hands[i].b === hands[j].b) continue;
        s += x[i] * y[j];
      }
      return s;
    };
    const total = mass(ranges[0], ranges[1]);
    let v = 0;
    for (let p = 0; p < 2; p++) {
      this.best(root, p, ranges[1 - p], out);
      for (let i = 0; i < n; i++) v += ranges[p][i] * out[i];
    }
    return v / total / 2;
  }
}

function solveRiver(spot, iters, sizes = { bets: SUB_BETS, raises: SUB_RAISES }) {
  const { hands, ranges, c, toAct, lastRaise, raises, checked } = spot;
  const game = new RiverGame(hands, ranges);
  const root = subTree(c.slice(), toAct, raises, lastRaise, checked, sizes, hands.length);
  const out = new Float64Array(hands.length);
  for (let t = 1; t <= iters; t++) {
    for (let p = 0; p < 2; p++) game.walk(root, p, ranges[p], ranges[1 - p], t, out);
  }
  return { game, root };
}

if (typeof module !== 'undefined') module.exports = { riverHands, solveRiver, RiverGame };
