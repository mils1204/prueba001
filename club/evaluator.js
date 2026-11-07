'use strict';
/* Copied unchanged from holdem/core.js, where it was checked against all 133,784,560 five-card hands.
   Cards are 0..51: rank = c >> 2 (0 = 2 ... 12 = A), suit = c & 3. */
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

module.exports = { evalHand };
