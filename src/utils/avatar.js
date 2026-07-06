const avatarCache = new Map();
const MAX_CACHE_ENTRIES = 500;

function avatarUrl(userId, hasAvatar) {
  return hasAvatar ? `/api/users/avatar/${encodeURIComponent(userId)}` : null;
}

function clearCachedAvatar(userId) {
  avatarCache.delete(userId);
}

function setCachedAvatar(userId, avatarData, avatarMime, options = {}) {
  if (!userId) return;
  if (!avatarData) {
    clearCachedAvatar(userId);
    return;
  }
  if (avatarCache.size >= MAX_CACHE_ENTRIES && !avatarCache.has(userId)) {
    avatarCache.delete(avatarCache.keys().next().value);
  }
  avatarCache.set(userId, {
    data: Buffer.from(avatarData, 'base64'),
    mime: avatarMime || 'image/png',
    proOnly: !!options.proOnly,
    proExpiresAt: Number(options.proExpiresAt) || 0
  });
}

async function getAvatar(pool, userId) {
  const cached = avatarCache.get(userId);
  if (cached) {
    if (!cached.proOnly || cached.proExpiresAt > Math.floor(Date.now() / 1000)) return cached;
    clearCachedAvatar(userId);
  }
  const result = await pool.query('SELECT avatar_data, avatar_mime, avatar_pro_only, pro_expires_at FROM users WHERE id=$1', [userId]);
  const user = result.rows[0];
  if (!user?.avatar_data) return null;
  if (user.avatar_pro_only && (user.pro_expires_at || 0) <= Math.floor(Date.now() / 1000)) return null;
  setCachedAvatar(userId, user.avatar_data, user.avatar_mime, {
    proOnly: user.avatar_pro_only,
    proExpiresAt: user.pro_expires_at
  });
  return avatarCache.get(userId) || null;
}

module.exports = { avatarUrl, clearCachedAvatar, getAvatar, setCachedAvatar };
