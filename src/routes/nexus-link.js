const express = require('express');
const crypto = require('crypto');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

async function nexusLinkService(path, options = {}) {
  const linkUrl = String(process.env.NEXUS_LINK_URL || '').replace(/\/$/, '');
  const sharedSecret = process.env.NEXUS_LINK_SHARED_SECRET;
  if (!linkUrl || !sharedSecret) throw new Error('Nexus LINK is not configured');
  const response = await fetch(`${linkUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-nexus-link-secret': sharedSecret,
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Nexus LINK request failed');
  return data;
}

// The browser must already be authenticated to Nexus. This creates the signed
// state consumed by the separate Nexus LINK OAuth service.
router.get('/connect', requireAuth, (req, res) => {
  const linkUrl = String(process.env.NEXUS_LINK_URL || '').replace(/\/$/, '');
  const stateSecret = process.env.NEXUS_LINK_STATE_SECRET;
  if (!linkUrl || !stateSecret) return res.status(503).send('Nexus LINK account connection is not configured yet.');
  const nexusUserId = req.session.userId;
  const signature = crypto.createHmac('sha256', stateSecret).update(nexusUserId).digest('hex');
  const params = new URLSearchParams({ nexus_user_id: nexusUserId, signature });
  res.redirect(`${linkUrl}/auth/discord/start?${params}`);
});

router.get('/settings', requireAuth, async (req, res) => {
  try {
    res.json(await nexusLinkService(`/connection/${encodeURIComponent(req.session.userId)}`));
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

router.patch('/settings', requireAuth, async (req, res) => {
  try {
    const settings = {};
    for (const key of ['dmRelayEnabled', 'attachmentsEnabled', 'statusSyncEnabled', 'messageNotificationsEnabled', 'callNotificationsEnabled']) {
      if (typeof req.body[key] === 'boolean') settings[key] = req.body[key];
    }
    res.json(await nexusLinkService(`/connection/${encodeURIComponent(req.session.userId)}`, {
      method: 'PATCH',
      body: JSON.stringify(settings)
    }));
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

function requireNexusLinkSecret(req, res, next) {
  const secret = process.env.NEXUS_LINK_SHARED_SECRET;
  if (!secret || req.get('x-nexus-link-secret') !== secret) {
    return res.status(401).json({ error: 'Unauthorized Nexus LINK request' });
  }
  next();
}

async function isNexusServerAdmin(serverId, userId) {
  const result = await pool.query(
    `SELECT s.id
     FROM servers s
     LEFT JOIN server_members sm ON sm.server_id=s.id AND sm.user_id=$2
     LEFT JOIN server_roles sr ON sr.id=sm.role_id
     WHERE s.id=$1
       AND (s.owner_id=$2 OR sm.role='admin' OR sr.is_admin=TRUE)`,
    [serverId, userId]
  );
  return Boolean(result.rows[0]);
}

router.use(requireNexusLinkSecret);

router.post('/status', async (req, res) => {
  const status = ['online', 'idle', 'dnd', 'offline'].includes(req.body.status) ? req.body.status : 'offline';
  const activity = String(req.body.activity || '').trim().slice(0, 120) || null;
  const userId = String(req.body.nexusUserId || '');
  if (!userId) return res.status(400).json({ error: 'Nexus user ID is required' });
  const updated = await pool.query('UPDATE users SET discord_status=$1, discord_activity=$2 WHERE id=$3 RETURNING id', [status, activity, userId]);
  if (!updated.rows.length) return res.status(404).json({ error: 'Nexus user was not found' });
  const io = req.app.get('io');
  io.to(`user:${userId}`).emit('status_change', { userId, discordStatus: status, discordActivity: activity });
  const friends = await pool.query(
    `SELECT CASE WHEN user1_id=$1 THEN user2_id ELSE user1_id END AS user_id
     FROM friendships WHERE user1_id=$1 OR user2_id=$1`,
    [userId]
  );
  friends.rows.forEach(friend => io.to(`user:${friend.user_id}`).emit('status_change', { userId, discordStatus: status, discordActivity: activity }));
  res.json({ success: true, status, activity });
});

// Used only by the Nexus LINK bot to populate its Discord configuration menus.
router.get('/users/:userId/servers', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT s.id, s.name
       FROM servers s
       LEFT JOIN server_members sm ON sm.server_id=s.id AND sm.user_id=$1
       LEFT JOIN server_roles sr ON sr.id=sm.role_id
       WHERE s.owner_id=$1 OR sm.role='admin' OR sr.is_admin=TRUE
       ORDER BY LOWER(s.name) ASC
       LIMIT 25`,
      [req.params.userId]
    );
    res.json({ servers: result.rows.map(row => ({ id: row.id, name: row.name })) });
  } catch (error) {
    console.error('Nexus LINK server list failed:', error);
    res.status(500).json({ error: 'Nexus could not load the server list. Check NexusChat Render logs.' });
  }
});

router.get('/users/:userId/servers/:serverId/channels', async (req, res) => {
  try {
    if (!await isNexusServerAdmin(req.params.serverId, req.params.userId)) {
      return res.status(403).json({ error: 'Nexus admin permission required' });
    }
    const result = await pool.query(
      `SELECT id, name
       FROM channels
       WHERE server_id=$1 AND COALESCE(channel_type, 'text')='text'
       ORDER BY position ASC
       LIMIT 25`,
      [req.params.serverId]
    );
    res.json({ channels: result.rows.map(row => ({ id: row.id, name: row.name })) });
  } catch (error) {
    console.error('Nexus LINK channel list failed:', error);
    res.status(500).json({ error: 'Nexus could not load the channel list. Check NexusChat Render logs.' });
  }
});

module.exports = router;
