/* No-Limit rules engine and the bot that plays from the trained strategy. Needs core.js. */
if (typeof module !== 'undefined') {
  var { SB, BB, STACK, evalHand, preflopBucket, features, bucketOf } = require('./core.js');
  var { riverHands, solveRiver } = require('./solver.js');
}

/* ---------- Rules ---------- */
function newHand(rng) {
  const d = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 0; i < 9; i++) {
    const j = i + Math.floor(rng() * (52 - i));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return { hole: [[d[0], d[1]], [d[2], d[3]]], allBoard: d.slice(4, 9), street: 0, c: [SB, BB], toAct: 0,
           lastRaise: BB, raises: 0, acted: [false, false], over: false, folder: -1 };
}
const SHOWN = [0, 3, 4, 5];
const boardOf = g => g.allBoard.slice(0, SHOWN[g.street]);
function legal(g) {
  const me = g.toAct, opp = 1 - me, call = g.c[opp] - g.c[me];
  const canRaise = g.c[opp] < STACK;
  return { call, canFold: call > 0, canRaise, minTo: Math.min(STACK, g.c[opp] + g.lastRaise), maxTo: STACK };
}
function step(g, a) {
  const me = g.toAct, opp = 1 - me, l = legal(g);
  if (a.t === 'f') {
    if (!l.canFold) throw new Error('no se puede retirar sin apuesta');
    g.over = true; g.folder = me; return;
  }
  if (a.t === 'r') {
    if (!l.canRaise || a.to > STACK || (a.to < l.minTo && a.to !== STACK) || !Number.isInteger(a.to)) throw new Error('subida ilegal ' + a.to);
    g.lastRaise = Math.max(g.lastRaise, a.to - g.c[opp]);
    g.c[me] = a.to; g.raises++;
    g.acted = [false, false]; g.acted[me] = true;
    g.toAct = opp;
    return;
  }
  g.c[me] = g.c[opp];
  g.acted[me] = true;
  if (!g.acted[opp]) { g.toAct = opp; return; }
  if (g.street === 3 || g.c[0] >= STACK) { g.street = 3; g.over = true; return; }
  g.street++; g.acted = [false, false]; g.lastRaise = BB; g.raises = 0; g.toAct = 1;
}
/* Chips won by seat 0. */
function result(g) {
  if (g.folder === 0) return -g.c[0];
  if (g.folder === 1) return g.c[1];
  const a = evalHand(g.hole[0].concat(g.allBoard), 7), b = evalHand(g.hole[1].concat(g.allBoard), 7);
  return a > b ? g.c[0] : a < b ? -g.c[0] : 0;
}

