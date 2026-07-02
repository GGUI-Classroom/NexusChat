const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');
const { DECORATIONS } = require('./shop');
const { avatarUrl } = require('../utils/avatar');

const router = express.Router();
router.use(requireAuth);

const decorationById = new Map(DECORATIONS.map(decoration => [decoration.id, decoration]));

function clientAuction(row) {
  const decoration = decorationById.get(row.decoration_id) || {
    id: row.decoration_id,
    name: row.decoration_id,
    rarity: 'unknown',
    preview: row.decoration_id
  };
  return {
    id: row.id,
    price: row.price,
    createdAt: parseInt(row.created_at, 10),
    sellerId: row.seller_id,
    sellerName: row.seller_display_name || row.seller_username,
    sellerUsername: row.seller_username,
    sellerAvatarDataUrl: avatarUrl(row.seller_id, !!row.seller_has_avatar),
    isMine: row.seller_id === row.viewer_id,
    decoration: {
      id: decoration.id,
      name: decoration.name,
      rarity: decoration.rarity,
      preview: decoration.preview
    }
  };
}

async function loadInventory(userId) {
  const owned = await pool.query(
    `SELECT MIN(id) AS row_id, decoration_id, COUNT(*)::int AS quantity
     FROM user_decorations
     WHERE user_id=$1
       AND id NOT IN (SELECT decoration_row_id FROM decoration_auctions WHERE status='active')
     GROUP BY decoration_id
     ORDER BY decoration_id ASC`,
    [userId]
  );
  return owned.rows.map(row => {
    const decoration = decorationById.get(row.decoration_id);
    if (!decoration) return null;
    return {
      rowId: row.row_id,
      quantity: row.quantity,
      id: decoration.id,
      name: decoration.name,
      rarity: decoration.rarity,
      preview: decoration.preview
    };
  }).filter(Boolean);
}

router.get('/', async (req, res) => {
  const [auctions, inventory, balance] = await Promise.all([
    pool.query(
      `SELECT da.*, u.username AS seller_username, u.display_name AS seller_display_name,
              (u.avatar_data IS NOT NULL) AS seller_has_avatar, $1 AS viewer_id
       FROM decoration_auctions da
       JOIN users u ON u.id=da.seller_id
       WHERE da.status='active'
       ORDER BY da.created_at DESC
       LIMIT 100`,
      [req.session.userId]
    ),
    loadInventory(req.session.userId),
    pool.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId])
  ]);
  res.json({
    nexals: balance.rows[0]?.nexals || 0,
    inventory,
    auctions: auctions.rows.map(clientAuction)
  });
});

router.post('/list', async (req, res) => {
  const decorationId = String(req.body.decorationId || '').trim();
  const price = Math.min(100000000, Math.max(1, parseInt(req.body.price, 10) || 0));
  if (!decorationById.has(decorationId)) return res.status(400).json({ error: 'Unknown decoration' });
  if (!price) return res.status(400).json({ error: 'Enter a valid price' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owned = await client.query(
      `SELECT id FROM user_decorations
       WHERE user_id=$1 AND decoration_id=$2
         AND id NOT IN (SELECT decoration_row_id FROM decoration_auctions WHERE status='active')
       ORDER BY unlocked_at ASC
       LIMIT 1
       FOR UPDATE`,
      [req.session.userId, decorationId]
    );
    if (!owned.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'You do not have an available copy to list' });
    }
    const auctionId = uuidv4();
    await client.query(
      `INSERT INTO decoration_auctions (id, seller_id, decoration_row_id, decoration_id, price)
       VALUES ($1,$2,$3,$4,$5)`,
      [auctionId, req.session.userId, owned.rows[0].id, decorationId, price]
    );
    await client.query('COMMIT');
    res.json({ success: true, auctionId });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('auction list error:', error);
    res.status(500).json({ error: 'Could not list that decoration' });
  } finally {
    client.release();
  }
});

router.post('/:auctionId/buy', async (req, res) => {
  const { auctionId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const auction = await client.query(
      `SELECT * FROM decoration_auctions WHERE id=$1 AND status='active' FOR UPDATE`,
      [auctionId]
    );
    const row = auction.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Auction not found' });
    }
    if (row.seller_id === req.session.userId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You cannot buy your own auction' });
    }
    const buyer = await client.query('SELECT nexals FROM users WHERE id=$1 FOR UPDATE', [req.session.userId]);
    if (!buyer.rows[0] || buyer.rows[0].nexals < row.price) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Not enough Nexals' });
    }
    const stillOwned = await client.query(
      'SELECT id FROM user_decorations WHERE id=$1 AND user_id=$2 FOR UPDATE',
      [row.decoration_row_id, row.seller_id]
    );
    if (!stillOwned.rows.length) {
      await client.query('UPDATE decoration_auctions SET status=$1 WHERE id=$2', ['cancelled', auctionId]);
      await client.query('COMMIT');
      return res.status(409).json({ error: 'Seller no longer owns this item' });
    }
    await client.query('UPDATE users SET nexals=nexals-$1 WHERE id=$2', [row.price, req.session.userId]);
    await client.query('UPDATE users SET nexals=nexals+$1 WHERE id=$2', [row.price, row.seller_id]);
    await client.query('UPDATE user_decorations SET user_id=$1 WHERE id=$2', [req.session.userId, row.decoration_row_id]);
    const sellerRemaining = await client.query(
      'SELECT 1 FROM user_decorations WHERE user_id=$1 AND decoration_id=$2 LIMIT 1',
      [row.seller_id, row.decoration_id]
    );
    if (!sellerRemaining.rows.length) {
      await client.query('UPDATE users SET active_decoration=NULL WHERE id=$1 AND active_decoration=$2', [row.seller_id, row.decoration_id]);
    }
    await client.query(
      `UPDATE decoration_auctions SET status='sold', buyer_id=$1, sold_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$2`,
      [req.session.userId, auctionId]
    );
    const updated = await client.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]);
    await client.query('COMMIT');
    res.json({ success: true, nexals: updated.rows[0].nexals });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('auction buy error:', error);
    res.status(500).json({ error: 'Could not buy this auction' });
  } finally {
    client.release();
  }
});

router.post('/:auctionId/cancel', async (req, res) => {
  const result = await pool.query(
    `UPDATE decoration_auctions SET status='cancelled'
     WHERE id=$1 AND seller_id=$2 AND status='active'
     RETURNING id`,
    [req.params.auctionId, req.session.userId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Auction not found' });
  res.json({ success: true });
});

module.exports = router;
