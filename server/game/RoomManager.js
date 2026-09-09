/**
 * RoomManager.js
 * In-memory manager for BISCA game rooms.
 *
 * Owns ALL mutable state: rooms, players, hands, bids, tricks, timers.
 * Uses BiscaEngine for pure rules. Emits nothing itself — server.js wires
 * callbacks so this file stays transport-agnostic.
 *
 * Phases: 'lobby' -> 'betting' -> 'playing' -> 'roundEnd' -> (loop) -> 'gameOver'
 */

const Engine = require('./BiscaEngine');

const TURN_MS = 30000;         // per-decision timer (bid or play)
const ROUND_END_MS = 6000;     // pause on the round summary
const RECONNECT_GRACE_MS = 60000;

function genRoomId() {
  // 5-char uppercase, unambiguous (no 0/O/1/I).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 5; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

class RoomManager {
  /**
   * @param {(roomId:string)=>void} onUpdate  called whenever a room's public
   *        state changes and clients should be re-rendered.
   */
  constructor(onUpdate = () => {}) {
    this.rooms = new Map();
    this.onUpdate = onUpdate;
    this.timers = new Map(); // roomId -> timeout handle
  }

  // ---------------------------------------------------------------- rooms ---

  createRoom(hostId, hostName, maxPlayers) {
    let id;
    do { id = genRoomId(); } while (this.rooms.has(id));
    const room = {
      id,
      hostId,
      maxPlayers: Math.min(8, Math.max(2, maxPlayers | 0)),
      phase: 'lobby',
      players: [],           // {id,name,lives,hand,connected,eliminated,socketId}
      roundIndex: 0,
      cardsThisRound: 0,
      dealerIndex: 0,
      turnIndex: 0,          // whose turn (bet or play)
      bids: {},              // playerId -> number
      bidOrder: [],          // playerIds in bidding order (this round)
      tricksWon: {},         // playerId -> count
      currentTrick: [],      // {playerId, card, aceChoice}
      trickLeaderIndex: 0,
      lastTrick: null,       // {plays, winnerId} for display
      roundSummary: null,    // [{playerId,name,bid,won,lost,lives}]
      winnerId: null,
      turnDeadline: 0,
      pendingAce: null,      // playerId currently choosing ace, or null
      log: [],
    };
    this.rooms.set(id, room);
    this.addPlayer(id, hostId, hostName);
    return room;
  }

  getRoom(id) {
    return this.rooms.get(id);
  }

  addPlayer(roomId, playerId, name) {
    const room = this.rooms.get(roomId);
    if (!room) return { error: 'ROOM_NOT_FOUND' };

    const existing = room.players.find((p) => p.id === playerId);
    if (existing) {
      existing.connected = true;
      existing.name = name || existing.name;
      this._clearReconnect(room, playerId);
      this._emit(roomId);
      return { room, player: existing, rejoined: true };
    }

    if (room.phase !== 'lobby') return { error: 'GAME_IN_PROGRESS' };
    if (room.players.length >= room.maxPlayers) return { error: 'ROOM_FULL' };

    const player = {
      id: playerId,
      name: name || `Player ${room.players.length + 1}`,
      lives: Engine.START_LIVES,
      hand: [],
      connected: true,
      eliminated: false,
      socketId: null,
    };
    room.players.push(player);
    this._emit(roomId);
    return { room, player };
  }

  setSocket(roomId, playerId, socketId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const p = room.players.find((x) => x.id === playerId);
    if (p) p.socketId = socketId;
  }

  // -------------------------------------------------------------- lifecycle -

  startGame(roomId, requesterId) {
    const room = this.rooms.get(roomId);
    if (!room) return { error: 'ROOM_NOT_FOUND' };
    if (room.hostId !== requesterId) return { error: 'NOT_HOST' };
    if (room.phase !== 'lobby') return { error: 'ALREADY_STARTED' };
    if (room.players.length < 2) return { error: 'NEED_2_PLAYERS' };

    room.roundIndex = 0;
    room.dealerIndex = 0;
    this._beginRound(room);
    return { room };
  }

  _activePlayers(room) {
    return room.players.filter((p) => !p.eliminated);
  }

  _beginRound(room) {
    const active = this._activePlayers(room);
    if (active.length <= 1) return this._endGame(room);

    const desired = Engine.cardsForRound(room.roundIndex);
    const cards = Engine.safeCardsPerPlayer(active.length, desired);
    room.cardsThisRound = cards;

    const { hands } = Engine.deal(active.length, cards);
    active.forEach((p, i) => {
      p.hand = hands[i];
    });

    // Dealer index refers to position among ACTIVE players.
    room.dealerIndex = room.dealerIndex % active.length;

    // Reset per-round state.
    room.bids = {};
    room.tricksWon = {};
    active.forEach((p) => { room.tricksWon[p.id] = 0; });
    room.currentTrick = [];
    room.roundSummary = null;
    room.lastTrick = null;
    room.pendingAce = null;

    // Betting starts left of dealer, proceeds clockwise.
    room.bidOrder = [];
    for (let k = 1; k <= active.length; k++) {
      room.bidOrder.push(active[(room.dealerIndex + k) % active.length].id);
    }
    room.turnIndex = 0; // index into bidOrder
    room.phase = 'betting';
    room.blind = cards === 1;

    this._startTurnTimer(room, () => this._autoBid(room));
    this._emit(room.id);
  }

  // ------------------------------------------------------------- betting ----

  placeBid(roomId, playerId, bid) {
    const room = this.rooms.get(roomId);
    if (!room || room.phase !== 'betting') return { error: 'NOT_BETTING' };

    const expectedId = room.bidOrder[room.turnIndex];
    if (expectedId !== playerId) return { error: 'NOT_YOUR_TURN' };

    const isLast = room.turnIndex === room.bidOrder.length - 1;
    const prevBids = room.bidOrder
      .slice(0, room.turnIndex)
      .map((id) => room.bids[id]);

    if (!Engine.isBidLegal(bid, room.cardsThisRound, isLast, prevBids)) {
      return { error: 'ILLEGAL_BID' };
    }

    room.bids[playerId] = bid;
    room.log.push(`${this._name(room, playerId)} bids ${bid}`);
    room.turnIndex++;

    if (room.turnIndex >= room.bidOrder.length) {
      this._beginPlaying(room);
    } else {
      this._startTurnTimer(room, () => this._autoBid(room));
      this._emit(roomId);
    }
    return { room };
  }

  _autoBid(room) {
    if (room.phase !== 'betting') return;
    const playerId = room.bidOrder[room.turnIndex];
    const isLast = room.turnIndex === room.bidOrder.length - 1;
    const prevBids = room.bidOrder.slice(0, room.turnIndex).map((id) => room.bids[id]);
    // Pick smallest legal bid (default safe choice).
    let bid = 0;
    for (let b = 0; b <= room.cardsThisRound; b++) {
      if (Engine.isBidLegal(b, room.cardsThisRound, isLast, prevBids)) { bid = b; break; }
    }
    this.placeBid(room.id, playerId, bid);
  }

  // ------------------------------------------------------------- playing ----

  _beginPlaying(room) {
    room.phase = 'playing';
    // First trick led by player left of dealer (first bidder).
    const active = this._activePlayers(room);
    room.trickLeaderIndex = (room.dealerIndex + 1) % active.length;
    room.turnIndex = room.trickLeaderIndex;
    room.currentTrick = [];
    this._startTurnTimer(room, () => this._autoPlay(room));
    this._emit(room.id);
  }

  /**
   * Play a card. For the Ace of Hearts, `aceChoice` ('win'|'lose') is required.
   */
  playCard(roomId, playerId, cardId, aceChoice) {
    const room = this.rooms.get(roomId);
    if (!room || room.phase !== 'playing') return { error: 'NOT_PLAYING' };

    const active = this._activePlayers(room);
    const expected = active[room.turnIndex % active.length];
    if (!expected || expected.id !== playerId) return { error: 'NOT_YOUR_TURN' };

    const player = expected;
    let cardIdx;
    if (room.blind) {
      // Blind round: player cannot know their card id — they always play the
      // single card they hold. Accept the '__blind__' sentinel (or any id).
      cardIdx = 0;
    } else {
      cardIdx = player.hand.findIndex((c) => c.id === cardId);
    }
    if (cardIdx === -1 || !player.hand[cardIdx]) return { error: 'CARD_NOT_IN_HAND' };
    const card = player.hand[cardIdx];

    if (Engine.isAceOfHearts(card)) {
      if (aceChoice !== 'win' && aceChoice !== 'lose') {
        return { error: 'ACE_CHOICE_REQUIRED' };
      }
    } else {
      aceChoice = null;
    }

    // Commit the play.
    player.hand.splice(cardIdx, 1);
    room.currentTrick.push({ playerId, card, aceChoice });
    room.log.push(`${player.name} plays ${card.value}${Engine.SUIT_SYMBOL[card.suit]}`);

    if (room.currentTrick.length >= active.length) {
      this._resolveTrick(room);
    } else {
      room.turnIndex = (room.turnIndex + 1) % active.length;
      this._startTurnTimer(room, () => this._autoPlay(room));
      this._emit(roomId);
    }
    return { room };
  }

  _autoPlay(room) {
    if (room.phase !== 'playing') return;
    const active = this._activePlayers(room);
    const player = active[room.turnIndex % active.length];
    if (!player || player.hand.length === 0) return;
    const card = player.hand[0];
    const ace = Engine.isAceOfHearts(card) ? 'lose' : null;
    this.playCard(room.id, player.id, card.id, ace);
  }

_resolveTrick(room) {
  const active = this._activePlayers(room);
  const winIdx = Engine.resolveTrick(room.currentTrick);
  const winnerId = room.currentTrick[winIdx].playerId;
  room.tricksWon[winnerId] =
    (room.tricksWon[winnerId] || 0) + 1;
  // Save the completed trick so clients can display it.
  room.lastTrick = {
    plays: room.currentTrick.slice(),
    winnerId,
  };
  room.log.push(
    `${this._name(room, winnerId)} wins the trick`
  );
  // The trick winner leads the next trick.
  room.turnIndex = active.findIndex(
    (player) => player.id === winnerId
  );
  // All cards from the completed trick are now stored in lastTrick.
  room.currentTrick = [];
  const cardsLeft = active[0].hand.length;
  if (cardsLeft === 0) {
    this._endRound(room);
    return;
  }
  // Publish lastTrick so clients can display it.
  this._emit(room.id);
  // Wait 2.5 seconds only for visual presentation.
  this._timeout(room, () => {
    // Prevent an obsolete callback from changing another phase.
    if (room.phase !== 'playing') return;
    // Start the normal 30-second action timer.
    this._startTurnTimer(
      room,
      () => this._autoPlay(room),
      TURN_MS
    );
    // Publish the new turn deadline.
    this._emit(room.id);
  }, 2500);
}

  // ----------------------------------------------------------- round end ----

  _endRound(room) {
    this._clearTimer(room);
    const active = this._activePlayers(room);
    const summary = [];
    active.forEach((p) => {
      const bid = room.bids[p.id] ?? 0;
      const won = room.tricksWon[p.id] ?? 0;
      const lost = Engine.livesLost(bid, won);
      p.lives = Math.max(0, p.lives - lost);
      summary.push({ playerId: p.id, name: p.name, bid, won, lost, lives: p.lives });
    });
    room.roundSummary = summary;
    room.phase = 'roundEnd';

    // Eliminate the dead.
    room.players.forEach((p) => {
      if (!p.eliminated && p.lives <= 0) {
        p.eliminated = true;
        room.log.push(`${p.name} is eliminated`);
      }
    });

    this._emit(room.id);

    // Advance to next round (or end) after a display pause.
    this._timeout(room, () => {
      const stillActive = this._activePlayers(room);
      if (stillActive.length <= 1) return this._endGame(room);
      room.roundIndex++;
      // Rotate dealer to next active seat.
      room.dealerIndex = (room.dealerIndex + 1) % stillActive.length;
      this._beginRound(room);
    }, ROUND_END_MS);
  }

  _endGame(room) {
    this._clearTimer(room);
    const survivors = this._activePlayers(room);
    room.winnerId = survivors.length === 1 ? survivors[0].id : null;
    room.phase = 'gameOver';
    room.log.push(room.winnerId ? `${this._name(room, room.winnerId)} wins the game!` : 'Game over');
    this._emit(room.id);
  }

  // -------------------------------------------------------- disconnect ------

  handleDisconnect(roomId, playerId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const p = room.players.find((x) => x.id === playerId);
    if (!p) return;
    p.connected = false;

    if (room.phase === 'lobby') {
      // Remove from lobby entirely.
      room.players = room.players.filter((x) => x.id !== playerId);
      if (room.players.length === 0) {
        this._clearTimer(room);
        this.rooms.delete(roomId);
        return;
      }
      if (room.hostId === playerId) room.hostId = room.players[0].id;
      this._emit(roomId);
      return;
    }

    // Mid-game: keep seat, allow reconnection within grace window.
    this._emit(roomId);
    this._setReconnect(room, playerId);
  }

  _setReconnect(room, playerId) {
    room._reconnect = room._reconnect || {};
    if (room._reconnect[playerId]) clearTimeout(room._reconnect[playerId]);
    room._reconnect[playerId] = setTimeout(() => {
      const p = room.players.find((x) => x.id === playerId);
      if (p && !p.connected && !p.eliminated) {
        // Forfeit WITHOUT shrinking the active set mid-round.
        // lives=0 → the round-end logic eliminates them safely.
        p.forfeit = true;
        p.lives = 0;
        room.log.push(`${p.name} left and forfeited`);
        // If it's currently their turn, keep the flow moving.
        if (room.phase === 'betting') this._autoBid(room);
        else if (room.phase === 'playing') this._autoPlay(room);
        else if (room.phase === 'lobby') {
          room.players = room.players.filter((x) => x.id !== playerId);
        }
        this._emit(room.id);
      }
    }, RECONNECT_GRACE_MS);
  }

  _clearReconnect(room, playerId) {
    if (room._reconnect && room._reconnect[playerId]) {
      clearTimeout(room._reconnect[playerId]);
      delete room._reconnect[playerId];
    }
  }

  // ------------------------------------------------------------- timers -----

  _startTurnTimer(room, onExpire, ms = TURN_MS) {
    this._clearTimer(room);
    room.turnDeadline = Date.now() + ms;
    const handle = setTimeout(() => onExpire(), ms);
    this.timers.set(room.id, handle);
  }

  _timeout(room, fn, ms) {
    this._clearTimer(room);
    const handle = setTimeout(fn, ms);
    this.timers.set(room.id, handle);
  }

  _clearTimer(room) {
    const h = this.timers.get(room.id);
    if (h) { clearTimeout(h); this.timers.delete(room.id); }
    room.turnDeadline = 0;
  }

  // ---------------------------------------------------------- serialization -

  /**
   * Public view of a room, tailored per viewer.
   * `viewerId` is the player requesting it — they see their own hand, except
   * during a blind (1-card) round where they see everyone ELSE's card only.
   */
  publicState(roomId, viewerId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const currentTurnId =
      room.phase === 'betting' ? room.bidOrder[room.turnIndex] :
      room.phase === 'playing' ? (this._activePlayers(room)[room.turnIndex % Math.max(1, this._activePlayers(room).length)] || {}).id :
      null;

    const players = room.players.map((p) => {
      const isSelf = p.id === viewerId;
      let hand = [];
      let handCount = p.hand.length;
      if (room.blind && room.phase !== 'lobby' && room.phase !== 'roundEnd' && room.phase !== 'gameOver') {
        // Blind round: you can see OTHERS' cards, not your own.
        hand = isSelf ? p.hand.map(() => null) : p.hand.slice();
      } else {
        hand = isSelf ? p.hand.slice() : p.hand.map(() => null);
      }
      return {
        id: p.id,
        name: p.name,
        lives: p.lives,
        connected: p.connected,
        eliminated: p.eliminated,
        isSelf,
        isHost: p.id === room.hostId,
        bid: room.bids[p.id] ?? null,
        tricksWon: room.tricksWon[p.id] ?? 0,
        handCount,
        hand,        // array of card objects; null = hidden
      };
    });

    // Forbidden bid hint for the last bidder (client convenience).
    let forbidden = null;
    if (room.phase === 'betting') {
      const isLast = room.turnIndex === room.bidOrder.length - 1;
      if (isLast) {
        const prev = room.bidOrder.slice(0, room.turnIndex).map((id) => room.bids[id]);
        forbidden = Engine.forbiddenBid(prev, room.cardsThisRound);
      }
    }

    return {
      id: room.id,
      phase: room.phase,
      hostId: room.hostId,
      maxPlayers: room.maxPlayers,
      roundIndex: room.roundIndex,
      roundNumber: room.roundIndex + 1,
      cardsThisRound: room.cardsThisRound,
      blind: !!room.blind,
      dealerId: (this._activePlayers(room)[room.dealerIndex] || {}).id || null,
      currentTurnId,
      forbiddenBid: forbidden,
      players,
      currentTrick: room.currentTrick.map((t) => ({
        playerId: t.playerId,
        name: this._name(room, t.playerId),
        card: t.card,
        aceChoice: t.aceChoice,
      })),
      lastTrick: room.lastTrick && {
        winnerId: room.lastTrick.winnerId,
        winnerName: this._name(room, room.lastTrick.winnerId),
        plays: room.lastTrick.plays.map((t) => ({
          name: this._name(room, t.playerId), card: t.card, aceChoice: t.aceChoice,
        })),
      },
      roundSummary: room.roundSummary,
      winnerId: room.winnerId,
      winnerName: room.winnerId ? this._name(room, room.winnerId) : null,
      turnDeadline: room.turnDeadline,
      log: room.log.slice(-12),
    };
  }

  _name(room, playerId) {
    const p = room.players.find((x) => x.id === playerId);
    return p ? p.name : '???';
  }

  _emit(roomId) {
    this.onUpdate(roomId);
  }
}

module.exports = RoomManager;
