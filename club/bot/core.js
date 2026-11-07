/* Heads-up No-Limit Texas Hold'em core. Runs in Node (training) and the browser (play).
   Cards are 0..51: rank = c >> 2 (0 = 2 ... 12 = A), suit = c & 3.
   Seat 0 is the button/small blind: acts first preflop, second postflop. */
const SB = 50, BB = 100, STACK = 10000;

/* ---------- Hand evaluator ---------- */
const POP = new Uint8Array(8192), STRAIGHT = new Uint8Array(8192);
for (let m = 0; m < 8192; m++) {
  let p = 0;
  for (let b = 0; b < 13; b++) if (m >> b & 1) p++;
  POP[m] = p;
  const w = (m << 1) | (m >> 12 & 1);           /* bit 0 = ace low */
  for (let top = 13; top >= 4; top--) {
    if ((w >> (top - 4) & 31) === 31) { STRAIGHT[m] = top; break; }   /* top: 4 = five-high ... 13 = ace-high */
  }
}
function topBits(mask, n) {                     /* highest n ranks packed in 4-bit nibbles */
  let out = 0, got = 0;
  for (let r = 12; r >= 0 && got < n; r--) if (mask >> r & 1) { out = out << 4 | (r + 1); got++; }
  return out << (4 * (n - got));
}
const CNT = new Uint8Array(13);
/* Higher score = better hand. Category sits in bits 20+: 0 high card ... 8 straight flush. */
function evalHand(cards, n) {
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  CNT.fill(0);
  for (let i = 0; i < n; i++) {
    const c = cards[i], r = c >> 2, b = 1 << r;
    CNT[r]++;
    switch (c & 3) { case 0: s0 |= b; break; case 1: s1 |= b; break; case 2: s2 |= b; break; default: s3 |= b; }
  }
  const fl = POP[s0] >= 5 ? s0 : POP[s1] >= 5 ? s1 : POP[s2] >= 5 ? s2 : POP[s3] >= 5 ? s3 : 0;
  if (fl && STRAIGHT[fl]) return 8 << 20 | STRAIGHT[fl];
  let any = 0, pairs = 0, trips = 0, quad = -1;
  for (let r = 12; r >= 0; r--) {
    const k = CNT[r];
    if (k === 0) continue;
    any |= 1 << r;
    if (k === 4) { if (quad < 0) quad = r; }
    else if (k === 3) trips |= 1 << r;
    else if (k === 2) pairs |= 1 << r;
  }
  if (quad >= 0) return 7 << 20 | (quad + 1) << 4 | topBits(any & ~(1 << quad), 1);
  if (trips) {
    const t = 31 - Math.clz32(trips), rest = (trips & ~(1 << t)) | pairs;
    if (rest) return 6 << 20 | (t + 1) << 4 | (32 - Math.clz32(rest));
  }
  if (fl) return 5 << 20 | topBits(fl, 5);
  if (STRAIGHT[any]) return 4 << 20 | STRAIGHT[any];
  if (trips) {
    const t = 31 - Math.clz32(trips);
    return 3 << 20 | (t + 1) << 8 | topBits(any & ~(1 << t), 2);
  }
  if (pairs) {
    const p1 = 31 - Math.clz32(pairs), rest = pairs & ~(1 << p1);
    if (rest) {
      const p2 = 31 - Math.clz32(rest);
      return 2 << 20 | (p1 + 1) << 8 | (p2 + 1) << 4 | topBits(any & ~(1 << p1) & ~(1 << p2), 1);
    }
    return 1 << 20 | (p1 + 1) << 12 | topBits(any & ~(1 << p1), 3);
  }
  return topBits(any, 5);
}

/* ---------- Hand features ---------- */
function makeRng(seed) {                        /* xorshift32: fast, seedable */
  let x = seed | 0 || 2463534242;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
}
/* The 169 distinct starting hands, 0..168. */
const PRE_MAP = (() => {
  const m = new Int16Array(13 * 13 * 2).fill(-1);
  let k = 0;
  for (let hi = 0; hi < 13; hi++) for (let lo = 0; lo <= hi; lo++) {
    m[(hi * 13 + lo) * 2] = k++;                /* offsuit or pair */
    if (lo < hi) m[(hi * 13 + lo) * 2 + 1] = k++;
  }
  return m;
})();
function preflopBucket(a, b) {
  let hi = a >> 2, lo = b >> 2;
  if (hi < lo) { const t = hi; hi = lo; lo = t; }
  return PRE_MAP[(hi * 13 + lo) * 2 + ((a & 3) === (b & 3) ? 1 : 0)];
}
/* Equity against a random hand with a random runout, and strength on the current board.
   potential = equity - strength: how much the hand gains from cards still to come. */
