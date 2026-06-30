const { pool } = require('../models/db');

const CACHE_TTL_MS = 60 * 1000;
let cachedPolicy = null;
let cacheExpiresAt = 0;

function mapPolicy(row) {
  return {
    version: parseInt(row.version, 10) || 1,
    title: row.title,
    content: row.content,
    updatedAt: parseInt(row.updated_at, 10) || 0
  };
}

async function getCurrentTos(force = false) {
  if (!force && cachedPolicy && Date.now() < cacheExpiresAt) return cachedPolicy;
  const result = await pool.query(
    `SELECT version, title, content, updated_at
     FROM terms_of_service WHERE id='current' LIMIT 1`
  );
  if (!result.rows.length) throw new Error('Terms of Service are not configured');
  cachedPolicy = mapPolicy(result.rows[0]);
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return cachedPolicy;
}

function setCachedTos(policy) {
  cachedPolicy = policy;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
}

async function getUserTosState(userId) {
  const [policy, userResult] = await Promise.all([
    getCurrentTos(),
    pool.query('SELECT accepted_tos_version FROM users WHERE id=$1', [userId])
  ]);
  const acceptedVersion = parseInt(userResult.rows[0]?.accepted_tos_version, 10) || 0;
  return {
    required: acceptedVersion < policy.version,
    acceptedVersion,
    policy
  };
}

async function requireCurrentTos(req, res, next) {
  if (!req.session?.userId) return next();
  try {
    const policy = await getCurrentTos();
    let acceptedVersion = parseInt(req.session.tosAcceptedVersion, 10);
    if (!Number.isFinite(acceptedVersion)) {
      const result = await pool.query('SELECT accepted_tos_version FROM users WHERE id=$1', [req.session.userId]);
      acceptedVersion = parseInt(result.rows[0]?.accepted_tos_version, 10) || 0;
      req.session.tosAcceptedVersion = acceptedVersion;
    }
    if (acceptedVersion < policy.version) {
      return res.status(428).json({ error: 'Terms of Service acceptance required', tosRequired: true, tos: policy });
    }
    next();
  } catch (error) {
    console.error('TOS enforcement failed:', error.message);
    res.status(503).json({ error: 'Terms of Service are temporarily unavailable' });
  }
}

module.exports = {
  getCurrentTos,
  getUserTosState,
  requireCurrentTos,
  setCachedTos
};
