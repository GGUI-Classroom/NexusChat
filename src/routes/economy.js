const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);

async function serverAccess(serverId, userId) {
  const result = await pool.query(
    `SELECT s.owner_id, sm.role AS member_role, sr.is_admin
     FROM servers s
     JOIN server_members sm ON sm.server_id=s.id AND sm.user_id=$2
     LEFT JOIN server_roles sr ON sr.id=sm.role_id
     WHERE s.id=$1`,
    [serverId, userId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    ownerId: row.owner_id,
    isOwner: row.owner_id === userId,
    canManage: row.owner_id === userId || row.member_role === 'admin' || !!row.is_admin
  };
}

function itemForClient(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    price: row.price,
    active: !!row.active,
    createdAt: parseInt(row.created_at, 10),
    sold: parseInt(row.sold || 0, 10),
    rewardRole: row.reward_role_id ? {
      id: row.reward_role_id,
      name: row.reward_role_name || 'Role',
      color: row.reward_role_color || '#8a94a8'
    } : null
  };
}

router.get('/', async (req, res) => {
  const access = await serverAccess(req.params.id, req.session.userId);
  if (!access) return res.status(403).json({ error: 'Not a member' });
  const [items, balance, roles] = await Promise.all([
    pool.query(
      `SELECT sei.*, sr.name AS reward_role_name, sr.color AS reward_role_color,
        (SELECT COUNT(*)::int FROM server_economy_purchases sep WHERE sep.item_id=sei.id) AS sold
       FROM server_economy_items sei
       LEFT JOIN server_roles sr ON sr.id=sei.reward_role_id
       WHERE sei.server_id=$1 AND ($2::boolean OR sei.active=TRUE)
       ORDER BY sei.created_at DESC`,
      [req.params.id, access.canManage]
    ),
    pool.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]),
    access.canManage
      ? pool.query(
        `SELECT id, name, color FROM server_roles
         WHERE server_id=$1 AND COALESCE(is_admin,FALSE)=FALSE
         ORDER BY position DESC, name ASC`,
        [req.params.id]
      )
      : Promise.resolve({ rows: [] })
  ]);
  res.json({
    canManage: access.canManage,
    isOwner: access.isOwner,
    nexals: balance.rows[0]?.nexals || 0,
    items: items.rows.map(itemForClient),
    roles: roles.rows
  });
});

router.post('/items', async (req, res) => {
  const access = await serverAccess(req.params.id, req.session.userId);
  if (!access || !access.canManage) return res.status(403).json({ error: 'Admins only' });
  const name = String(req.body.name || '').trim().slice(0, 40);
  const description = String(req.body.description || '').trim().slice(0, 160);
  const price = Math.min(100000000, Math.max(1, parseInt(req.body.price, 10) || 0));
  const rewardRoleId = String(req.body.rewardRoleId || '').trim() || null;
  if (!name) return res.status(400).json({ error: 'Item name required' });
  if (!price) return res.status(400).json({ error: 'Valid price required' });
  let rewardRole = null;
  if (rewardRoleId) {
    const role = await pool.query(
      `SELECT id, name, color FROM server_roles
       WHERE id=$1 AND server_id=$2 AND COALESCE(is_admin,FALSE)=FALSE`,
      [rewardRoleId, req.params.id]
    );
    if (!role.rows.length) return res.status(400).json({ error: 'Choose a valid non-admin reward role' });
    rewardRole = role.rows[0];
  }
  const result = await pool.query(
    `INSERT INTO server_economy_items (id, server_id, created_by, name, description, price, reward_role_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [uuidv4(), req.params.id, req.session.userId, name, description, price, rewardRoleId]
  );
  res.json({ success: true, item: itemForClient({
    ...result.rows[0],
    reward_role_name: rewardRole?.name,
    reward_role_color: rewardRole?.color,
    sold: 0
  }) });
});

router.patch('/items/:itemId', async (req, res) => {
  const access = await serverAccess(req.params.id, req.session.userId);
  if (!access || !access.canManage) return res.status(403).json({ error: 'Admins only' });
  const active = req.body.active !== false;
  const result = await pool.query(
    `UPDATE server_economy_items SET active=$1 WHERE id=$2 AND server_id=$3 RETURNING *`,
    [active, req.params.itemId, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Item not found' });
  res.json({ success: true, item: itemForClient({ ...result.rows[0], sold: 0 }) });
});

router.post('/items/:itemId/buy', async (req, res) => {
  const access = await serverAccess(req.params.id, req.session.userId);
  if (!access) return res.status(403).json({ error: 'Not a member' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const itemRes = await client.query(
      `SELECT sei.*, s.owner_id, reward.name AS reward_role_name, reward.color AS reward_role_color,
        sm.role AS buyer_member_role, current_role.is_admin AS buyer_role_is_admin
       FROM server_economy_items sei
       JOIN servers s ON s.id=sei.server_id
       JOIN server_members sm ON sm.server_id=sei.server_id AND sm.user_id=$3
       LEFT JOIN server_roles reward ON reward.id=sei.reward_role_id
       LEFT JOIN server_roles current_role ON current_role.id=sm.role_id
       WHERE sei.id=$1 AND sei.server_id=$2 AND sei.active=TRUE
       FOR UPDATE OF sei`,
      [req.params.itemId, req.params.id, req.session.userId]
    );
    const item = itemRes.rows[0];
    if (!item) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Item not found' });
    }
    if (item.owner_id === req.session.userId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Server owners cannot buy from their own economy' });
    }
    if (item.reward_role_id && (item.buyer_member_role === 'admin' || item.buyer_role_is_admin)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Admins cannot replace their role through an economy purchase' });
    }
    if (item.reward_role_id) {
      const currentRole = await client.query(
        'SELECT role_id FROM server_members WHERE server_id=$1 AND user_id=$2 FOR UPDATE',
        [req.params.id, req.session.userId]
      );
      if (currentRole.rows[0]?.role_id === item.reward_role_id) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'You already have this role' });
      }
    }
    const buyer = await client.query('SELECT nexals FROM users WHERE id=$1 FOR UPDATE', [req.session.userId]);
    if (!buyer.rows[0] || buyer.rows[0].nexals < item.price) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Not enough Nexals' });
    }
    await client.query('UPDATE users SET nexals=nexals-$1 WHERE id=$2', [item.price, req.session.userId]);
    await client.query('UPDATE users SET nexals=nexals+$1 WHERE id=$2', [item.price, item.owner_id]);
    if (item.reward_role_id) {
      await client.query(
        `UPDATE server_members SET role_id=$1, role='member'
         WHERE server_id=$2 AND user_id=$3`,
        [item.reward_role_id, req.params.id, req.session.userId]
      );
    }
    await client.query(
      `INSERT INTO server_economy_purchases (id, item_id, server_id, buyer_id, owner_id, price)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuidv4(), item.id, req.params.id, req.session.userId, item.owner_id, item.price]
    );
    const updated = await client.query('SELECT nexals FROM users WHERE id=$1', [req.session.userId]);
    await client.query('COMMIT');
    res.json({
      success: true,
      nexals: updated.rows[0].nexals,
      roleGranted: item.reward_role_id ? {
        id: item.reward_role_id,
        name: item.reward_role_name,
        color: item.reward_role_color
      } : null
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('server economy buy error:', error);
    res.status(500).json({ error: 'Could not buy that item' });
  } finally {
    client.release();
  }
});

module.exports = router;