const DECK = new Uint8Array(52), H7 = new Uint8Array(7), O7 = new Uint8Array(7);
function features(h0, h1, board, nb, samples, rng) {
  let k = 0;
  for (let c = 0; c < 52; c++) {
    if (c === h0 || c === h1) continue;
    let used = false;
    for (let i = 0; i < nb; i++) if (board[i] === c) used = true;
    if (!used) DECK[k++] = c;
  }
  const need = 7 - 2 - nb + 2;                  /* cards to draw: runout + opponent's two */
  H7[0] = h0; H7[1] = h1;
  for (let i = 0; i < nb; i++) { H7[i + 2] = board[i]; O7[i + 2] = board[i]; }
  const nowScore = evalHand(H7, nb + 2);
  let eq = 0, st = 0;
  for (let s = 0; s < samples; s++) {
    for (let i = 0; i < need; i++) {            /* partial Fisher-Yates */
      const j = i + Math.floor(rng() * (k - i));
      const t = DECK[i]; DECK[i] = DECK[j]; DECK[j] = t;
    }
    O7[0] = DECK[0]; O7[1] = DECK[1];
    const oppNow = evalHand(O7, nb + 2);
    st += nowScore > oppNow ? 1 : nowScore === oppNow ? 0.5 : 0;
    if (nb === 5) continue;
    for (let i = 2; i < need; i++) { H7[nb + i] = DECK[i]; O7[nb + i] = DECK[i]; }
    const a = evalHand(H7, 7), b = evalHand(O7, 7);
    eq += a > b ? 1 : a === b ? 0.5 : 0;
  }
  st /= samples;
  return nb === 5 ? [st, 0] : [eq / samples, eq / samples - st];
}
/* Postflop bucket from thresholds fitted on the training pool. */
function bucketOf(eq, pot, th) {
  let e = 0;
  while (e < th.eq.length && eq >= th.eq[e]) e++;
  if (!th.pot) return e;
  return e * 2 + (pot >= th.pot[e] ? 1 : 0);
}
const BUCKETS = [169, 24, 24, 16];

/* ---------- Betting tree (the abstraction the bot reasons in) ---------- */
function raiseTargets(street, c, me, raises, lastRaise, overbets = true) {
  const opp = c[1 - me], pot = c[0] + c[1], call = opp - c[me];
  const maxRaises = street === 0 ? 4 : 3;
  if (raises >= maxRaises || opp >= STACK) return [];
  const minTo = Math.min(STACK, opp + lastRaise);
  let t;
  if (street === 0) {
    if (raises === 0) t = me === 0 ? [250, 400] : [300, 500];
    else if (raises === 1) t = [opp * 3];
    else if (raises === 2) t = [opp * 2.3];
    else t = [];
  } else if (raises === 0) t = (overbets ? [0.33, 0.75, 1.25, 2.5] : [0.33, 0.75, 1.25]).map(f => opp + pot * f);
  else t = (overbets ? [0.75, 1.5] : [0.75]).map(f => opp + (pot + call) * f);
  const out = [];
  for (const x of t) {
    let to = Math.max(minTo, Math.round(x / 50) * 50);
    if (to >= STACK * 0.7) to = STACK;
    if (!out.includes(to)) out.push(to);
  }
  if (!out.includes(STACK)) out.push(STACK);
  return out;
}
function buildTree(overbets = true) {
  const nodes = [];
  let slots = 0;
  const leaf = (kind, c, folder) => {
    const n = { id: nodes.length, kind, c, folder, acts: [], kids: [] };
    nodes.push(n); return n;
  };
  function closeRound(street, c) {
    if (street === 3 || c[0] >= STACK) return leaf(2, c, -1);
    return node(street + 1, c, 1, 0, BB, false);
  }
  function node(street, c, player, raises, lastRaise, checked) {
    const n = { id: nodes.length, kind: 0, street, player, c, raises, lastRaise, acts: [], kids: [], base: 0 };
    nodes.push(n);
    const opp = 1 - player, facing = c[opp] > c[player];
    if (facing) {
      n.acts.push({ t: 'f', to: c[player] });
      n.kids.push(leaf(1, c, player));
    }
    const c2 = c.slice(); c2[player] = c[opp];
    n.acts.push({ t: 'c', to: c[opp] });
    if (street === 0 && raises === 0 && player === 0) n.kids.push(node(0, c2, 1, 0, BB, true));   /* limp: the big blind keeps its option */
    else if (facing || checked) n.kids.push(closeRound(street, c2));
    else n.kids.push(node(street, c2, opp, raises, lastRaise, true));
    for (const to of raiseTargets(street, c, player, raises, lastRaise, overbets)) {
      const c3 = c.slice(); c3[player] = to;
      n.acts.push({ t: 'r', to });
      n.kids.push(node(street, c3, opp, raises + 1, Math.max(to - c[opp], lastRaise), false));
    }
    n.base = slots;
    slots += BUCKETS[street] * n.acts.length;
    return n;
  }
  const root = node(0, [SB, BB], 0, 0, BB, false);
  return { root, nodes, slots };
}

if (typeof module !== 'undefined') module.exports = { SB, BB, STACK, evalHand, makeRng, preflopBucket, features, bucketOf, BUCKETS, raiseTargets, buildTree, POP, STRAIGHT };
