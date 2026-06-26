const crypto = require('crypto');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');
const { DECORATIONS } = require('./shop');

const router = express.Router();
router.use(requireAuth);

const CORE_ADMIN_IDS = new Set(['537b58c9-b9cd-4239-b0e6-2f862c30ac01']);
const TAG_PREFIX = 'nexus-limited:';
const CLAIM_SECONDS = 10 * 60;
const CODE_SECONDS = 30 * 60;
const MAX_NEXALS_LIMIT = 100000000;
const MAX_PRO_DAYS_LIMIT = 3650;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function cleanTagPayload(payload) {
  const value = String(payload || '').trim();
  if (!value.toLowerCase().startsWith(TAG_PREFIX)) return null;
  const token = value.slice(TAG_PREFIX.length).trim();
  return /^[A-Za-z0-9_-]{12,160}$/.test(token) ? token : null;
}

function makeTagToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function makeRedemptionCode() {
  const raw = crypto.randomBytes(12).toString('hex').toUpperCase();
  return `NX-${raw.slice(0, 6)}-${raw.slice(6, 12)}-${raw.slice(12, 18)}-${raw.slice(18)}`;
}

function publicDecoration(decoration) {
  return {
    id: decoration.id,
    name: decoration.name,
    description: decoration.description,
    rarity: decoration.rarity,
    preview: decoration.preview || decoration.id
  };
}

router.get('/status', (req, res) => {
  res.json({
    supportedPayloadPrefix: TAG_PREFIX,
    isCoreAdmin: CORE_ADMIN_IDS.has(req.session.userId)
  });
});

router.get('/options', (req, res) => {
  res.json({
    decorations: DECORATIONS.map(publicDecoration),
    rewardTypes: ['decoration', 'nexals', 'pro']
  });
});

