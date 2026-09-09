/**
 * BiscaEngine.js
 * Pure, stateless rules engine for the card game "BISCA".
 *
 * RULES IMPLEMENTED (from spec):
 *  - 40 card deck: values 1..10 for each of 4 suits.
 *  - Suit hierarchy (absolute): Hearts > Diamonds > Clubs > Spades.
 *  - Number rank (same suit): 10 (high) ... 1 (low).
 *  - Ace of Hearts (Hearts + value 1) is special: when played the owner
 *    declares it "WIN" (beats every card) or "LOSE" (loses to every card).
 *  - Rounds deal descending cards: 5,4,3,2,1,5,4,3,2,1... forever.
 *  - Bidding: each player bids 0..cardsThisRound. The LAST bidder cannot
 *    pick a value that makes the total of all bids equal cardsThisRound.
 *  - Life calc: exact bid => lose 0. Otherwise lose |bid - tricksWon| lives.
 *  - 1-card round is "blind": players never see their own card.
 *  - 5 lives per player. 0 lives => eliminated. Last survivor wins.
 *
 * This module contains ZERO networking / state. RoomManager owns state and
 * calls these helpers. Everything here is deterministic & unit-testable.
 */

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];

// Absolute suit strength. Higher beats lower regardless of number.
const SUIT_RANK = {
  hearts: 4,
  diamonds: 3,
  clubs: 2,
  spades: 1,
};

const SUIT_SYMBOL = {
  hearts: '♥',
  diamonds: '♦',
  clubs: '♣',
  spades: '♠',
};

const START_LIVES = 5;
const ROUND_SEQUENCE = [5, 4, 3, 2, 1]; // repeats forever

/** Build an ordered 40-card deck. */
function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (let value = 1; value <= 10; value++) {
      deck.push({ id: `${suit}-${value}`, suit, value });
    }
  }
  return deck;
}

/** Fisher–Yates shuffle. Returns a NEW shuffled array. */
function shuffle(deck) {
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Deal `cardsPerPlayer` cards to `numPlayers`.
 * Returns { hands: [ [card,...], ... ] }.
 */
function deal(numPlayers, cardsPerPlayer) {
  const deck = shuffle(createDeck());
  const hands = Array.from({ length: numPlayers }, () => []);
  let idx = 0;
  for (let c = 0; c < cardsPerPlayer; c++) {
    for (let p = 0; p < numPlayers; p++) {
      hands[p].push(deck[idx++]);
    }
  }
  return { hands };
}

/** True if the card is the Ace of Hearts (the special card). */
function isAceOfHearts(card) {
  return card.suit === 'hearts' && card.value === 1;
}

/**
 * Numeric strength of a played card, used to find the trick winner.
 * `aceChoice` is 'win' | 'lose' | null and only matters for Ace of Hearts.
 *   - Ace of Hearts + 'win'  => +Infinity (beats all)
 *   - Ace of Hearts + 'lose' => -Infinity (loses to all)
 *   - any other card         => SUIT_RANK * 100 + value  (suit dominates)
 */
function cardStrength(card, aceChoice) {
  if (isAceOfHearts(card)) {
    if (aceChoice === 'win') return Number.POSITIVE_INFINITY;
    if (aceChoice === 'lose') return Number.NEGATIVE_INFINITY;
    return Number.POSITIVE_INFINITY; // defensive: undeclared Ace♥ = strongest
  }
  return SUIT_RANK[card.suit] * 100 + card.value;
}

/**
 * Given the plays of a single trick, return the index (into `plays`) of the
 * winning play.
 * `plays` = [{ playerId, card, aceChoice }, ...] in play order.
 */
function resolveTrick(plays) {
  let bestIdx = 0;
  let bestStrength = cardStrength(plays[0].card, plays[0].aceChoice);
  for (let i = 1; i < plays.length; i++) {
    const s = cardStrength(plays[i].card, plays[i].aceChoice);
    if (s > bestStrength) {
      bestStrength = s;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Validate a bid for the LAST bidder.
 * Returns the forbidden value (a number) or null if this is not the last
 * bidder / no value is forbidden.
 *
 *   forbidden = cardsThisRound - sumOfPreviousBids   (only if in [0..cards])
 */
function forbiddenBid(previousBids, cardsThisRound) {
  const sum = previousBids.reduce((a, b) => a + b, 0);
  const forbidden = cardsThisRound - sum;
  if (forbidden < 0 || forbidden > cardsThisRound) return null;
  return forbidden;
}

/**
 * Check whether `bid` is legal for a player.
 * @param {number} bid
 * @param {number} cardsThisRound
 * @param {boolean} isLastBidder
 * @param {number[]} previousBids bids already made this round (in order)
 */
function isBidLegal(bid, cardsThisRound, isLastBidder, previousBids) {
  if (!Number.isInteger(bid) || bid < 0 || bid > cardsThisRound) return false;
  if (isLastBidder) {
    const forbidden = forbiddenBid(previousBids, cardsThisRound);
    if (forbidden !== null && bid === forbidden) return false;
  }
  return true;
}

/**
 * Compute lives lost for a single player at round end.
 * exact => 0, else absolute difference.
 */
function livesLost(bid, tricksWon) {
  return Math.abs(bid - tricksWon);
}

/**
 * How many cards are dealt for round index `n` (0-based, unbounded).
 * Cycles 5,4,3,2,1,5,4,3,2,1...
 */
function cardsForRound(roundIndex) {
  return ROUND_SEQUENCE[roundIndex % ROUND_SEQUENCE.length];
}

/**
 * Given the number of active (non-eliminated) players and the cards we WANT
 * to deal, clamp so we never exceed the 40-card deck.
 */
function safeCardsPerPlayer(numActivePlayers, desired) {
  const max = Math.floor(40 / Math.max(1, numActivePlayers));
  return Math.min(desired, max);
}

module.exports = {
  SUITS,
  SUIT_RANK,
  SUIT_SYMBOL,
  START_LIVES,
  ROUND_SEQUENCE,
  createDeck,
  shuffle,
  deal,
  isAceOfHearts,
  cardStrength,
  resolveTrick,
  forbiddenBid,
  isBidLegal,
  livesLost,
  cardsForRound,
  safeCardsPerPlayer,
};
