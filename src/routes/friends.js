const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
const NEXUS_GUARD_ID = '00000000-0000-0000-0000-000000000001';

router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json({ users: [] });
  const r = await pool.query(
    `SELECT id, username, display_name, avatar_data, avatar_mime, active_decoration FROM users
     WHERE LOWER(username) LIKE LOWER($1) AND id != $2 AND id != $3 LIMIT 10`,
    [`%${q}%`, req.session.userId, NEXUS_GUARD_ID]
  );
  res.json({ users: r.rows.map(u => ({
    id: u.id, username: u.username, displayName: u.display_name,
    avatarDataUrl: u.avatar_data ? `data:${u.avatar_mime};base64,${u.avatar_data}` : null,
    activeDecoration: u.active_decoration || null
  }))});
});

router.post('/request', async (req, res) => {
  const { toId } = req.body;
  if (!toId) return res.status(400).json({ error: 'Missing toId' });
  if (toId === req.session.userId) return res.status(400).json({ error: 'Cannot friend yourself' });
  if (toId === NEXUS_GUARD_ID) return res.status(403).json({ error: 'Cannot friend a bot account' });
  const target = await pool.query('SELECT id FROM users WHERE id=$1', [toId]);
  if (!target.rows.length) return res.status(404).json({ error: 'User not found' });
  const already = await pool.query(
    `SELECT id FROM friendships WHERE (user1_id=$1 AND user2_id=$2) OR (user1_id=$2 AND user2_id=$1)`,
    [req.session.userId, toId]
  );
  if (already.rows.length) return res.status(409).json({ error: 'Already friends' });
  const existing = await pool.query(
    `SELECT id, status FROM friend_requests WHERE (from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1)`,
    [req.session.userId, toId]
  );
  if (existing.rows.length && existing.rows[0].status === 'pending')
    return res.status(409).json({ error: 'Request already pending' });
  try {
    await pool.query(
      `INSERT INTO friend_requests (id, from_id, to_id, status) VALUES ($1,$2,$3,'pending')
       ON CONFLICT (from_id, to_id) DO UPDATE SET status='pending'`,
      [uuidv4(), req.session.userId, toId]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/requests/incoming', async (req, res) => {
  const r = await pool.query(
    `SELECT fr.id, fr.from_id, fr.created_at, u.username, u.display_name, u.avatar_data, u.avatar_mime, u.active_decoration
     FROM friend_requests fr JOIN users u ON u.id=fr.from_id
     WHERE fr.to_id=$1 AND fr.status='pending' AND fr.from_id != $2`,
    [req.session.userId, NEXUS_GUARD_ID]
  );
  res.json({ requests: r.rows.map(r => ({
    id: r.id, fromId: r.from_id, username: r.username, displayName: r.display_name,
    avatarDataUrl: r.avatar_data ? `data:${r.avatar_mime};base64,${r.avatar_data}` : null,
    createdAt: r.created_at,
    activeDecoration: r.active_decoration || null
  }))});
});

router.get('/requests/outgoing', async (req, res) => {
  const r = await pool.query(
    `SELECT fr.id, fr.to_id, fr.created_at, u.username, u.display_name, u.avatar_data, u.avatar_mime, u.active_decoration
     FROM friend_requests fr JOIN users u ON u.id=fr.to_id
     WHERE fr.from_id=$1 AND fr.status='pending' AND fr.to_id != $2`,
    [req.session.userId, NEXUS_GUARD_ID]
  );
  res.json({ requests: r.rows.map(r => ({
    id: r.id, toId: r.to_id, username: r.username, displayName: r.display_name,
    avatarDataUrl: r.avatar_data ? `data:${r.avatar_mime};base64,${r.avatar_data}` : null,
    createdAt: r.created_at,
    activeDecoration: r.active_decoration || null
  }))});
});

router.post('/request/:id/respond', async (req, res) => {
  const { id } = req.params;
  const { action } = req.body;
  const fr = await pool.query(
    `SELECT * FROM friend_requests WHERE id=$1 AND to_id=$2 AND status='pending'`,
    [id, req.session.userId]
  );
  if (!fr.rows.length) return res.status(404).json({ error: 'Request not found' });
  const request = fr.rows[0];
  if (request.from_id === NEXUS_GUARD_ID || request.to_id === NEXUS_GUARD_ID) {
    return res.status(403).json({ error: 'Bot friend requests are not allowed' });
  }
  if (action === 'accept') {
    await pool.query(`UPDATE friend_requests SET status='accepted' WHERE id=$1`, [id]);
    await pool.query(`INSERT INTO friendships (id, user1_id, user2_id) VALUES ($1,$2,$3)`,
      [uuidv4(), request.from_id, request.to_id]);
    return res.json({ success: true, action: 'accepted' });
  } else if (action === 'decline') {
    await pool.query(`UPDATE friend_requests SET status='declined' WHERE id=$1`, [id]);
    return res.json({ success: true, action: 'declined' });
  }
  return res.status(400).json({ error: 'Invalid action' });
});

router.delete('/:friendId', async (req, res) => {
  const { friendId } = req.params;
  await pool.query(
    `DELETE FROM friendships WHERE (user1_id=$1 AND user2_id=$2) OR (user1_id=$2 AND user2_id=$1)`,
    [req.session.userId, friendId]
  );
  res.json({ success: true });
});

router.get('/', async (req, res) => {
  const r = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.avatar_data, u.avatar_mime, u.status, u.active_decoration, u.pro_expires_at, u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.user1_id=$1 THEN f.user2_id ELSE f.user1_id END
     WHERE (f.user1_id=$1 OR f.user2_id=$1) AND u.id != $2`,
    [req.session.userId, NEXUS_GUARD_ID]
  );

  // Surface NexusGuard in DMs if there is message history, even without friendship.
  const botDm = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.avatar_data, u.avatar_mime, u.status, u.active_decoration
     FROM users u
     WHERE u.id = $2
       AND EXISTS (
         SELECT 1 FROM messages m
         WHERE (m.from_id=$1 AND m.to_id=$2) OR (m.from_id=$2 AND m.to_id=$1)
       )`,
    [req.session.userId, NEXUS_GUARD_ID]
  );

  const combined = [...r.rows, ...botDm.rows];
  res.json({ friends: combined.map(u => ({
    id: u.id, username: u.username, displayName: u.display_name, status: u.status, proActive: (u.pro_expires_at || 0) > Math.floor(Date.now() / 1000), proGradientStart: u.profile_gradient_start, proGradientEnd: u.profile_gradient_end, proNameEffect: u.profile_name_effect,
    avatarDataUrl: u.avatar_data ? `data:${u.avatar_mime};base64,${u.avatar_data}` : null,
    activeDecoration: u.active_decoration || null
  }))});
});

module.exports = router;
