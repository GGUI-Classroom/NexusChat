const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const MONTH_SECONDS = 30 * 24 * 60 * 60;
const PRO_PRICE = 15000;
const BOOST_PRICE = 10000;

function nowSeconds() { return Math.floor(Date.now() / 1000); }

async function isServerAdmin(serverId, userId) {
  const result = await pool.query(`
    SELECT s.owner_id, sm.role, sr.is_admin
    FROM servers s
    LEFT JOIN server_members sm ON sm.server_id=s.id AND sm.user_id=$2
    LEFT JOIN server_roles sr ON sr.id=sm.role_id
    WHERE s.id=$1
  `, [serverId, userId]);
  const row = result.rows[0];
  return !!row && (row.owner_id === userId || row.role === 'admin' || row.is_admin);
}

router.get('/', async (req, res) => {
  const now = nowSeconds();
  const [userRes, serversRes] = await Promise.all([
    pool.query('SELECT nexals, pro_expires_at, profile_card_style FROM users WHERE id=$1', [req.session.userId]),
    pool.query(`
      SELECT s.id, s.name, s.server_tag, COUNT(sb.id)::int AS boost_count
      FROM servers s
      JOIN server_members sm ON sm.server_id=s.id AND sm.user_id=$1
      LEFT JOIN server_boosts sb ON sb.server_id=s.id AND sb.expires_at>$2
      GROUP BY s.id
      ORDER BY s.name ASC
    `, [req.session.userId, now])
  ]);
  const user = userRes.rows[0] || {};
  res.json({
    nexals: user.nexals || 0,
    pro: { active: (user.pro_expires_at || 0) > now, expiresAt: user.pro_expires_at || 0, price: PRO_PRICE, styles: ['aurora', 'ember', 'glacier'] },
    servers: serversRes.rows.map(s => ({ id: s.id, name: s.name, boostCount: s.boost_count, tag: s.boost_count >= 2 ? s.server_tag : null, tagUnlocked: s.boost_count >= 2 })),
    boostPrice: BOOST_PRICE,
    boostDurationSeconds: MONTH_SECONDS
  });
});

router.post('/pro/subscribe', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userRes = await client.query('SELECT nexals, pro_expires_at FROM users WHERE id=$1 FOR UPDATE', [req.session.userId]);
    const user = userRes.rows[0];
    if (!user || user.nexals < PRO_PRICE) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Not enough Nexals (need ${PRO_PRICE.toLocaleString()})` });
    }
    const now = nowSeconds();
    const expiresAt = Math.max(now, user.pro_expires_at || 0) + MONTH_SECONDS;
    const updated = await client.query('UPDATE users SET nexals=nexals-$1, pro_expires_at=$2 WHERE id=$3 RETURNING nexals, pro_expires_at', [PRO_PRICE, expiresAt, req.session.userId]);
    await client.query('COMMIT');
    res.json({ success: true, nexals: updated.rows[0].nexals, expiresAt: updated.rows[0].pro_expires_at });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Could not activate Pro' });
  } finally { client.release(); }
});

router.post('/servers/:serverId/boost', async (req, res) => {
  const { serverId } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const member = await client.query('SELECT id FROM server_members WHERE server_id=$1 AND user_id=$2', [serverId, req.session.userId]);
    if (!member.rows.length) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Join the server before boosting it' }); }
    const userRes = await client.query('SELECT nexals FROM users WHERE id=$1 FOR UPDATE', [req.session.userId]);
    if (!userRes.rows[0] || userRes.rows[0].nexals < BOOST_PRICE) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Not enough Nexals (need ${BOOST_PRICE.toLocaleString()})` }); }
    const expiresAt = nowSeconds() + MONTH_SECONDS;
    await client.query('UPDATE users SET nexals=nexals-$1 WHERE id=$2', [BOOST_PRICE, req.session.userId]);
    await client.query('INSERT INTO server_boosts (id, server_id, user_id, expires_at) VALUES ($1,$2,$3,$4)', [uuidv4(), serverId, req.session.userId, expiresAt]);
    const count = await client.query('SELECT COUNT(*)::int AS count FROM server_boosts WHERE server_id=$1 AND expires_at>$2', [serverId, nowSeconds()]);
    const updated = await client.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]);
    await client.query('COMMIT');
    res.json({ success: true, nexals: updated.rows[0].nexals, expiresAt, boostCount: count.rows[0].count, tagUnlocked: count.rows[0].count >= 2 });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Could not boost this server' });
  } finally { client.release(); }
});

router.patch('/servers/:serverId/tag', async (req, res) => {
  const { serverId } = req.params;
  const tag = String(req.body.tag || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,4}$/.test(tag)) return res.status(400).json({ error: 'Server tag must be 1 to 4 letters or numbers' });
  if (!await isServerAdmin(serverId, req.session.userId)) return res.status(403).json({ error: 'Admins only' });
  const boosts = await pool.query('SELECT COUNT(*)::int AS count FROM server_boosts WHERE server_id=$1 AND expires_at>$2', [serverId, nowSeconds()]);
  if (boosts.rows[0].count < 2) return res.status(403).json({ error: 'Two active boosts are required for a server tag' });
  await pool.query('UPDATE servers SET server_tag=$1 WHERE id=$2', [tag, serverId]);
  res.json({ success: true, tag });
});

router.post('/profile-style', async (req, res) => {
  const style = String(req.body.style || '').trim().toLowerCase();
  if (style && !['aurora', 'ember', 'glacier'].includes(style)) return res.status(400).json({ error: 'Invalid profile style' });
  const now = nowSeconds();
  const user = await pool.query('SELECT pro_expires_at FROM users WHERE id=$1', [req.session.userId]);
  if ((user.rows[0]?.pro_expires_at || 0) <= now) return res.status(403).json({ error: 'Active Pro is required' });
  await pool.query('UPDATE users SET profile_card_style=$1 WHERE id=$2', [style || null, req.session.userId]);
  res.json({ success: true, style: style || null });
});

module.exports = router;
