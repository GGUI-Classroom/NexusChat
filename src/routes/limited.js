const crypto = require('crypto');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');
const { DECORATIONS } = require('./shop');

const router = express.Router();
router.use(requireAuth);

const CORE_ADMIN_IDS = new Set(['537b58c9-b9cd-4239-b0e6-2f862c30ac01']);
const ADMIN_NFC_CODE = String(process.env.LIMITED_ADMIN_NFC_CODE || '');
const ADMIN_ACCESS_CODE = String(process.env.LIMITED_ADMIN_ACCESS_CODE || '');
const ADMIN_ACCESS_SECONDS = 20 * 60;
const FAR_FUTURE = 253402300799;
const MAX_NEXALS = 100000000;
const MAX_PRO_DAYS = 3650;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function secureEquals(left, right) {
  if (!right) return false;
  const leftHash = Buffer.from(hash(left));
  const rightHash = Buffer.from(hash(right));
  return leftHash.length === rightHash.length && crypto.timingSafeEqual(leftHash, rightHash);
}

function makeRedemptionCode() {
  const raw = crypto.randomBytes(12).toString('hex').toUpperCase();
  return `NX-${raw.slice(0, 6)}-${raw.slice(6, 12)}-${raw.slice(12, 18)}-${raw.slice(18)}`;
}

function publicDecoration(decoration) {
  return {
    id: decoration.id,
    name: decoration.name,
    rarity: decoration.rarity,
    preview: decoration.preview || decoration.id
  };
}

function requireCoreAdmin(req, res, next) {
  if (!CORE_ADMIN_IDS.has(req.session.userId)) {
    return res.status(403).json({ error: 'Core admins only' });
  }
  next();
}

function requireLimitedAccess(req, res, next) {
  if ((req.session.limitedAdminUntil || 0) <= nowSeconds()) {
    return res.status(403).json({ error: 'Unlock the limited-admin portal first' });
  }
  next();
}

router.get('/status', requireCoreAdmin, (req, res) => {
  const unlockedUntil = Number(req.session.limitedAdminUntil) || 0;
  res.json({
    isCoreAdmin: true,
    unlocked: unlockedUntil > nowSeconds(),
    unlockedUntil
  });
});

router.post('/admin/unlock', requireCoreAdmin, (req, res) => {
  const payload = String(req.body.payload || '').trim();
  if (!ADMIN_NFC_CODE && !ADMIN_ACCESS_CODE) {
    return res.status(503).json({ error: 'Limited-admin access is not configured. Set LIMITED_ADMIN_NFC_CODE or LIMITED_ADMIN_ACCESS_CODE.' });
  }
  if (!secureEquals(payload, ADMIN_NFC_CODE) && !secureEquals(payload, ADMIN_ACCESS_CODE)) {
    return res.status(403).json({ error: 'Invalid limited-admin access code' });
  }
  const unlockedUntil = nowSeconds() + ADMIN_ACCESS_SECONDS;
  req.session.limitedAdminUntil = unlockedUntil;
  res.json({ success: true, unlockedUntil });
});

router.get('/admin/options', requireCoreAdmin, requireLimitedAccess, (req, res) => {
  res.json({
    decorations: DECORATIONS.map(publicDecoration),
    limits: { maxNexals: MAX_NEXALS, maxProDays: MAX_PRO_DAYS }
  });
});

router.get('/admin/codes', requireCoreAdmin, requireLimitedAccess, async (req, res) => {
  const result = await pool.query(
    `SELECT lrc.id, lrc.label, lrc.code_hint, lrc.reward_type, lrc.reward_data,
            lrc.active, lrc.max_uses, lrc.use_count, lrc.expires_at, lrc.created_at,
            u.username AS created_by_username
     FROM limited_redemption_codes lrc
     LEFT JOIN users u ON u.id=lrc.user_id
     ORDER BY lrc.created_at DESC
     LIMIT 250`
  );
  res.json({
    codes: result.rows.map(row => ({
      id: row.id,
      label: row.label,
      codeHint: row.code_hint,
      rewardType: row.reward_type,
      reward: row.reward_data,
      active: row.active,
      maxUses: row.max_uses,
      useCount: row.use_count,
      expiresAt: Number(row.expires_at),
      createdAt: Number(row.created_at),
      createdBy: row.created_by_username
    }))
  });
});

router.post('/admin/codes', requireCoreAdmin, requireLimitedAccess, async (req, res) => {
  const rewardType = String(req.body.rewardType || '').toLowerCase();
  const usageMode = String(req.body.usageMode || 'once').toLowerCase();
  const label = String(req.body.label || '').trim().slice(0, 80) || null;
  if (!['decoration', 'nexals', 'pro'].includes(rewardType)) {
    return res.status(400).json({ error: 'Choose a valid reward' });
  }
  if (!['once', 'unlimited'].includes(usageMode)) {
    return res.status(400).json({ error: 'Choose one-time or unlimited use' });
  }

  let rewardData;
  if (rewardType === 'decoration') {
    const decoration = DECORATIONS.find(item => item.id === String(req.body.decorationId || ''));
    if (!decoration) return res.status(400).json({ error: 'Decoration not found' });
    rewardData = { decorationId: decoration.id, name: decoration.name };
  } else if (rewardType === 'nexals') {
    const amount = Number.parseInt(req.body.amount, 10);
    if (!Number.isInteger(amount) || amount < 1 || amount > MAX_NEXALS) {
      return res.status(400).json({ error: `Choose between 1 and ${MAX_NEXALS.toLocaleString()} Nexals` });
    }
    rewardData = { amount };
  } else {
    const days = Number.parseInt(req.body.days, 10);
    if (!Number.isInteger(days) || days < 1 || days > MAX_PRO_DAYS) {
      return res.status(400).json({ error: `Choose between 1 and ${MAX_PRO_DAYS} PRO days` });
    }
    rewardData = { days };
  }

  const expiresInDays = Number.parseInt(req.body.expiresInDays, 10);
  const expiresAt = Number.isInteger(expiresInDays) && expiresInDays > 0
    ? nowSeconds() + Math.min(expiresInDays, 3650) * 86400
    : FAR_FUTURE;
  const code = makeRedemptionCode();
  const id = uuidv4();
  const maxUses = usageMode === 'once' ? 1 : null;
  await pool.query(
    `INSERT INTO limited_redemption_codes
      (id, code_hash, code_hint, label, user_id, reward_type, reward_data, expires_at, max_uses, use_count, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,0,TRUE)`,
    [
      id,
      hash(code),
      code.slice(-6),
      label,
      req.session.userId,
      rewardType,
      JSON.stringify(rewardData),
      expiresAt,
      maxUses
    ]
  );
  res.json({
    success: true,
    code,
    record: {
      id,
      label,
      codeHint: code.slice(-6),
      rewardType,
      reward: rewardData,
      active: true,
      maxUses,
      useCount: 0,
      expiresAt,
      createdAt: nowSeconds()
    }
  });
});

