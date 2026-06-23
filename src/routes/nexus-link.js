const express = require('express');
const { pool } = require('../models/db');

const router = express.Router();

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
