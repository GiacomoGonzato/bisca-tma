/* Minimal assertion-based tests for BiscaEngine. Run: npm test */
const assert = require('assert');
const E = require('../server/game/BiscaEngine');

let passed = 0;
function ok(cond, name) { assert.ok(cond, name); console.log('  ✓', name); passed++; }

console.log('BiscaEngine tests');

// Deck
ok(E.createDeck().length === 40, '40-card deck');
ok(new Set(E.createDeck().map(c => c.id)).size === 40, 'all cards unique');

// Suit hierarchy (absolute): clubs-1 beats spades-10
ok(E.resolveTrick([{ card: { suit: 'spades', value: 10 } }, { card: { suit: 'clubs', value: 1 } }]) === 1,
  '♣ beats ♠ regardless of number');
ok(E.resolveTrick([{ card: { suit: 'diamonds', value: 10 } }, { card: { suit: 'hearts', value: 2 } }]) === 1,
  '♥ beats ♦');
// same suit -> number decides
ok(E.resolveTrick([{ card: { suit: 'clubs', value: 3 } }, { card: { suit: 'clubs', value: 9 } }]) === 1,
  'higher number wins same suit');

// Ace of hearts
ok(E.resolveTrick([{ card: { suit: 'hearts', value: 10 } }, { card: { suit: 'hearts', value: 1 }, aceChoice: 'win' }]) === 1,
  'Ace of Hearts WIN beats hearts-10');
ok(E.resolveTrick([{ card: { suit: 'spades', value: 1 } }, { card: { suit: 'hearts', value: 1 }, aceChoice: 'lose' }]) === 0,
  'Ace of Hearts LOSE loses to spades-1');

// Bidding constraint
ok(E.forbiddenBid([2, 1], 5) === 2, 'forbidden = 5-(2+1) = 2');
ok(E.forbiddenBid([3, 3], 5) === null, 'forbidden out of range -> null');
ok(E.isBidLegal(2, 5, true, [2, 1]) === false, 'last bidder cannot make sum == cards');
ok(E.isBidLegal(3, 5, true, [2, 1]) === true, 'last bidder legal alternative');
ok(E.isBidLegal(2, 5, false, [2, 1]) === true, 'non-last bidder unconstrained');
ok(E.isBidLegal(6, 5, false, []) === false, 'bid cannot exceed cards');

// Lives
ok(E.livesLost(3, 1) === 2, 'bid 3 got 1 -> lose 2');
ok(E.livesLost(0, 2) === 2, 'bid 0 got 2 -> lose 2');
ok(E.livesLost(2, 2) === 0, 'exact bid -> lose 0');

// Round sequence
ok([0, 1, 2, 3, 4, 5].map(E.cardsForRound).join(',') === '5,4,3,2,1,5', 'round cycle 5..1,5');

// Deck safety for 8 players
ok(E.safeCardsPerPlayer(8, 5) === 5, '8 players * 5 = 40 cards ok');
ok(E.safeCardsPerPlayer(9, 5) === 4, '9 players clamps to 4');

// Deal integrity
const { hands } = E.deal(4, 5);
const flat = hands.flat();
ok(flat.length === 20, 'dealt 20 cards to 4 players');
ok(new Set(flat.map(c => c.id)).size === 20, 'no duplicate cards dealt');

console.log(`\n${passed} tests passed ✅`);