router.delete('/admin/codes/:codeId', requireCoreAdmin, requireLimitedAccess, async (req, res) => {
  const deleted = await pool.query(
    'DELETE FROM limited_redemption_codes WHERE id=$1 RETURNING id',
    [req.params.codeId]
  );
  if (!deleted.rows.length) return res.status(404).json({ error: 'Code not found' });
  res.json({ success: true });
});

router.post('/admin/codes/:codeId/toggle', requireCoreAdmin, requireLimitedAccess, async (req, res) => {
  const updated = await pool.query(
    `UPDATE limited_redemption_codes
     SET active=NOT active
     WHERE id=$1
     RETURNING active`,
    [req.params.codeId]
  );
  if (!updated.rows.length) return res.status(404).json({ error: 'Code not found' });
  res.json({ success: true, active: updated.rows[0].active });
});

router.post('/redeem', async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!/^NX-[A-F0-9]{6}-[A-F0-9]{6}-[A-F0-9]{6}-[A-F0-9]{6}$/.test(code)) {
    return res.status(400).json({ error: 'Enter a valid limited-edition code' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'SELECT * FROM limited_redemption_codes WHERE code_hash=$1 FOR UPDATE',
      [hash(code)]
    );
    const redemption = result.rows[0];
    const now = nowSeconds();
    if (!redemption) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Limited-edition code not found' });
    }
    if (!redemption.active) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'This limited-edition code was disabled' });
    }
    if (Number(redemption.expires_at) <= now) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'This limited-edition code has expired' });
    }
    if (redemption.max_uses !== null && redemption.use_count >= redemption.max_uses) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This limited-edition code has no uses remaining' });
    }
    const priorUse = await client.query(
      'SELECT id FROM limited_code_uses WHERE code_id=$1 AND user_id=$2',
      [redemption.id, req.session.userId]
    );
    if (priorUse.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'You already redeemed this limited-edition code' });
    }

    const data = redemption.reward_data || {};
    let responseReward;
    if (redemption.reward_type === 'decoration') {
      const decoration = DECORATIONS.find(item => item.id === data.decorationId);
      if (!decoration) throw new Error('Limited decoration no longer exists');
      await client.query(
        'INSERT INTO user_decorations (id, user_id, decoration_id) VALUES ($1,$2,$3)',
        [uuidv4(), req.session.userId, decoration.id]
      );
      responseReward = { type: 'decoration', decoration: publicDecoration(decoration) };
    } else if (redemption.reward_type === 'nexals') {
      const updated = await client.query(
        'UPDATE users SET nexals=nexals+$1 WHERE id=$2 RETURNING nexals',
        [data.amount, req.session.userId]
      );
      responseReward = { type: 'nexals', amount: data.amount, nexals: updated.rows[0].nexals };
    } else if (redemption.reward_type === 'pro') {
      const user = await client.query('SELECT pro_expires_at FROM users WHERE id=$1 FOR UPDATE', [req.session.userId]);
      const expiresAt = Math.max(now, Number(user.rows[0]?.pro_expires_at) || 0) + (data.days * 86400);
      await client.query('UPDATE users SET pro_expires_at=$1 WHERE id=$2', [expiresAt, req.session.userId]);
      responseReward = { type: 'pro', days: data.days, expiresAt };
    } else {
      throw new Error('Unknown limited reward type');
    }

    await client.query(
      `INSERT INTO limited_code_uses (id, code_id, user_id, reward_type, reward_data)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [uuidv4(), redemption.id, req.session.userId, redemption.reward_type, JSON.stringify(data)]
    );
    const nextUseCount = Number(redemption.use_count) + 1;
    const exhausted = redemption.max_uses !== null && nextUseCount >= redemption.max_uses;
    await client.query(
      `UPDATE limited_redemption_codes
       SET use_count=$1,
           redeemed_at=CASE WHEN $2 THEN $3 ELSE redeemed_at END,
           redeemed_by=CASE WHEN $2 THEN $4 ELSE redeemed_by END
       WHERE id=$5`,
      [nextUseCount, exhausted, now, req.session.userId, redemption.id]
    );
    await client.query('COMMIT');
    res.json({ success: true, reward: responseReward });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(409).json({ error: 'You already redeemed this limited-edition code' });
    }
    console.error('Limited code redemption failed:', error.message);
    res.status(500).json({ error: 'Could not redeem this limited-edition code' });
  } finally {
    client.release();
  }
});

module.exports = router;
