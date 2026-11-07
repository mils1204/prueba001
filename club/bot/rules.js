'use strict';
/* Rule-based bots for tables with 3 to 6 players. They are not trained: they estimate their own strength by
   simulation and follow a style. They only know their own cards and public information. */
const { evalHand } = require('../evaluator');

/* open: preflop strength to enter. value: strength to bet. respect: how much bets scare them.
   aggression: how often a strong hand raises. bluff: how often a weak hand bets. */
const STYLES = {
  zorro: { open: 0.55, value: 0.66, respect: 1.0, aggression: 0.6, bluff: 0.10 },
  rayo:  { open: 0.49, value: 0.60, respect: 0.7, aggression: 0.8, bluff: 0.22 },
  roca:  { open: 0.61, value: 0.72, respect: 1.2, aggression: 0.5, bluff: 0.03 },
  muro:  { open: 0.50, value: 0.74, respect: 0.45, aggression: 0.2, bluff: 0.02 },
  buho:  { open: 0.58, value: 0.64, respect: 1.0, aggression: 0.75, bluff: 0.07 },
};

/* Chance of beating `opponents` random hands, ties counted as a share. */
function equity(hole, board, opponents, samples, rng) {
  const used = new Set([...hole, ...board]), deck = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) deck.push(c);
  const missing = 5 - board.length, need = missing + opponents * 2;
  const mine = new Array(7), theirs = new Array(7);
  let score = 0;
  for (let s = 0; s < samples; s++) {
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(rng() * (deck.length - i));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    for (let i = 0; i < 5; i++) mine[i] = theirs[i] = i < board.length ? board[i] : deck[i - board.length];
    mine[5] = hole[0]; mine[6] = hole[1];
    const me = evalHand(mine, 7);
    let tied = 1, lost = false;
    for (let o = 0; o < opponents && !lost; o++) {
      theirs[5] = deck[missing + o * 2]; theirs[6] = deck[missing + o * 2 + 1];
      const other = evalHand(theirs, 7);
      if (other > me) lost = true;
      else if (other === me) tied++;
    }
    if (!lost) score += 1 / tied;
  }
  return score / samples;
}

function sizeTo(spot, fraction) {
  const raw = spot.currentBet + fraction * (spot.pot + spot.toCall);
  const unit = Math.max(1, Math.round(spot.bb / 10));
  const to = Math.max(spot.minTo, Math.min(spot.maxTo, Math.round(raw / unit) * unit));
  return to >= spot.maxTo * 0.7 ? spot.maxTo : to;        /* a bet this big commits the stack anyway */
}
const passive = spot => ({ type: spot.toCall === 0 ? 'check' : 'fold' });
const between = (rng, low, high) => low + rng() * (high - low);

function preflop(spot, style, rng) {
  const strength = equity(spot.hole, [], 1, 500, rng) + (spot.late ? 0.03 : 0);
  const { toCall, raises, bb, canRaise } = spot;
  spot.why = { strength, price: toCall / (spot.pot + toCall) };
  /* Fewer rivals means more hands are worth playing. */
  const open = style.open - (spot.opponents <= 1 ? 0.07 : spot.opponents === 2 ? 0.04 : 0);
  const crowd = 0.025 * Math.max(0, spot.opponents - 1);    /* the more rivals, the stronger someone's hand tends to be */
  if (raises === 0) {
    if (canRaise && strength >= open && rng() < 0.3 + style.aggression / 2) {
      const callers = Math.max(0, Math.round(spot.pot / bb) - 2);
      return { type: 'raise', to: Math.max(spot.minTo, Math.min(spot.maxTo, Math.round((between(rng, 2.5, 3.2) + callers) * bb))) };
    }
    if (toCall === 0) return { type: 'check' };
    if (strength >= open + crowd || toCall <= bb / 2 && strength >= open - 0.08 + crowd) return { type: 'call' };
    return passive(spot);
  }
  const price = toCall / (spot.pot + toCall);
  const need = open + 0.02 * style.respect * raises + price * 0.08 * style.respect + crowd;
  if (canRaise && strength >= 0.72 + 0.03 * (raises - 1) && rng() < style.aggression) {
    return { type: 'raise', to: strength >= 0.8 && raises >= 2 ? spot.maxTo : sizeTo(spot, 0.9) };
  }
  if (strength >= need || toCall === 0) return toCall === 0 ? { type: 'check' } : { type: 'call' };
  return passive(spot);
}

