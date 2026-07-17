const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const { pool } = require('../models/db');

const router = express.Router();
router.use(requireAuth);

const tables = new Map();
const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const suits = ['S', 'H', 'D', 'C'];
const TOKEN_NUMERATOR = 1000;
const TOKEN_DENOMINATOR = 900;

function nexalsToTokens(nexals) {
  return Math.floor((Math.max(0, parseInt(nexals, 10) || 0) * TOKEN_NUMERATOR) / TOKEN_DENOMINATOR);
}

function tokensToNexals(tokens) {
  return Math.floor((Math.max(0, parseInt(tokens, 10) || 0) * TOKEN_DENOMINATOR) / TOKEN_NUMERATOR);
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
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
    buyIn: table.buyIn || 0,
    bet: table.bet || 0,
    handsSinceCashout: table.handsSinceCashout,
    status: table.status,
    result: table.result || null
  };
}

function newRound(userId, chips, buyIn = 0, bet = 0) {
  const deck = shuffle(ranks.flatMap(rank => suits.map(suit => ({ rank, suit }))));
  const previous = tables.get(userId);
  const table = { deck, chips, buyIn: previous?.buyIn || buyIn, bet, playerHand: [deck.pop(), deck.pop()], dealerHand: [deck.pop(), deck.pop()], status: 'playing', result: null, handsSinceCashout: previous?.handsSinceCashout || 0 };
  if (score(table.playerHand) === 21) finish(table);
  tables.set(userId, table);
  return table;
}

function finish(table) {
  while (score(table.dealerHand) < 17) table.dealerHand.push(table.deck.pop());
  const player = score(table.playerHand);
  const dealer = score(table.dealerHand);
  const bet = Math.max(0, table.bet || 0);
  table.status = 'complete';
  table.handsSinceCashout += 1;
  if (player > 21) { table.result = `Bust. You lost ${bet.toLocaleString()} tokens.`; table.chips = Math.max(0, table.chips - bet); }
  else if (player === 21 && table.playerHand.length === 2 && !(dealer === 21 && table.dealerHand.length === 2)) { const win = Math.floor(bet * 1.5); table.result = `Blackjack pays 3:2. You won ${win.toLocaleString()} tokens.`; table.chips += win; }
  else if (dealer > 21 || player > dealer) { table.result = `You win ${bet.toLocaleString()} tokens.`; table.chips += bet; }
  else if (player === dealer) table.result = 'Push. The hand is tied.';
  else { table.result = `Dealer wins. You lost ${bet.toLocaleString()} tokens.`; table.chips = Math.max(0, table.chips - bet); }
}

router.post('/blackjack/start', async (req, res) => {
  const requestedBuyIn = Math.min(100000, Math.max(0, parseInt(req.body.buyIn, 10) || 0));
  const requestedBet = Math.min(1000000, Math.max(0, parseInt(req.body.bet, 10) || 0));
  const previous = tables.get(req.session.userId);
  if (previous) {
    const balance = await pool.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]);
    if (previous.status === 'playing') return res.json({ table: state(previous), nexals: balance.rows[0]?.nexals || 0 });
    if (previous.chips <= 0) {
      tables.delete(req.session.userId);
      return res.status(400).json({ error: 'You are out of table tokens. Start a new table with a Nexal buy-in.' });
    }
    if (requestedBet <= 0 || requestedBet > previous.chips) return res.status(400).json({ error: 'Enter a valid token bet for this hand.' });
    return res.json({ table: state(newRound(req.session.userId, previous.chips, previous.buyIn || 0, requestedBet)), nexals: balance.rows[0]?.nexals || 0 });
  }
  if (requestedBuyIn <= 0) return res.status(400).json({ error: 'Choose a Nexal buy-in first.' });
  let startingChips = nexalsToTokens(requestedBuyIn);
  if (startingChips <= 0) return res.status(400).json({ error: 'Buy-in is too small for table tokens.' });
  if (requestedBet <= 0 || requestedBet > startingChips) return res.status(400).json({ error: 'Enter a valid token bet for this hand.' });
  let nexals = null;
  const user = await pool.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]);
  if (!user.rows[0] || user.rows[0].nexals < requestedBuyIn) return res.status(400).json({ error: 'Not enough Nexals for that buy-in.' });
  const updated = await pool.query('UPDATE users SET nexals=nexals-$1 WHERE id=$2 RETURNING nexals', [requestedBuyIn, req.session.userId]);
  nexals = updated.rows[0].nexals;
  if (nexals === null) {
    const balance = await pool.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]);
    nexals = balance.rows[0]?.nexals || 0;
  }
  res.json({ table: state(newRound(req.session.userId, startingChips, requestedBuyIn, requestedBet)), nexals });
});

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

router.post('/blackjack/cashout', async (req, res) => {
  const table = tables.get(req.session.userId);
  if (!table || table.handsSinceCashout < 15) return res.status(400).json({ error: 'Complete 15 hands before cashing out.' });
  const bundles = Math.floor(table.chips / 1000);
  if (!bundles) return res.status(400).json({ error: 'You need at least 1,000 table chips to cash out.' });
  const nexals = bundles * 900;
  table.chips -= bundles * 1000;
  table.handsSinceCashout = 0;
  const updated = await pool.query('UPDATE users SET nexals=nexals+$1 WHERE id=$2 RETURNING nexals', [nexals, req.session.userId]);
  res.json({ success: true, nexals: updated.rows[0].nexals, earned: nexals, table: state(table) });
});

async function settleBlackjackForUser(userId) {
  const table = tables.get(userId);
  if (!table) return { settled: false, nexals: null, earned: 0 };
  tables.delete(userId);
  const earned = tokensToNexals(table.chips || 0);
  if (earned <= 0) return { settled: true, nexals: null, earned: 0 };
  const updated = await pool.query('UPDATE users SET nexals=nexals+$1 WHERE id=$2 RETURNING nexals', [earned, userId]);
  return { settled: true, nexals: updated.rows[0]?.nexals || 0, earned };
}

router.post('/blackjack/close', async (req, res) => {
  const result = await settleBlackjackForUser(req.session.userId);
  res.json({ success: true, ...result });
});

router.settleBlackjackForUser = settleBlackjackForUser;

module.exports = router;
