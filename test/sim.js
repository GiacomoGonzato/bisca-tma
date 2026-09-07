/* Headless full-game simulation of RoomManager (no sockets/express needed). */
const RoomManager = require('../server/game/RoomManager');
const Engine = require('../server/game/BiscaEngine');

// Freeze timers so the sim is deterministic & instant.
const realSetTimeout = global.setTimeout;
global.setTimeout = () => 0; // disable auto-advance timers during manual play

const rm = new RoomManager(() => {});
const room = rm.createRoom('P1', 'Alice', 3);
rm.addPlayer(room.id, 'P2', 'Bob');
rm.addPlayer(room.id, 'P3', 'Cleo');
rm.startGame(room.id, 'P1');

function state(view) { return rm.publicState(room.id, view); }

let guard = 0;
function autoBidder() {
  // Everyone bids the smallest legal value.
  const s = state('P1');
  if (s.phase !== 'betting') return;
  const pid = s.currentTurnId;
  const isLast = room.turnIndex === room.bidOrder.length - 1;
  const prev = room.bidOrder.slice(0, room.turnIndex).map(id => room.bids[id]);
  let bid = 0;
  for (let b = 0; b <= room.cardsThisRound; b++) {
    if (Engine.isBidLegal(b, room.cardsThisRound, isLast, prev)) { bid = b; break; }
  }
  const r = rm.placeBid(room.id, pid, bid);
  if (r.error) throw new Error('bid error ' + r.error);
}

function autoPlayer() {
  const s = state('P1');
  if (s.phase !== 'playing') return;
  const pid = s.currentTurnId;
  const p = room.players.find(x => x.id === pid);
  const card = p.hand[0];
  const ace = Engine.isAceOfHearts(card) ? 'win' : null;
  const r = rm.playCard(room.id, pid, room.blind ? '__blind__' : card.id, ace);
  if (r.error) throw new Error('play error ' + r.error);
}

// Drive rounds manually until game over (or safety cap).
let rounds = 0;
while (state('P1').phase !== 'gameOver' && guard++ < 5000) {
  const s = state('P1');
  if (s.phase === 'betting') { autoBidder(); }
  else if (s.phase === 'playing') { autoPlayer(); }
  else if (s.phase === 'roundEnd') {
    // Manually advance to next round (timers are disabled).
    rounds++;
    const active = room.players.filter(p => !p.eliminated);
    if (active.length <= 1) { rm._endGame(room); break; }
    room.roundIndex++;
    room.dealerIndex = (room.dealerIndex + 1) % active.length;
    rm._beginRound(room);
  }
}

const fin = state('P1');
console.log('Phase:', fin.phase);
console.log('Rounds played:', rounds);
console.log('Winner:', fin.winnerName);
console.log('Final lives:', fin.players.map(p => `${p.name}:${p.lives}${p.eliminated ? '(out)' : ''}`).join('  '));

// Sanity checks
const assert = require('assert');
assert.strictEqual(fin.phase, 'gameOver', 'game should end');
assert.ok(fin.winnerId, 'must have a winner');
const survivors = fin.players.filter(p => !p.eliminated);
assert.strictEqual(survivors.length, 1, 'exactly one survivor');
assert.ok(survivors[0].lives >= 1, 'winner has >=1 life');
console.log('\nFull-game simulation PASSED ✅');
global.setTimeout = realSetTimeout;
