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
      SELECT s.id, s.name, s.server_tag, s.tag_background, COUNT(sb.id)::int AS boost_count
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
    servers: serversRes.rows.map(s => ({ id: s.id, name: s.name, boostCount: s.boost_count, tag: s.boost_count >= 2 ? s.server_tag : null, tagBackground: s.tag_background || '#5865f2', tagUnlocked: s.boost_count >= 2 })),
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
  const allocation = await pool.query(`SELECT id FROM server_boost_allocations WHERE server_id=$1 AND feature='tag'`, [serverId]);
  if (!allocation.rows.length) return res.status(403).json({ error: 'Spend two boosts on the server tag first' });
  const background = /^#[0-9a-f]{6}$/i.test(String(req.body.background || '')) ? req.body.background : '#5865f2';
  await pool.query('UPDATE servers SET server_tag=$1, tag_background=$2 WHERE id=$3', [tag, background, serverId]);
  res.json({ success: true, tag });
});

router.post('/servers/:serverId/spend', async (req, res) => {
  const { serverId } = req.params;
  const feature = String(req.body.feature || '');
  if (!['tag', 'gradients'].includes(feature)) return res.status(400).json({ error: 'Invalid boost feature' });
  if (!await isServerAdmin(serverId, req.session.userId)) return res.status(403).json({ error: 'Owners and admins only' });
  const now = nowSeconds();
  const [boosts, allocations] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS count FROM server_boosts WHERE server_id=$1 AND expires_at>$2', [serverId, now]),
    pool.query('SELECT feature FROM server_boost_allocations WHERE server_id=$1', [serverId])
  ]);
  if (allocations.rows.some(row => row.feature === feature)) return res.status(409).json({ error: 'This feature already has boosts allocated' });
  if (boosts.rows[0].count < (allocations.rows.length + 1) * 2) return res.status(400).json({ error: 'Two unallocated active boosts are required' });
  await pool.query('INSERT INTO server_boost_allocations (id, server_id, feature) VALUES ($1,$2,$3)', [uuidv4(), serverId, feature]);
  res.json({ success: true, feature });
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

router.post('/adopt-tag', async (req, res) => {
  const serverId = String(req.body.serverId || '');
  if (!serverId) {
    await pool.query('UPDATE users SET active_server_tag_id=NULL WHERE id=$1', [req.session.userId]);
    return res.json({ success: true, serverId: null });
  }
  const membership = await pool.query(`SELECT s.id, s.server_tag FROM server_members sm JOIN servers s ON s.id=sm.server_id JOIN server_boost_allocations a ON a.server_id=s.id AND a.feature='tag' WHERE sm.user_id=$1 AND s.id=$2`, [req.session.userId, serverId]);
  if (!membership.rows.length || !membership.rows[0].server_tag) return res.status(400).json({ error: 'That server tag is not available to adopt' });
  await pool.query('UPDATE users SET active_server_tag_id=$1 WHERE id=$2', [serverId, req.session.userId]);
  res.json({ success: true, serverId });
});

router.patch('/profile-customize', async (req, res) => {
  const start = String(req.body.gradientStart || ''); const end = String(req.body.gradientEnd || '');
  const effect = String(req.body.nameEffect || 'none');
  if (!/^#[0-9a-f]{6}$/i.test(start) || !/^#[0-9a-f]{6}$/i.test(end) || !['none','shimmer','prism'].includes(effect)) return res.status(400).json({ error: 'Invalid profile customization' });
  const now = nowSeconds();
  const user = await pool.query('SELECT pro_expires_at FROM users WHERE id=$1', [req.session.userId]);
  if ((user.rows[0]?.pro_expires_at || 0) <= now) return res.status(403).json({ error: 'Active Pro is required' });
  await pool.query('UPDATE users SET profile_gradient_start=$1, profile_gradient_end=$2, profile_name_effect=$3 WHERE id=$4', [start, end, effect, req.session.userId]);
  res.json({ success: true });
});

module.exports = router;
