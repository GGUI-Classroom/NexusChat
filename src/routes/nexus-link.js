const express = require('express');
const crypto = require('crypto');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

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

// Used only by the Nexus LINK bot to populate its Discord configuration menus.
router.get('/users/:userId/servers', async (req, res) => {
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
});

router.get('/users/:userId/servers/:serverId/channels', async (req, res) => {
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
});

module.exports = router;