router.post('/admin/tags', async (req, res) => {
  if (!CORE_ADMIN_IDS.has(req.session.userId)) {
    return res.status(403).json({ error: 'Core admins only' });
  }
  const label = String(req.body.label || '').trim().slice(0, 80) || null;
  const maxNexals = Math.max(0, Math.min(MAX_NEXALS_LIMIT, Number.parseInt(req.body.maxNexals, 10) || 1000000));
  const maxProDays = Math.max(0, Math.min(MAX_PRO_DAYS_LIMIT, Number.parseInt(req.body.maxProDays, 10) || 365));
  const token = makeTagToken();
  const id = uuidv4();
  await pool.query(
    `INSERT INTO limited_nfc_tags
      (id, token_hash, label, max_nexals, max_pro_days, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, hash(token), label, maxNexals, maxProDays, req.session.userId]
  );
  res.json({
    success: true,
    tag: { id, label, maxNexals, maxProDays, payload: `${TAG_PREFIX}${token}` }
  });
});

router.post('/activate', async (req, res) => {
  const token = cleanTagPayload(req.body.payload);
  if (!token) return res.status(400).json({ error: 'This is not a valid Nexus limited tag' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tagResult = await client.query(
      'SELECT * FROM limited_nfc_tags WHERE token_hash=$1 FOR UPDATE',
      [hash(token)]
    );
    const tag = tagResult.rows[0];
    const now = nowSeconds();
    if (!tag || !tag.active) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'This limited tag is not active' });
    }
    if (tag.consumed_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This limited tag has already been used' });
    }
    if (tag.reserved_until > now && tag.reserved_by && tag.reserved_by !== req.session.userId) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This tag is currently being claimed' });
    }

    await client.query(
      'UPDATE limited_claim_sessions SET completed_at=$1 WHERE tag_id=$2 AND completed_at IS NULL',
      [now, tag.id]
    );
    const sessionId = uuidv4();
    const expiresAt = now + CLAIM_SECONDS;
    await client.query(
      'INSERT INTO limited_claim_sessions (id, tag_id, user_id, expires_at) VALUES ($1,$2,$3,$4)',
      [sessionId, tag.id, req.session.userId, expiresAt]
    );
    await client.query(
      'UPDATE limited_nfc_tags SET reserved_by=$1, reserved_until=$2 WHERE id=$3',
      [req.session.userId, expiresAt, tag.id]
    );
    await client.query('COMMIT');
    res.json({
      success: true,
      claimId: sessionId,
      expiresAt,
      limits: {
        maxNexals: tag.max_nexals,
        maxProDays: tag.max_pro_days
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Limited tag activation failed:', error.message);
    res.status(500).json({ error: 'Could not activate this limited tag' });
  } finally {
    client.release();
  }
});

router.post('/choose', async (req, res) => {
  const claimId = String(req.body.claimId || '');
  const rewardType = String(req.body.rewardType || '').toLowerCase();
  if (!['decoration', 'nexals', 'pro'].includes(rewardType)) {
    return res.status(400).json({ error: 'Choose a valid reward' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT cs.*, t.max_nexals, t.max_pro_days, t.consumed_at, t.reserved_by
       FROM limited_claim_sessions cs
       JOIN limited_nfc_tags t ON t.id=cs.tag_id
       WHERE cs.id=$1 AND cs.user_id=$2
       FOR UPDATE OF cs, t`,
      [claimId, req.session.userId]
    );
    const claim = result.rows[0];
    const now = nowSeconds();
    if (!claim || claim.completed_at || claim.expires_at <= now) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'This NFC claim has expired' });
    }
    if (claim.consumed_at || claim.reserved_by !== req.session.userId) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This tag is no longer available' });
    }

    let rewardData;
    if (rewardType === 'decoration') {
      const decoration = DECORATIONS.find(item => item.id === String(req.body.decorationId || ''));
      if (!decoration) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Decoration not found' });
      }
      rewardData = { decorationId: decoration.id, name: decoration.name };
    } else if (rewardType === 'nexals') {
      const amount = Number.parseInt(req.body.amount, 10);
      if (!Number.isInteger(amount) || amount < 1 || amount > claim.max_nexals) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Choose between 1 and ${claim.max_nexals.toLocaleString()} Nexals` });
      }
      rewardData = { amount };
    } else {
      const days = Number.parseInt(req.body.days, 10);
      if (!Number.isInteger(days) || days < 1 || days > claim.max_pro_days) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Choose between 1 and ${claim.max_pro_days} PRO days` });
      }
      rewardData = { days };
    }

    const code = makeRedemptionCode();
    const codeId = uuidv4();
    const expiresAt = now + CODE_SECONDS;
    await client.query(
      `INSERT INTO limited_redemption_codes
        (id, code_hash, user_id, reward_type, reward_data, expires_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [codeId, hash(code), req.session.userId, rewardType, JSON.stringify(rewardData), expiresAt]
    );
    await client.query('UPDATE limited_claim_sessions SET completed_at=$1 WHERE id=$2', [now, claim.id]);
    await client.query(
      `UPDATE limited_nfc_tags
       SET consumed_by=$1, consumed_at=$2, reserved_by=NULL, reserved_until=NULL
       WHERE id=$3`,
      [req.session.userId, now, claim.tag_id]
    );
    await client.query('COMMIT');
    res.json({ success: true, code, expiresAt, reward: { type: rewardType, ...rewardData } });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Limited reward selection failed:', error.message);
    res.status(500).json({ error: 'Could not create the limited code' });
  } finally {
    client.release();
  }
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
      `SELECT * FROM limited_redemption_codes
       WHERE code_hash=$1
       FOR UPDATE`,
      [hash(code)]
    );
    const redemption = result.rows[0];
    const now = nowSeconds();
    if (!redemption) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Limited-edition code not found' });
    }
    if (redemption.redeemed_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This limited-edition code was already used' });
    }
    if (redemption.expires_at <= now) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'This limited-edition code has expired' });
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
      'UPDATE limited_redemption_codes SET redeemed_at=$1, redeemed_by=$2 WHERE id=$3',
      [now, req.session.userId, redemption.id]
    );
    await client.query('COMMIT');
    res.json({ success: true, reward: responseReward });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Limited code redemption failed:', error.message);
    res.status(500).json({ error: 'Could not redeem this limited-edition code' });
  } finally {
    client.release();
  }
});

module.exports = router;
