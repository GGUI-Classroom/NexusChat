const express = require('express');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/:userId', async (req, res) => {
  const { userId } = req.params;
  const { before, limit = 50 } = req.query;
  const isFriend = await pool.query(
    `SELECT id FROM friendships WHERE (user1_id=$1 AND user2_id=$2) OR (user1_id=$2 AND user2_id=$1)`,
    [req.session.userId, userId]
  );
  if (!isFriend.rows.length) return res.status(403).json({ error: 'Not friends' });

  let query = `SELECT m.id, m.from_id, m.to_id, m.content, m.created_at,
    u.username, u.display_name, u.avatar_data, u.avatar_mime, u.active_decoration, u.active_color
    FROM messages m JOIN users u ON u.id=m.from_id
    WHERE ((m.from_id=$1 AND m.to_id=$2) OR (m.from_id=$2 AND m.to_id=$1))`;
  const params = [req.session.userId, userId];

  if (before) {
    params.push(parseInt(before));
    query += ` AND m.created_at < $${params.length}`;
  }
  query += ` ORDER BY m.created_at DESC LIMIT $${params.length + 1}`;
  params.push(parseInt(limit));

  const r = await pool.query(query, params);
  const msgs = r.rows.reverse();
  res.json({ messages: msgs.map(m => ({
    id: m.id, fromId: m.from_id, toId: m.to_id,
    content: m.content, createdAt: parseInt(m.created_at),
    author: {
      username: m.username, displayName: m.display_name,
      avatarDataUrl: m.avatar_data ? `data:${m.avatar_mime};base64,${m.avatar_data}` : null,
      activeDecoration: m.active_decoration || null,
      activeColor: m.active_color || null
    }
  }))});
});

module.exports = router;