function postflop(spot, style, rng) {
  const { toCall, pot, canRaise, opponents, raises } = spot;
  /* Per-opponent strength, so a hand reads the same at a full table and heads-up. */
  const strength = equity(spot.hole, spot.board, opponents, 500, rng) ** (1 / opponents);
  spot.why = { strength, price: toCall / (pot + toCall) };
  if (toCall === 0) {
    if (canRaise && strength >= style.value && rng() < 0.85) return { type: 'raise', to: sizeTo(spot, between(rng, 0.5, 0.8)) };
    if (canRaise && opponents <= 2 && strength < 0.5 && rng() < style.bluff) return { type: 'raise', to: sizeTo(spot, between(rng, 0.45, 0.7)) };
    return { type: 'check' };
  }
  const betSize = toCall / Math.max(pot - toCall, 1);
  const pressure = style.respect * (0.10 + 0.10 * Math.min(betSize, 1.5) + 0.06 * Math.max(raises - 1, 0));
  const read = strength - pressure, price = toCall / (pot + toCall);
  if (canRaise && read >= 0.72 && rng() < style.aggression) return { type: 'raise', to: sizeTo(spot, between(rng, 0.7, 1)) };
  if (canRaise && opponents === 1 && raises === 1 && strength < 0.45 && rng() < style.bluff * 0.3) return { type: 'raise', to: sizeTo(spot, 0.8) };
  if (read >= price + 0.05) return { type: 'call' };
  return passive(spot);
}

/* Share of the pot won against exact hands, over the cards still to come. */
function equityAgainst(hole, known, board, samples, rng) {
  const used = new Set([...hole, ...known.flat(), ...board]), deck = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) deck.push(c);
  const missing = 5 - board.length, mine = new Array(7), theirs = new Array(7);
  let score = 0;
  for (let s = 0; s < samples; s++) {
    for (let i = 0; i < missing; i++) {
      const j = i + Math.floor(rng() * (deck.length - i));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    for (let i = 0; i < 5; i++) mine[i] = theirs[i] = i < board.length ? board[i] : deck[i - board.length];
    mine[5] = hole[0]; mine[6] = hole[1];
    const a = evalHand(mine, 7);
    let tied = 1, lost = false;
    for (const hand of known) {
      theirs[5] = hand[0]; theirs[6] = hand[1];
      const b = evalHand(theirs, 7);
      if (b > a) { lost = true; break; }
      if (b === a) tied++;
    }
    if (!lost) score += 1 / tied;
  }
  return score / samples;
}

/* "Cheating" mode: the bot plays against everyone's real cards. It still cannot know the cards to come. */
function withKnownCards(spot, rng) {
  const { toCall, pot, canRaise } = spot;
  const strength = equityAgainst(spot.hole, spot.known, spot.board, 400, rng);
  const price = toCall / (pot + toCall);
  const best = Math.max(...spot.known.map(hand => equity(hand, spot.board, 1, 150, rng)));
  spot.why = { strength, price, saw: true };
  const fair = 1 / (spot.known.length + 1);
  if (canRaise && strength >= Math.max(0.62, fair + 0.2)) return { type: 'raise', to: sizeTo(spot, between(rng, 0.6, 1)) };
  if (canRaise && best < 0.45 && spot.street > 0 && rng() < 0.5) return { type: 'raise', to: sizeTo(spot, 0.7) };   /* it knows they are all weak */
  if (toCall === 0) return { type: 'check' };
  return strength >= price ? { type: 'call' } : { type: 'fold' };
}

function decide(spot, rng) {
  const style = STYLES[spot.style];
  const move = spot.known ? withKnownCards(spot, rng) : spot.street === 0 ? preflop(spot, style, rng) : postflop(spot, style, rng);
  return { ...move, why: spot.why };
}

module.exports = { decide, equity, STYLES };