/* ---------- Bot ---------- */
const fracOf = (c, me, to) => { const opp = c[1 - me]; return (to - opp) / (c[0] + c[1] + opp - c[me]); };
class Bot {
  constructor(tree, table, thresholds, rng, samples = 1500, solveIters = 0) {
    this.tree = tree; this.table = table; this.th = [null, thresholds.flop, thresholds.turn, thresholds.river];
    this.rng = rng; this.samples = samples; this.solveIters = solveIters;
  }
  start(seat, g) {
    this.seat = seat; this.node = this.tree.root; this.cache = [null, null, null, null];
    this.hole = g.hole[seat]; this.offTree = false; this.path = []; this.river = null;
  }
  read(g) {                                   /* equity and bucket, once per street */
    const s = g.street;
    if (this.cache[s]) return this.cache[s];
    const b = boardOf(g), [h0, h1] = this.hole;
    const [eq, pot] = features(h0, h1, Uint8Array.from(b), b.length, this.samples, this.rng);
    return this.cache[s] = { eq, bucket: s === 0 ? preflopBucket(h0, h1) : bucketOf(eq, pot, this.th[s]) };
  }
  /* Call before step(g, a) for the opponent's actions. */
  observe(g, a) {
    const n = this.node;
    if (!n || n.kind !== 0) { this.node = null; return; }
    if (a.t === 'f') return;
    const i = a.t === 'c' ? n.acts.findIndex(x => x.t === 'c') : this.mapRaise(n, g, a.to);
    if (i >= 0) this.path.push({ node: n, a: i, seat: g.toAct });
    this.node = i < 0 ? null : n.kids[i];
  }
  /* Randomised pseudo-harmonic mapping (Ganzfried & Sandholm) onto the sizes the bot knows. */
  mapRaise(n, g, to) {
    const rs = [];
    n.acts.forEach((a, i) => { if (a.t === 'r') rs.push({ i, f: fracOf(n.c, n.player, a.to), to: a.to }); });
    if (!rs.length) return -1;
    if (to >= STACK) return rs[rs.length - 1].i;
    const x = fracOf(g.c, g.toAct, to);
    if (x <= rs[0].f) return rs[0].i;
    for (let k = 0; k + 1 < rs.length; k++) {
      const A = rs[k].f, B = rs[k + 1].f;
      if (x <= B) {
        const pA = ((B - x) * (1 + A)) / ((B - A) * (1 + x));
        return this.rng() < pA ? rs[k].i : rs[k + 1].i;
      }
    }
    return rs[rs.length - 1].i;
  }
  mixAt(n, bucket) {
    const A = n.acts.length, i = n.base + bucket * A, m = [];
    let s = 0;
    for (let a = 0; a < A; a++) { const v = this.table[i + a]; m.push(v); s += v; }
    if (s === 0) return m.map(() => 1 / A);
    let keep = 0;
    for (let a = 0; a < A; a++) { m[a] /= s; if (m[a] < 0.04) m[a] = 0; keep += m[a]; }   /* drop noise from rare spots */
    return m.map(v => v / keep);
  }
  act(g) {
    const n = this.node, l = legal(g), r = this.read(g);
    if (this.solveIters && g.street === 3) return this.riverAct(g, r);
    if (!n || n.kind !== 0 || n.player !== this.seat || n.street !== g.street) {
      this.node = null; this.offTree = true;
      return { action: this.fallback(g, l, r), mix: null, eq: r.eq };
    }
    const mix = this.mixAt(n, r.bucket);
    let x = this.rng(), a = 0;
    for (; a < mix.length - 1; a++) { x -= mix[a]; if (x < 0) break; }
    const pick = n.acts[a];
    let action;
    if (pick.t === 'f') {
      const need = l.call / (g.c[0] + g.c[1] + l.call);
      action = !l.canFold || (need < 0.13 && r.eq > 0.25) ? { t: 'c' } : { t: 'f' };
    } else if (pick.t === 'c' || !l.canRaise) action = { t: 'c' };
    else if (pick.to >= STACK) action = { t: 'r', to: STACK };
    else {
      const opp = g.c[1 - g.toAct], pot = g.c[0] + g.c[1] + l.call;
      let to = Math.round((opp + fracOf(n.c, n.player, pick.to) * pot) / 50) * 50;
      to = Math.max(l.minTo, Math.min(STACK, to));
      if (to >= STACK * 0.85) to = STACK;
      action = { t: 'r', to };
    }
    this.path.push({ node: n, a, seat: this.seat });
    this.node = n.kids[a];
    return { action, mix: n.acts.map((t, i) => ({ t: t.t, to: t.to, p: mix[i] })), eq: r.eq };
  }
  /* Bucket of every possible hand on each street, computed once when the river arrives. */
  prepareRiver(g) {
    const board = g.allBoard, hands = riverHands(board), n = hands.length;
    const bk = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
    const bArr = Uint8Array.from(board);
    for (let i = 0; i < n; i++) {
      const { a, b } = hands[i];
      bk[0][i] = preflopBucket(a, b);
      for (let s = 1; s <= 3; s++) {
        const nb = s + 2, [eq, pot] = features(a, b, bArr, nb, 60, this.rng);
        bk[s][i] = bucketOf(eq, pot, this.th[s]);
      }
    }
    this.river = { hands, bk, index: hands.findIndex(h => h.a === Math.min(...this.hole) && h.b === Math.max(...this.hole)) };
  }
  /* What each player can hold, given every action so far. */
  ranges() {
    const { hands, bk } = this.river, n = hands.length;
    const r = [new Float64Array(n).fill(1), new Float64Array(n).fill(1)];
    for (const e of this.path) {
      const w = r[e.seat];
      if (e.solved) { for (let h = 0; h < n; h++) w[h] *= e.solved[h]; continue; }
      const A = e.node.acts.length, B = bk[e.node.street];
      for (let h = 0; h < n; h++) {
        const i = e.node.base + B[h] * A;
        let s = 0;
        for (let a = 0; a < A; a++) s += this.table[i + a];
        w[h] *= s > 0 ? this.table[i + e.a] / s : 1 / A;
      }
    }
    for (const w of r) {                       /* never rule a hand out completely */
      let m = 0;
      for (let h = 0; h < n; h++) m += w[h];
      m /= n;
      for (let h = 0; h < n; h++) w[h] = 0.97 * w[h] + 0.03 * (m || 1);
    }
    return r;
  }
  riverAct(g, r) {
    if (!this.river) this.prepareRiver(g);
    const l = legal(g), opp = 1 - g.toAct;
    const spot = { hands: this.river.hands, ranges: this.ranges(), c: g.c, toAct: g.toAct, lastRaise: g.lastRaise,
                   raises: g.raises, checked: g.acted[opp] && l.call === 0 };
    const { game, root } = solveRiver(spot, this.solveIters);
    const raw = game.average(root, this.river.index);
    let keep = 0;
    const mix = raw.map(p => { const v = p < 0.03 ? 0 : p; keep += v; return v; }).map(v => v / keep);
    let x = this.rng(), a = 0;
    for (; a < mix.length - 1; a++) { x -= mix[a]; if (x < 0) break; }
    const pick = root.acts[a];
    const action = pick.t === 'r' ? { t: 'r', to: pick.to } : { t: pick.t };
    const solved = new Float64Array(this.river.hands.length);
    for (let h = 0; h < solved.length; h++) solved[h] = game.average(root, h)[a];
    const n = this.node;
    if (n && n.kind === 0 && n.player === this.seat && n.street === 3) {
      const i = action.t === 'r' ? this.mapRaise(n, g, action.to) : n.acts.findIndex(q => q.t === action.t);
      this.node = i < 0 ? null : n.kids[i];
    } else this.node = null;
    this.path.push({ solved, seat: this.seat });
    return { action, mix: root.acts.map((q, i) => ({ t: q.t, to: q.to, p: mix[i] })), eq: r.eq, solved: true };
  }
  /* Used only once the hand has left the tree. */
  fallback(g, l, r) {
    const pot = g.c[0] + g.c[1];
    if (l.call === 0) {
      if (l.canRaise && r.eq > 0.8) return { t: 'r', to: Math.min(STACK, Math.max(l.minTo, Math.round((g.c[1 - g.toAct] + pot * 0.6) / 50) * 50)) };
      return { t: 'c' };
    }
    return r.eq >= l.call / (pot + l.call) + 0.14 ? { t: 'c' } : { t: 'f' };
  }
}

if (typeof module !== 'undefined') module.exports = { newHand, boardOf, legal, step, result, Bot, fracOf };
