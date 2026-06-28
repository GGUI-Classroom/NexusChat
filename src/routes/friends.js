const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');
const { avatarUrl } = require('../utils/avatar');

const router = express.Router();
router.use(requireAuth);
const NEXUS_GUARD_ID = '00000000-0000-0000-0000-000000000001';

async function relayFriendRequest(payload) {
  const linkUrl = String(process.env.NEXUS_LINK_URL || '').replace(/\/$/, '');
  const secret = process.env.NEXUS_LINK_SHARED_SECRET;
  if (!linkUrl || !secret) return;
  const response = await fetch(`${linkUrl}/relay/friend-request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nexus-link-secret': secret },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`Nexus LINK friend request relay returned ${response.status}`);
}

router.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json({ users: [] });
  const r = await pool.query(
    `SELECT id, username, display_name, (avatar_data IS NOT NULL) AS has_avatar, active_decoration FROM users
     WHERE LOWER(username) LIKE LOWER($1) AND id != $2 AND id != $3 LIMIT 10`,
    [`%${q}%`, req.session.userId, NEXUS_GUARD_ID]
  );
  res.json({ users: r.rows.map(u => ({
    id: u.id, username: u.username, displayName: u.display_name,
    avatarDataUrl: avatarUrl(u.id, !!u.has_avatar),
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
    const requested = await pool.query(
      `INSERT INTO friend_requests (id, from_id, to_id, status) VALUES ($1,$2,$3,'pending')
       ON CONFLICT (from_id, to_id) DO UPDATE SET status='pending' RETURNING id`,
      [uuidv4(), req.session.userId, toId]
    );
    const sender = await pool.query(
      `SELECT u.username, u.display_name, u.avatar_data, u.avatar_mime, ats.server_tag
       FROM users u LEFT JOIN servers ats ON ats.id=u.active_server_tag_id WHERE u.id=$1`,
      [req.session.userId]
    );
    const user = sender.rows[0];
    if (user) {
      relayFriendRequest({
        nexusRecipientId: toId,
        requestId: requested.rows[0].id,
        sender: {
          username: user.username,
          displayName: user.display_name,
          avatarDataUrl: avatarUrl(req.session.userId, !!user.avatar_data),
          activeServerTag: user.server_tag || null
        }
      }).catch(error => console.error('Nexus LINK friend request relay error:', error));
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/requests/incoming', async (req, res) => {
  const r = await pool.query(
    `SELECT fr.id, fr.from_id, fr.created_at, u.username, u.display_name, (u.avatar_data IS NOT NULL) AS has_avatar, u.active_decoration
     FROM friend_requests fr JOIN users u ON u.id=fr.from_id
     WHERE fr.to_id=$1 AND fr.status='pending' AND fr.from_id != $2`,
    [req.session.userId, NEXUS_GUARD_ID]
  );
  res.json({ requests: r.rows.map(r => ({
    id: r.id, fromId: r.from_id, username: r.username, displayName: r.display_name,
    avatarDataUrl: avatarUrl(r.from_id, !!r.has_avatar),
    createdAt: r.created_at,
    activeDecoration: r.active_decoration || null
  }))});
});

router.get('/requests/outgoing', async (req, res) => {
  const r = await pool.query(
    `SELECT fr.id, fr.to_id, fr.created_at, u.username, u.display_name, (u.avatar_data IS NOT NULL) AS has_avatar, u.active_decoration
     FROM friend_requests fr JOIN users u ON u.id=fr.to_id
     WHERE fr.from_id=$1 AND fr.status='pending' AND fr.to_id != $2`,
    [req.session.userId, NEXUS_GUARD_ID]
  );
  res.json({ requests: r.rows.map(r => ({
    id: r.id, toId: r.to_id, username: r.username, displayName: r.display_name,
    avatarDataUrl: avatarUrl(r.to_id, !!r.has_avatar),
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
    `SELECT u.id, u.username, u.display_name, (u.avatar_data IS NOT NULL) AS has_avatar, u.bio, u.status, u.discord_status, u.discord_activity, u.active_decoration, u.active_nameplate, u.pro_expires_at, u.profile_card_style, u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect, u.profile_effect, (u.profile_banner_data IS NOT NULL) AS has_profile_banner, ats.id AS tag_server_id, ats.name AS tag_server_name, ats.invite_code AS tag_invite_code, ats.server_tag, ats.tag_background
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.user1_id=$1 THEN f.user2_id ELSE f.user1_id END
     LEFT JOIN servers ats ON ats.id=u.active_server_tag_id
     WHERE (f.user1_id=$1 OR f.user2_id=$1) AND u.id != $2`,
    [req.session.userId, NEXUS_GUARD_ID]
  );

  // Surface NexusGuard in DMs if there is message history, even without friendship.
  const botDm = await pool.query(
    `SELECT u.id, u.username, u.display_name, (u.avatar_data IS NOT NULL) AS has_avatar, u.bio, u.status, u.active_decoration, u.active_nameplate, u.pro_expires_at, u.profile_card_style, u.profile_gradient_start, u.profile_gradient_end, u.profile_name_effect, u.profile_effect, (u.profile_banner_data IS NOT NULL) AS has_profile_banner
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
    id: u.id, username: u.username, displayName: u.display_name, bio: u.bio || '', status: u.status, discordStatus: u.discord_status || 'offline', discordActivity: u.discord_activity || null, proActive: (u.pro_expires_at || 0) > Math.floor(Date.now() / 1000), profileCardStyle: u.profile_card_style || 'soft', proGradientStart: u.profile_gradient_start, proGradientEnd: u.profile_gradient_end, proNameEffect: u.profile_name_effect, profileEffect: u.profile_effect || 'none', profileBannerUrl: u.has_profile_banner ? `/api/users/banner/${u.id}` : null, activeServerTag: u.server_tag || null, activeServerTagBackground: u.tag_background || '#5865f2', activeServerTagServerId: u.tag_server_id || null, activeServerTagServerName: u.tag_server_name || null, activeServerTagInviteCode: u.tag_invite_code || null,
    avatarDataUrl: avatarUrl(u.id, !!u.has_avatar),
    activeDecoration: u.active_decoration || null,
    activeNameplate: u.active_nameplate || null
  }))});
});

module.exports = router;
