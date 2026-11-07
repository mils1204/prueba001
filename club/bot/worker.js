'use strict';
/* Runs the trained heads-up bot off the main thread, so a river recalculation cannot freeze other tables.
   It only ever receives its own cards, the public board and the public actions. */
const { parentPort } = require('worker_threads');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { SB, BB, STACK, buildTree, makeRng } = require('./core.js');
const { step, legal, Bot } = require('./play.js');
const { decide } = require('./rules.js');

const tree = buildTree();
const table = new Uint8Array(fs.readFileSync(path.join(__dirname, 'strategy.u8')));
const thresholds = JSON.parse(fs.readFileSync(path.join(__dirname, 'thresholds.json'), 'utf8'));
const rng = makeRng(crypto.randomInt(1, 2 ** 31));
const sessions = new Map();                                /* table id -> the hand the bot is following */

function session({ table: id, key, seat, hole }) {
  let s = sessions.get(id);
  if (s?.key === key) return s;
  const hidden = [-1, -1];
  const g = { hole: seat === 0 ? [hole, hidden] : [hidden, hole], allBoard: [], street: 0, c: [SB, BB], toAct: 0,
              lastRaise: BB, raises: 0, acted: [false, false], over: false, folder: -1 };
  const bot = new Bot(tree, table, thresholds, rng, 1500, 100);
  bot.start(seat, g);
  s = { key, seat, g, bot, applied: 0 };
  sessions.set(id, s);
  return s;
}

parentPort.on('message', message => {
  const { id } = message;
  try {
    if (message.spot) return parentPort.postMessage({ id, move: decide(message.spot, rng) });
    const s = session(message);
    s.g.allBoard = message.board;
    for (; s.applied < message.actions.length; s.applied++) {
      const action = { ...message.actions[s.applied] };
      /* scaling can round a legal raise a chip below the bot's own minimum */
      if (action.t === 'r') action.to = Math.min(STACK, Math.max(action.to, legal(s.g).minTo));
      if (s.g.toAct !== s.seat) s.bot.observe(s.g, action);
      step(s.g, action);
    }
    const [dealer, other] = message.chips;
    if (Math.abs(s.g.c[0] - dealer) > 2 || Math.abs(s.g.c[1] - other) > 2 || s.g.toAct !== s.seat) {
      throw new Error(`desincronizado: bot ${s.g.c} turno ${s.g.toAct}, mesa ${message.chips} turno ${s.seat}`);
    }
    const { action, solved, eq, mix } = s.bot.act(s.g);
    parentPort.postMessage({ id, action, why: { strength: eq, mix, solved: !!solved } });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
