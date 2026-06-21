const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const tables = new Map();
const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const suits = ['S', 'H', 'D', 'C'];

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function score(hand) {
  let total = hand.reduce((sum, card) => sum + (card.rank === 'A' ? 11 : ['J', 'Q', 'K'].includes(card.rank) ? 10 : Number(card.rank)), 0);
  let aces = hand.filter(card => card.rank === 'A').length;
  while (total > 21 && aces--) total -= 10;
  return total;
}

function state(table) {
  const revealDealer = table.status === 'complete';
  return {
    playerHand: table.playerHand,
    playerScore: score(table.playerHand),
    dealerHand: revealDealer ? table.dealerHand : [table.dealerHand[0], { hidden: true }],
    dealerScore: revealDealer ? score(table.dealerHand) : null,
    chips: table.chips,
    status: table.status,
    result: table.result || null
  };
}

function newRound(userId, chips = 1000) {
  const deck = shuffle(ranks.flatMap(rank => suits.map(suit => ({ rank, suit }))));
  const table = { deck, chips, playerHand: [deck.pop(), deck.pop()], dealerHand: [deck.pop(), deck.pop()], status: 'playing', result: null };
  if (score(table.playerHand) === 21) finish(table);
  tables.set(userId, table);
  return table;
}

function finish(table) {
  while (score(table.dealerHand) < 17) table.dealerHand.push(table.deck.pop());
  const player = score(table.playerHand);
  const dealer = score(table.dealerHand);
  table.status = 'complete';
  if (player > 21) { table.result = 'Bust. Dealer wins this hand.'; table.chips = Math.max(0, table.chips - 50); }
  else if (dealer > 21 || player > dealer) { table.result = 'You win the hand.'; table.chips += 100; }
  else if (player === dealer) table.result = 'Push. The hand is tied.';
  else { table.result = 'Dealer wins this hand.'; table.chips = Math.max(0, table.chips - 50); }
}

router.post('/blackjack/start', (req, res) => res.json({ table: state(newRound(req.session.userId, tables.get(req.session.userId)?.chips || 1000)) }));

router.post('/blackjack/action', (req, res) => {
  const action = String(req.body.action || '');
  const table = tables.get(req.session.userId);
  if (!table || table.status !== 'playing') return res.status(400).json({ error: 'Start a new hand first.' });
  if (action === 'hit') {
    table.playerHand.push(table.deck.pop());
    if (score(table.playerHand) >= 21) finish(table);
  } else if (action === 'stand') finish(table);
  else return res.status(400).json({ error: 'Invalid action.' });
  res.json({ table: state(table) });
});

module.exports = router;
