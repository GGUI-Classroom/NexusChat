const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { requireAuth } = require('../middleware/auth');
const { buildReportPayload, clearReportCache, getActiveReport } = require('../utils/systemReport');
const { clearSafetyTermCache, normalizeTerm } = require('../utils/globalSafety');
const { getCurrentTos, setCachedTos } = require('../utils/tosPolicy');
const { avatarUrl, clearCachedAvatar } = require('../utils/avatar');
const { deleteCachedMedia } = require('../utils/mediaCache');

const router = express.Router();
router.use(requireAuth);
const NEXUS_GUARD_AVATAR = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiI+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSIjMGYxNzJhIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMWUyOTNiIi8+PC9saW5lYXJHcmFkaWVudD48bGluZWFyR3JhZGllbnQgaWQ9ImEiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj48c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiNmNTllMGIiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiNmOTczMTYiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48Y2lyY2xlIGN4PSI0OCIgY3k9IjQ4IiByPSI0NiIgZmlsbD0idXJsKCNnKSIvPjxwYXRoIGQ9Ik00OCAxNmwyNCA4djIyYzAgMTgtMTAgMzAtMjQgMzYtMTQtNi0yNC0xOC0yNC0zNlYyNHoiIGZpbGw9InVybCgjYSkiLz48cGF0aCBkPSJNNDggMjZsMTQgNXYxNWMwIDExLTYgMTktMTQgMjMtOC00LTE0LTEyLTE0LTIzVjMxeiIgZmlsbD0iIzExMTgyNyIgb3BhY2l0eT0iLjY1Ii8+PGNpcmNsZSBjeD0iNDgiIGN5PSI0NSIgcj0iNyIgZmlsbD0iI2ZkZTY4YSIvPjxwYXRoIGQ9Ik0zNiA1OWgyNHY1SDM2eiIgZmlsbD0iI2ZkZTY4YSIvPjwvc3ZnPg==';
const NEXUS_GUARD_ID = '00000000-0000-0000-0000-000000000001';
const ADMIN_QR_REQUIRED_CODE = process.env.ADMIN_QR_CODE || 'JJKLOL12DAJWUDIUWQ';
const NON_REMOVABLE_ADMIN_ID = '537b58c9-b9cd-4239-b0e6-2f862c30ac01';

async function ensureNexusGuardExists() {
  await pool.query(
    `INSERT INTO users (id, username, display_name, password_hash, status, active_color, avatar_mime, avatar_data)
     VALUES ($1,'nexusguard','NexusGuard','nexusguard-local-only','online','#f4b942','image/svg+xml',$2)
     ON CONFLICT (id) DO UPDATE SET
       username='nexusguard',
       display_name='NexusGuard',
       status='online',
       active_color='#f4b942',
       avatar_mime='image/svg+xml',
       avatar_data=$2`,
    [NEXUS_GUARD_ID, NEXUS_GUARD_AVATAR.replace(/^data:image\/svg\+xml;base64,/, '')]
  );
}

async function sendNexusGuardDM(req, userId, content) {
  await ensureNexusGuardExists();
  const now = Math.floor(Date.now() / 1000);
  await pool.query(
    'INSERT INTO messages (id, from_id, to_id, content, created_at) VALUES ($1,$2,$3,$4,$5)',
    [uuidv4(), NEXUS_GUARD_ID, userId, content, now]
  );

  if (req.io) {
    req.io.to(`user:${userId}`).emit('new_message', {
      id: uuidv4(),
      fromId: NEXUS_GUARD_ID,
      toId: userId,
      content,
      createdAt: now,
      author: {
        username: 'nexusguard',
        displayName: 'NexusGuard',
        avatarDataUrl: NEXUS_GUARD_AVATAR,
        activeDecoration: null,
        activeColor: '#f4b942',
        activeFont: null
      }
    });
  }
}

// Hardcoded admin user IDs
const ADMIN_IDS = new Set([
  '537b58c9-b9cd-4239-b0e6-2f862c30ac01',
]);

async function isGlobalAdmin(userId) {
  if (!userId) return false;
  if (ADMIN_IDS.has(userId)) return true;
  const r = await pool.query('SELECT id FROM admin_users WHERE user_id=$1', [userId]);
  return !!r.rows.length;
}

async function requireAdmin(req, res, next) {
  try {
    if (!(await isGlobalAdmin(req.session.userId))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    next();
  } catch (e) {
    console.error('requireAdmin failed:', e.message);
    return res.status(500).json({ error: 'Admin check failed' });
  }
}
router.use(requireAdmin);

function requireCoreAdmin(req, res, next) {
  if (!ADMIN_IDS.has(req.session.userId)) {
    return res.status(403).json({ error: 'Core admins only' });
  }
  next();
}

async function writeAudit(actorId, action, targetType = null, targetId = null, details = {}) {
  try {
    await pool.query(
      `INSERT INTO admin_audit_logs (id, actor_id, action, target_type, target_id, details)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [uuidv4(), actorId || null, action, targetType, targetId, JSON.stringify(details || {})]
    );
  } catch (error) {
    console.error('Admin audit log failed:', error.message);
  }
}

function auditDetails(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const allowed = ['username', 'duration', 'durationSeconds', 'unit', 'reason', 'nexals', 'displayName', 'decorationId',
    'nameplateId', 'fontId', 'days', 'category', 'title', 'action', 'active'];
  const details = {};
  allowed.forEach(key => {
    if (body[key] !== undefined) details[key] = String(body[key]).slice(0, 300);
  });
  if (body.content !== undefined) details.contentLength = String(body.content).length;
  if (body.categories && typeof body.categories === 'object') {
    details.categoryCounts = Object.fromEntries(Object.entries(body.categories).map(([key, value]) => [key, Array.isArray(value) ? value.length : 0]));
  }
  return details;
}

// Record every successful admin mutation, including Nexal edits and moderation changes.
router.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 400) return;
    const path = req.originalUrl.split('?')[0];
    if (path.endsWith('/dm-context')) return; // Logged with reviewed-message details by the route itself.
    const targetMatch = path.match(/\/user-reports\/([^/]+)/)
      || path.match(/\/users\/([^/]+)/)
      || path.match(/\/servers\/([^/]+)/)
      || path.match(/\/ip-bans\/([^/]+)/);
    const targetId = targetMatch ? decodeURIComponent(targetMatch[1]) : null;
    const targetType = path.includes('/user-reports/') ? 'user_report'
      : path.includes('/users/') ? 'user'
        : path.includes('/servers/') ? 'server'
          : path.includes('/ip-bans/') ? 'device_ban'
            : null;
    writeAudit(req.session?.userId, `${req.method} ${path}`, targetType, targetId, auditDetails(req));
  });
  next();
});

// Check if current user is admin (used by frontend on load)
router.get('/check', (req, res) => {
  res.json({ isAdmin: true, isCoreAdmin: ADMIN_IDS.has(req.session.userId) });
});

router.get('/system-report', requireCoreAdmin, async (req, res) => {
  res.json({ report: await getActiveReport(pool) });
});

router.get('/tos', requireCoreAdmin, async (req, res) => {
  res.json({ tos: await getCurrentTos(true) });
});

router.put('/tos', requireCoreAdmin, async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 120);
  const content = String(req.body.content || '').trim().slice(0, 30000);
  if (title.length < 3) return res.status(400).json({ error: 'Enter a TOS title.' });
  if (content.length < 100) return res.status(400).json({ error: 'Terms of Service must contain at least 100 characters.' });
  const updated = await pool.query(
    `UPDATE terms_of_service
     SET version=version+1, title=$1, content=$2, updated_by=$3,
         updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT
     WHERE id='current'
     RETURNING version, title, content, updated_at`,
    [title, content, req.session.userId]
  );
  const row = updated.rows[0];
  const tos = {
    version: parseInt(row.version, 10),
    title: row.title,
    content: row.content,
    updatedAt: parseInt(row.updated_at, 10)
  };
  setCachedTos(tos);
  const io = req.app.get('io');
  if (io) io.emit('tos_required', { tos });
  res.json({ success: true, tos });
});

router.post('/system-report', requireCoreAdmin, async (req, res) => {
  try {
    const report = buildReportPayload(req.body || {});
    await pool.query('UPDATE system_reports SET active=FALSE, cleared_at=EXTRACT(EPOCH FROM NOW())::BIGINT, cleared_by=$1 WHERE active=TRUE', [req.session.userId]);
    const created = await pool.query(
      `INSERT INTO system_reports (id, category, title, message, published_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, category, title, message, published_by, created_at`,
      [uuidv4(), report.category, report.title, report.message, req.session.userId]
    );
    clearReportCache();
    res.json({ success: true, report: {
      id: created.rows[0].id,
      category: created.rows[0].category,
      title: created.rows[0].title,
      message: created.rows[0].message,
      createdAt: parseInt(created.rows[0].created_at, 10),
      publishedBy: created.rows[0].published_by
    } });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not publish report' });
  }
});

router.delete('/system-report', requireCoreAdmin, async (req, res) => {
  await pool.query('UPDATE system_reports SET active=FALSE, cleared_at=EXTRACT(EPOCH FROM NOW())::BIGINT, cleared_by=$1 WHERE active=TRUE', [req.session.userId]);
  clearReportCache();
  res.json({ success: true });
});

// Get all users
router.get('/users', async (req, res) => {
  const { search } = req.query;
  let q = `SELECT u.id, u.username, u.display_name, (u.avatar_data IS NOT NULL) AS has_avatar, u.last_ip,
    (SELECT s.suspended_until FROM suspensions s
     WHERE s.user_id=u.id AND s.active=TRUE AND s.suspended_until > EXTRACT(EPOCH FROM NOW())::BIGINT
     ORDER BY s.created_at DESC LIMIT 1) as suspended_until
    FROM users u`;
  const params = [];
  if (search) {
    params.push('%' + search.toLowerCase() + '%');
    q += ` WHERE LOWER(u.username) LIKE $1 OR LOWER(u.display_name) LIKE $1`;
  }
  q += ` ORDER BY u.username ASC LIMIT 50`;
  const r = await pool.query(q, params);
  res.json({ users: r.rows.map(u => ({
    id: u.id, username: u.username, displayName: u.display_name,
    avatarDataUrl: avatarUrl(u.id, !!u.has_avatar),
    lastIp: u.last_ip || null,
    suspendedUntil: u.suspended_until ? parseInt(u.suspended_until) : null,
  }))});
});

// Suspend a user
router.post('/suspend', async (req, res) => {
  const { username, duration, unit, reason } = req.body;
  if (!username || !duration || !unit) return res.status(400).json({ error: 'Missing fields' });

  const user = await pool.query('SELECT id, username FROM users WHERE LOWER(username)=LOWER($1)', [username]);
  if (!user.rows.length) return res.status(404).json({ error: 'User not found' });
  if (ADMIN_IDS.has(user.rows[0].id)) return res.status(403).json({ error: 'Cannot suspend an admin' });

  const multipliers = { minutes: 60, hours: 3600, days: 86400 };
  const seconds = parseInt(duration) * (multipliers[unit] || 60);
  const until = Math.floor(Date.now() / 1000) + seconds;

  // Deactivate any existing suspension
  await pool.query('UPDATE suspensions SET active=FALSE WHERE user_id=$1', [user.rows[0].id]);
  await pool.query(
    'INSERT INTO suspensions (id, user_id, suspended_by, reason, suspended_until) VALUES ($1,$2,$3,$4,$5)',
    [uuidv4(), user.rows[0].id, req.session.userId, reason || null, until]
  );

  if (req.io) {
    req.io.to(`user:${user.rows[0].id}`).emit('account_suspended', {
      suspendedUntil: until,
      reason: reason || null
    });
  }

  try {
    await sendNexusGuardDM(
      req,
      user.rows[0].id,
      `[NexusGuard] Your account was suspended until ${new Date(until * 1000).toLocaleString()}. Reason: ${reason || 'No reason provided'}`
    );
  } catch (dmErr) {
    console.error('NexusGuard suspension DM failed:', dmErr.message);
  }

  res.json({ success: true, username: user.rows[0].username, userId: user.rows[0].id, suspendedUntil: until, reason: reason || null });
});

// Unsuspend a user
router.post('/unsuspend', async (req, res) => {
  const { username } = req.body;
  const user = await pool.query('SELECT id FROM users WHERE LOWER(username)=LOWER($1)', [username]);
  if (!user.rows.length) return res.status(404).json({ error: 'User not found' });
  await pool.query('UPDATE suspensions SET active=FALSE WHERE user_id=$1', [user.rows[0].id]);
  res.json({ success: true });
});

router.get('/global-mutes', async (req, res) => {
  const result = await pool.query(
    `SELECT mute.id,mute.user_id,mute.reason,mute.muted_until,target.username,
       actor.username AS admin_username
     FROM global_mutes mute JOIN users target ON target.id=mute.user_id
     JOIN users actor ON actor.id=mute.muted_by
     WHERE mute.active=TRUE AND mute.muted_until>EXTRACT(EPOCH FROM NOW())::BIGINT
     ORDER BY mute.muted_until DESC`
  );
  res.json({ mutes: result.rows.map(mute => ({
    id: mute.id, userId: mute.user_id, username: mute.username, reason: mute.reason || '',
    mutedUntil: Number(mute.muted_until), adminUsername: mute.admin_username
  })) });
});

router.post('/global-mutes', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const durationSeconds = Math.max(60, Math.min(Number(req.body.durationSeconds) || 3600, 2592000));
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  const target = await pool.query('SELECT id,username FROM users WHERE LOWER(username)=LOWER($1)', [username]);
  if (!target.rows.length) return res.status(404).json({ error: 'User not found' });
  if (ADMIN_IDS.has(target.rows[0].id)) return res.status(403).json({ error: 'A core admin cannot be globally muted' });
  await pool.query('UPDATE global_mutes SET active=FALSE WHERE user_id=$1 AND active=TRUE', [target.rows[0].id]);
  const id = uuidv4();
  const mutedUntil = Math.floor(Date.now() / 1000) + durationSeconds;
  await pool.query(
    'INSERT INTO global_mutes (id,user_id,muted_by,reason,muted_until) VALUES ($1,$2,$3,$4,$5)',
    [id, target.rows[0].id, req.session.userId, reason || null, mutedUntil]
  );
  res.json({ success: true, id, username: target.rows[0].username, mutedUntil });
});

router.delete('/global-mutes/:muteId', async (req, res) => {
  const result = await pool.query('UPDATE global_mutes SET active=FALSE WHERE id=$1 AND active=TRUE RETURNING id', [req.params.muteId]);
  if (!result.rows.length) return res.status(404).json({ error: 'Active global mute not found' });
  res.json({ success: true });
});

router.post('/ip-ban', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const reason = String(req.body.reason || '').trim().slice(0, 400) || null;
  if (!username) return res.status(400).json({ error: 'Username is required' });
  const user = await pool.query('SELECT id, username, last_ip, last_device_id FROM users WHERE LOWER(username)=LOWER($1)', [username]);
  if (!user.rows.length) return res.status(404).json({ error: 'User not found' });
  const row = user.rows[0];
  if (ADMIN_IDS.has(row.id)) return res.status(403).json({ error: 'Cannot device ban a core admin' });
  if (!row.last_device_id) return res.status(400).json({ error: 'That user has no recorded device yet. Have them log in with the updated client first.' });
  await pool.query('UPDATE ip_bans SET active=FALSE WHERE device_id=$1 AND active=TRUE', [row.last_device_id]);
  const banId = uuidv4();
  await pool.query(
    `INSERT INTO ip_bans (id, ip_address, device_id, username, user_id, banned_by, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [banId, row.last_ip || 'unknown', row.last_device_id, row.username, row.id, req.session.userId, reason]
  );
  if (req.io) req.io.to(`user:${row.id}`).emit('force_logout', { reason: 'This device was banned from Nexus.' });
  res.json({ success: true, id: banId, username: row.username, ip: row.last_ip || null, deviceId: row.last_device_id });
});

router.get('/ip-bans', async (req, res) => {
  const r = await pool.query(`
    SELECT b.id, b.ip_address, b.device_id, b.username, b.user_id, b.reason, b.created_at,
      a.username AS admin_username
    FROM ip_bans b
    JOIN users a ON a.id=b.banned_by
    WHERE b.active=TRUE
    ORDER BY b.created_at DESC
    LIMIT 100
  `);
  res.json({ bans: r.rows.map(b => ({
    id: b.id,
    ip: b.ip_address || null,
    deviceId: b.device_id || null,
    username: b.username || 'unknown',
    userId: b.user_id || null,
    reason: b.reason || null,
    createdAt: parseInt(b.created_at, 10),
    adminUsername: b.admin_username || null
  })) });
});

router.delete('/ip-bans/:banId', async (req, res) => {
  const r = await pool.query('UPDATE ip_bans SET active=FALSE WHERE id=$1 AND active=TRUE RETURNING id', [req.params.banId]);
  if (!r.rows.length) return res.status(404).json({ error: 'Active device ban not found' });
  res.json({ success: true });
});

// Get all servers
router.get('/servers', async (req, res) => {
  const r = await pool.query(`
    SELECT s.id, s.name, (s.icon_data IS NOT NULL) AS has_icon, s.invite_code,
      u.username as owner_username, u.display_name as owner_display_name,
      (SELECT COUNT(*) FROM server_members sm WHERE sm.server_id=s.id) as member_count
    FROM servers s JOIN users u ON u.id=s.owner_id
    ORDER BY s.name ASC
  `);
  res.json({ servers: r.rows.map(s => ({
    id: s.id, name: s.name, inviteCode: s.invite_code,
    iconDataUrl: s.has_icon ? `/api/servers/${encodeURIComponent(s.id)}/icon` : null,
    ownerUsername: s.owner_username, ownerDisplayName: s.owner_display_name,
    memberCount: parseInt(s.member_count),
  }))});
});

// Join a server as admin (force join with admin role)
router.post('/servers/:serverId/join', async (req, res) => {
  const { serverId } = req.params;
  const already = await pool.query('SELECT id FROM server_members WHERE server_id=$1 AND user_id=$2', [serverId, req.session.userId]);
  if (already.rows.length) {
    // Already a member — promote to admin role
    await pool.query("UPDATE server_members SET role='admin' WHERE server_id=$1 AND user_id=$2", [serverId, req.session.userId]);
    return res.json({ success: true, promoted: true });
  }
  await pool.query("INSERT INTO server_members (id, server_id, user_id, role) VALUES ($1,$2,$3,'admin')", [uuidv4(), serverId, req.session.userId]);
  const s = await pool.query('SELECT * FROM servers WHERE id=$1', [serverId]);
  res.json({ success: true, server: s.rows[0] });
});

// Delete a server
router.delete('/servers/:serverId', async (req, res) => {
  await pool.query('DELETE FROM servers WHERE id=$1', [req.params.serverId]);
  res.json({ success: true });
});

// Get suspension history
router.get('/suspensions', async (req, res) => {
  const r = await pool.query(`
    SELECT s.id, s.suspended_until, s.created_at, s.active, s.reason,
      u.username, u.display_name,
      a.username as admin_username
    FROM suspensions s
    JOIN users u ON u.id=s.user_id
    JOIN users a ON a.id=s.suspended_by
    ORDER BY s.created_at DESC LIMIT 50
  `);
  res.json({ suspensions: r.rows.map(s => ({
    id: s.id, username: s.username, displayName: s.display_name,
    adminUsername: s.admin_username, reason: s.reason,
    suspendedUntil: parseInt(s.suspended_until),
    createdAt: parseInt(s.created_at), active: s.active,
  }))});
});

router.get('/user-reports', async (req, res) => {
  const status = String(req.query.status || 'open').toLowerCase();
  const params = [];
  let where = '';
  if (status !== 'all') {
    params.push(status === 'resolved' ? 'resolved' : 'open');
    where = 'WHERE ur.status=$1';
  }
  const r = await pool.query(`
    SELECT ur.id, ur.report_type, ur.reason, ur.message_type, ur.message_id, ur.message_content,
      ur.server_id, ur.channel_id, ur.status, ur.created_at, ur.resolved_at,
      reporter.username AS reporter_username, reporter.display_name AS reporter_display_name,
      target.username AS target_username, target.display_name AS target_display_name,
      s.name AS server_name, c.name AS channel_name,
      resolver.username AS resolver_username
    FROM user_reports ur
    JOIN users reporter ON reporter.id=ur.reporter_id
    JOIN users target ON target.id=ur.target_user_id
    LEFT JOIN servers s ON s.id=ur.server_id
    LEFT JOIN channels c ON c.id=ur.channel_id
    LEFT JOIN users resolver ON resolver.id=ur.resolved_by
    ${where}
    ORDER BY ur.created_at DESC
    LIMIT 100
  `, params);
  res.json({ reports: r.rows.map(row => ({
    id: row.id,
    type: row.report_type,
    reason: row.reason || '',
    messageType: row.message_type || null,
    messageId: row.message_id || null,
    messageContent: row.message_content || null,
    serverId: row.server_id || null,
    serverName: row.server_name || null,
    channelId: row.channel_id || null,
    channelName: row.channel_name || null,
    status: row.status,
    createdAt: parseInt(row.created_at, 10),
    resolvedAt: row.resolved_at ? parseInt(row.resolved_at, 10) : null,
    resolvedBy: row.resolver_username || null,
    reporter: { username: row.reporter_username, displayName: row.reporter_display_name },
    target: { username: row.target_username, displayName: row.target_display_name }
  }))});
});

router.post('/user-reports/:reportId/dm-context', requireCoreAdmin, async (req, res) => {
  if (req.body.confirmSuspicion !== true || req.body.confirmPrivacy !== true) {
    return res.status(400).json({ error: 'Both review confirmations are required' });
  }
  const reportId = String(req.params.reportId || '').trim();
  const reportResult = await pool.query(
    `SELECT ur.id, ur.reporter_id, ur.target_user_id, ur.message_id, ur.created_at,
       reporter.username AS reporter_username, reporter.display_name AS reporter_display_name,
       target.username AS target_username, target.display_name AS target_display_name
     FROM user_reports ur
     JOIN users reporter ON reporter.id=ur.reporter_id
     JOIN users target ON target.id=ur.target_user_id
     WHERE ur.id=$1 AND ur.message_type='dm'`,
    [reportId]
  );
  if (!reportResult.rows.length) return res.status(404).json({ error: 'DM report not found' });
  const report = reportResult.rows[0];
  const anchorResult = report.message_id
    ? await pool.query('SELECT created_at FROM messages WHERE id=$1 LIMIT 1', [report.message_id])
    : { rows: [] };
  const anchor = Number(anchorResult.rows[0]?.created_at || report.created_at);
  const messages = await pool.query(
    `SELECT context.id, context.from_id, context.to_id, context.content, context.created_at,
       u.username, u.display_name
     FROM (
       SELECT m.*
       FROM messages m
       WHERE ((m.from_id=$1 AND m.to_id=$2) OR (m.from_id=$2 AND m.to_id=$1))
         AND m.created_at BETWEEN $3::bigint - 604800 AND $3::bigint + 604800
       ORDER BY ABS(m.created_at - $3::bigint) ASC
       LIMIT 40
     ) context
     JOIN users u ON u.id=context.from_id
     ORDER BY context.created_at ASC`,
    [report.reporter_id, report.target_user_id, anchor]
  );
  await writeAudit(req.session.userId, 'VIEW_DM_REPORT_CONTEXT', 'user_report', reportId, {
    reporterId: report.reporter_id,
    targetUserId: report.target_user_id,
    messageCount: messages.rows.length,
    anchor
  });
  res.json({
    reportId,
    reporter: { id: report.reporter_id, username: report.reporter_username, displayName: report.reporter_display_name },
    target: { id: report.target_user_id, username: report.target_username, displayName: report.target_display_name },
    messages: messages.rows.map(message => ({
      id: message.id,
      fromId: message.from_id,
      toId: message.to_id,
      content: message.content,
      createdAt: Number(message.created_at),
      author: { username: message.username, displayName: message.display_name }
    }))
  });
});

router.get('/safety-terms', requireCoreAdmin, async (req, res) => {
  const result = await pool.query('SELECT term, category FROM global_safety_terms ORDER BY category, term ASC');
  const categories = { discriminatory: [], nsfw: [], child_safety: [] };
  result.rows.forEach(row => {
    const category = Object.prototype.hasOwnProperty.call(categories, row.category) ? row.category : 'discriminatory';
    categories[category].push(row.term);
  });
  res.json({ terms: categories.discriminatory, categories });
});

router.put('/safety-terms', requireCoreAdmin, async (req, res) => {
  const submittedCategories = req.body.categories && typeof req.body.categories === 'object'
    ? req.body.categories
    : { discriminatory: req.body.terms };
  const allowedCategories = ['discriminatory', 'nsfw', 'child_safety'];
  const unique = new Map();
  for (const category of allowedCategories) {
    const submitted = Array.isArray(submittedCategories[category]) ? submittedCategories[category] : [];
    for (const rawTerm of submitted.slice(0, 200)) {
      const term = String(rawTerm || '').trim().slice(0, 80);
      const normalized = normalizeTerm(term);
      if (normalized.length < 3) continue;
      if (!unique.has(normalized)) unique.set(normalized, { term, category });
    }
  }
  if (!unique.size) return res.status(400).json({ error: 'Keep at least one term in the global safety filter.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM global_safety_terms');
    for (const [normalized, entry] of unique) {
      await client.query(
        `INSERT INTO global_safety_terms (id, term, normalized_term, category, created_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [uuidv4(), entry.term, normalized, entry.category, req.session.userId]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  clearSafetyTermCache();
  const categories = { discriminatory: [], nsfw: [], child_safety: [] };
  unique.forEach(entry => categories[entry.category].push(entry.term));
  Object.values(categories).forEach(terms => terms.sort((a, b) => a.localeCompare(b)));
  res.json({ success: true, terms: categories.discriminatory, categories });
});

router.post('/user-reports/:reportId/resolve', async (req, res) => {
  const reportId = String(req.params.reportId || '').trim();
  const result = await pool.query(
    `UPDATE user_reports
     SET status='resolved', resolved_at=EXTRACT(EPOCH FROM NOW())::BIGINT, resolved_by=$1
     WHERE id=$2 AND status='open'
     RETURNING id`,
    [req.session.userId, reportId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Open report not found' });
  res.json({ success: true });
});

router.post('/user-reports/:reportId/reopen', requireCoreAdmin, async (req, res) => {
  const reportId = String(req.params.reportId || '').trim();
  const result = await pool.query(
    `UPDATE user_reports
     SET status='open', resolved_at=NULL, resolved_by=NULL
     WHERE id=$1 AND status='resolved'
     RETURNING id`,
    [reportId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Resolved report not found' });
  res.json({ success: true });
});

router.get('/audit-log', async (req, res) => {
  const result = await pool.query(
    `SELECT log.id, log.action, log.target_type, log.target_id, log.details, log.created_at,
       actor.username AS actor_username, actor.display_name AS actor_display_name,
       target_user.username AS target_username,
       report_target.username AS report_target_username,
       target_server.name AS target_server_name
     FROM admin_audit_logs log
     LEFT JOIN users actor ON actor.id=log.actor_id
     LEFT JOIN users target_user ON log.target_type='user' AND target_user.id=log.target_id
     LEFT JOIN user_reports report ON log.target_type='user_report' AND report.id=log.target_id
     LEFT JOIN users report_target ON report_target.id=report.target_user_id
     LEFT JOIN servers target_server ON log.target_type='server' AND target_server.id=log.target_id
     ORDER BY log.created_at DESC
     LIMIT 200`
  );
  res.json({ logs: result.rows.map(row => ({
    id: row.id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    details: row.details || {},
    createdAt: Number(row.created_at),
    actor: row.actor_username ? { username: row.actor_username, displayName: row.actor_display_name } : null,
    targetLabel: row.target_username
      ? `@${row.target_username}`
      : row.report_target_username
        ? `Report about @${row.report_target_username}`
        : row.target_server_name || null
  })) });
});

// Get user info (nexals + servers)
router.get('/users/:userId', async (req, res) => {
  const { userId } = req.params;
  const userRes = await pool.query(
    'SELECT id, username, display_name, nexals, active_font, active_nameplate, pro_expires_at, last_ip FROM users WHERE id=$1', [userId]
  );
  if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });
  const u = userRes.rows[0];

  const serversRes = await pool.query(`
    SELECT s.id, s.name, (s.icon_data IS NOT NULL) AS has_icon, sm.role,
      (SELECT COUNT(*) FROM server_members sm2 WHERE sm2.server_id=s.id) as member_count
    FROM server_members sm
    JOIN servers s ON s.id=sm.server_id
    WHERE sm.user_id=$1
    ORDER BY s.name ASC
  `, [userId]);

  const suspRes = await pool.query(
    'SELECT suspended_until, reason FROM suspensions WHERE user_id=$1 AND active=TRUE AND suspended_until > EXTRACT(EPOCH FROM NOW())::BIGINT ORDER BY created_at DESC LIMIT 1',
    [userId]
  );

  const ownedDecos = await pool.query('SELECT decoration_id FROM user_decorations WHERE user_id=$1', [userId]);
  const ownedSet = new Set(ownedDecos.rows.map(r => r.decoration_id));
  const ownedNameplates = await pool.query('SELECT DISTINCT nameplate_id FROM user_nameplates WHERE user_id=$1', [userId]);
  const ownedNameplateSet = new Set(ownedNameplates.rows.map(r => r.nameplate_id));
  const { DECORATIONS, NAMEPLATES } = require('./shop');
  const ownedFonts = await pool.query('SELECT font_id FROM user_fonts WHERE user_id=$1', [userId]);
  const ownedFontSet = new Set(ownedFonts.rows.map(r => r.font_id));
  const { FONTS } = require('./colors');

  res.json({
    id: u.id, username: u.username, displayName: u.display_name,
    nexals: u.nexals,
    proActive: (u.pro_expires_at || 0) > Math.floor(Date.now() / 1000),
    proExpiresAt: parseInt(u.pro_expires_at || 0),
    lastIp: u.last_ip || null,
    suspendedUntil: suspRes.rows[0] ? parseInt(suspRes.rows[0].suspended_until) : null,
    suspendReason: suspRes.rows[0]?.reason || null,
    servers: serversRes.rows.map(s => ({
      id: s.id, name: s.name, role: s.role, memberCount: parseInt(s.member_count),
      iconDataUrl: s.has_icon ? `/api/servers/${encodeURIComponent(s.id)}/icon` : null,
    })),
    decorations: DECORATIONS.map(d => ({ id: d.id, name: d.name, rarity: d.rarity, owned: ownedSet.has(d.id) })),
    nameplates: NAMEPLATES.map(nameplate => ({
      id: nameplate.id,
      name: nameplate.name,
      rarity: nameplate.rarity,
      owned: ownedNameplateSet.has(nameplate.id),
      active: u.active_nameplate === nameplate.id
    })),
    fonts: FONTS.map(f => ({ id: f.id, name: f.name, owned: ownedFontSet.has(f.id), active: u.active_font === f.id })),
  });
});

// Change user password
router.patch('/users/:userId/password', async (req, res) => {
  const { userId } = req.params;
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(password, 12);
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, userId]);
  res.json({ success: true });
});

// Change username/display name
router.patch('/users/:userId/identity', async (req, res) => {
  const { userId } = req.params;
  const { username, displayName } = req.body;
  if (username) {
    if (!/^[a-zA-Z0-9_.\-]+$/.test(username)) return res.status(400).json({ error: 'Invalid username characters' });
    const exists = await pool.query('SELECT id FROM users WHERE LOWER(username)=LOWER($1) AND id!=$2', [username, userId]);
    if (exists.rows.length) return res.status(409).json({ error: 'Username already taken' });
    await pool.query('UPDATE users SET username=$1 WHERE id=$2', [username.toLowerCase(), userId]);
  }
  if (displayName) {
    await pool.query('UPDATE users SET display_name=$1 WHERE id=$2', [displayName, userId]);
  }
  const r = await pool.query('SELECT username, display_name FROM users WHERE id=$1', [userId]);
  res.json({ success: true, username: r.rows[0].username, displayName: r.rows[0].display_name });
});

// Give decoration to user
router.post('/users/:userId/decorations', async (req, res) => {
  const { userId } = req.params;
  const { decorationId } = req.body;
  const already = await pool.query('SELECT id FROM user_decorations WHERE user_id=$1 AND decoration_id=$2', [userId, decorationId]);
  if (already.rows.length) return res.status(409).json({ error: 'User already owns this decoration' });
  await pool.query('INSERT INTO user_decorations (id, user_id, decoration_id) VALUES ($1,$2,$3)', [require('uuid').v4(), userId, decorationId]);
  res.json({ success: true });
});

// Remove decoration from user
router.delete('/users/:userId/decorations/:decorationId', async (req, res) => {
  const { userId, decorationId } = req.params;
  await pool.query('UPDATE users SET active_decoration=NULL WHERE id=$1 AND active_decoration=$2', [userId, decorationId]);
  await pool.query('DELETE FROM user_decorations WHERE user_id=$1 AND decoration_id=$2', [userId, decorationId]);
  res.json({ success: true });
});

router.post('/users/:userId/nameplates', requireCoreAdmin, async (req, res) => {
  const { userId } = req.params;
  const nameplateId = String(req.body.nameplateId || '').trim();
  const { NAMEPLATES } = require('./shop');
  if (!NAMEPLATES.some(nameplate => nameplate.id === nameplateId)) {
    return res.status(404).json({ error: 'Unknown nameplate' });
  }
  const target = await pool.query('SELECT id FROM users WHERE id=$1', [userId]);
  if (!target.rows.length) return res.status(404).json({ error: 'User not found' });
  const owned = await pool.query(
    'SELECT id FROM user_nameplates WHERE user_id=$1 AND nameplate_id=$2 LIMIT 1',
    [userId, nameplateId]
  );
  if (owned.rows.length) return res.status(409).json({ error: 'User already owns this nameplate' });
  await pool.query(
    'INSERT INTO user_nameplates (id, user_id, nameplate_id) VALUES ($1,$2,$3)',
    [uuidv4(), userId, nameplateId]
  );
  res.json({ success: true, nameplateId });
});

router.delete('/users/:userId/nameplates/:nameplateId', requireCoreAdmin, async (req, res) => {
  const { userId, nameplateId } = req.params;
  await pool.query(
    'UPDATE users SET active_nameplate=NULL WHERE id=$1 AND active_nameplate=$2',
    [userId, nameplateId]
  );
  await pool.query(
    'DELETE FROM user_nameplates WHERE user_id=$1 AND nameplate_id=$2',
    [userId, nameplateId]
  );
  res.json({ success: true });
});

router.post('/users/:userId/pro', requireCoreAdmin, async (req, res) => {
  const { userId } = req.params;
  const days = Math.min(365, Math.max(1, parseInt(req.body.days, 10) || 30));
  const now = Math.floor(Date.now() / 1000);
  const target = await pool.query(
    'SELECT id, username, pro_expires_at FROM users WHERE id=$1',
    [userId]
  );
  if (!target.rows.length) return res.status(404).json({ error: 'User not found' });
  const expiresAt = Math.max(now, parseInt(target.rows[0].pro_expires_at || 0)) + days * 86400;
  await pool.query('UPDATE users SET pro_expires_at=$1 WHERE id=$2', [expiresAt, userId]);
  clearCachedAvatar(userId);
  deleteCachedMedia(`profile-banner:${userId}`);
  await sendNexusGuardDM(
    req,
    userId,
    `[NexusGuard] A Core admin granted your account ${days} days of Nexus Pro. Pro is active until ${new Date(expiresAt * 1000).toLocaleDateString()}.`
  );
  if (req.io) req.io.to(`user:${userId}`).emit('pro_updated', { active: true, expiresAt });
  res.json({ success: true, expiresAt, days });
});

router.delete('/users/:userId/pro', requireCoreAdmin, async (req, res) => {
  const { userId } = req.params;
  const updated = await pool.query(
    'UPDATE users SET pro_expires_at=0 WHERE id=$1 RETURNING id',
    [userId]
  );
  if (!updated.rows.length) return res.status(404).json({ error: 'User not found' });
  clearCachedAvatar(userId);
  deleteCachedMedia(`profile-banner:${userId}`);
  if (req.io) req.io.to(`user:${userId}`).emit('pro_updated', { active: false, expiresAt: 0 });
  res.json({ success: true, expiresAt: 0 });
});

router.post('/users/:userId/fonts', async (req, res) => {
  const { userId } = req.params;
  const { fontId } = req.body;
  const { FONTS } = require('./colors');
  if (!FONTS.find(f => f.id === fontId)) return res.status(404).json({ error: 'Unknown font' });
  const already = await pool.query('SELECT id FROM user_fonts WHERE user_id=$1 AND font_id=$2', [userId, fontId]);
  if (already.rows.length) return res.status(409).json({ error: 'User already owns this font' });
  await pool.query('INSERT INTO user_fonts (id, user_id, font_id) VALUES ($1,$2,$3)', [require('uuid').v4(), userId, fontId]);
  res.json({ success: true });
});

router.delete('/users/:userId/fonts/:fontId', async (req, res) => {
  const { userId, fontId } = req.params;
  await pool.query('UPDATE users SET active_font=NULL WHERE id=$1 AND active_font=$2', [userId, fontId]);
  await pool.query('DELETE FROM user_fonts WHERE user_id=$1 AND font_id=$2', [userId, fontId]);
  res.json({ success: true });
});

// Update user nexals
router.patch('/users/:userId/nexals', async (req, res) => {
  const { userId } = req.params;
  const { nexals } = req.body;
  if (nexals === undefined || isNaN(parseInt(nexals))) return res.status(400).json({ error: 'Invalid nexals value' });
  await pool.query('UPDATE users SET nexals=$1 WHERE id=$2', [Math.max(0, parseInt(nexals)), userId]);
  const r = await pool.query('SELECT nexals FROM users WHERE id=$1', [userId]);
  res.json({ success: true, nexals: r.rows[0].nexals });
});

router.post('/users/:userId/warn', async (req, res) => {
  const { userId } = req.params;
  const reason = String(req.body.reason || '').trim() || 'No reason provided';
  const target = await pool.query('SELECT id, username FROM users WHERE id=$1', [userId]);
  if (!target.rows.length) return res.status(404).json({ error: 'User not found' });
  if (ADMIN_IDS.has(target.rows[0].id)) return res.status(403).json({ error: 'Cannot warn an admin' });

  const content = `[NexusGuard] You have received an admin warning. Reason: ${reason}`;
  await sendNexusGuardDM(req, userId, content);

  res.json({ success: true });
});

// Nexus client controls (only affects Nexus client UI, not system screen)
router.post('/users/:userId/client-control', async (req, res) => {
  const { userId } = req.params;
  const action = String(req.body.action || '').trim().toLowerCase();
  const message = String(req.body.message || '').trim().slice(0, 300);
  const view = String(req.body.view || '').trim().toLowerCase();

  const allowedActions = new Set(['lock', 'unlock', 'notify', 'popup', 'force_view']);
  if (!allowedActions.has(action)) return res.status(400).json({ error: 'Invalid action' });

  if (action === 'lock' && !message) return res.status(400).json({ error: 'Lock message is required' });
  if ((action === 'notify' || action === 'popup') && !message) return res.status(400).json({ error: 'Message is required' });
  if (action === 'force_view') {
    const allowedViews = new Set(['friends', 'dms', 'servers', 'shop', 'achievements', 'colors']);
    if (!allowedViews.has(view)) return res.status(400).json({ error: 'Invalid view target' });
  }

  const target = await pool.query('SELECT id, username FROM users WHERE id=$1', [userId]);
  if (!target.rows.length) return res.status(404).json({ error: 'User not found' });

  const sockets = req.userSockets && req.userSockets.get(userId);
  if (!sockets || !sockets.size) return res.status(400).json({ error: 'User is not online right now' });

  const actor = await pool.query('SELECT username, display_name FROM users WHERE id=$1', [req.session.userId]);
  const actorRow = actor.rows[0] || {};

  if (action === 'lock') {
    const existing = await pool.query('SELECT id FROM user_client_state WHERE user_id=$1', [userId]);
    if (existing.rows.length) {
      await pool.query(
        'UPDATE user_client_state SET is_paused=TRUE, pause_message=$1, updated_by=$2, updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE user_id=$3',
        [message, req.session.userId, userId]
      );
    } else {
      await pool.query(
        'INSERT INTO user_client_state (id, user_id, is_paused, pause_message, updated_by) VALUES ($1,$2,TRUE,$3,$4)',
        [uuidv4(), userId, message, req.session.userId]
      );
    }
  }

  if (action === 'unlock') {
    await pool.query(
      'UPDATE user_client_state SET is_paused=FALSE, pause_message=NULL, updated_by=$1, updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE user_id=$2',
      [req.session.userId, userId]
    );
  }

  req.io.to(`user:${userId}`).emit('nexus_admin_control', {
    action,
    message,
    view,
    at: Math.floor(Date.now() / 1000),
    by: {
      id: req.session.userId,
      username: actorRow.username || 'admin',
      displayName: actorRow.display_name || 'Admin'
    }
  });

  res.json({ success: true });
});

router.get('/admins', async (req, res) => {
  const seeded = Array.from(ADMIN_IDS).map(id => ({ user_id: id, seeded: true }));
  const dbAdmins = await pool.query('SELECT user_id, added_by, created_at FROM admin_users ORDER BY created_at DESC');
  const all = [...seeded, ...dbAdmins.rows];
  const unique = new Map();
  all.forEach(a => {
    if (!unique.has(a.user_id)) unique.set(a.user_id, a);
  });
  const adminIds = Array.from(unique.keys());
  if (!adminIds.length) return res.json({ admins: [] });

  const users = await pool.query('SELECT id, username, display_name FROM users WHERE id = ANY($1::text[])', [adminIds]);
  const byId = new Map(users.rows.map(u => [u.id, u]));
  res.json({ admins: Array.from(unique.values()).map(a => ({
    id: a.user_id,
    username: byId.get(a.user_id)?.username || 'unknown',
    displayName: byId.get(a.user_id)?.display_name || 'Unknown User',
    seeded: !!a.seeded,
    removable: !a.seeded && a.user_id !== NON_REMOVABLE_ADMIN_ID,
    addedBy: a.added_by || null,
    createdAt: a.created_at ? parseInt(a.created_at, 10) : null
  })) });
});

router.post('/admins', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const qrCode = String(req.body.qrCode || '').trim();
  if (!username) return res.status(400).json({ error: 'Username required' });
  if (!qrCode) return res.status(400).json({ error: 'QR scan code required' });
  if (qrCode !== ADMIN_QR_REQUIRED_CODE) return res.status(403).json({ error: 'Invalid QR verification code' });

  const target = await pool.query('SELECT id, username, display_name FROM users WHERE LOWER(username)=LOWER($1)', [username]);
  if (!target.rows.length) return res.status(404).json({ error: 'User not found' });
  const u = target.rows[0];

  if (await isGlobalAdmin(u.id)) return res.status(409).json({ error: 'User is already an admin' });

  await pool.query('INSERT INTO admin_users (id, user_id, added_by) VALUES ($1,$2,$3)', [uuidv4(), u.id, req.session.userId]);
  res.json({ success: true, admin: { id: u.id, username: u.username, displayName: u.display_name } });
});

router.delete('/admins/:userId', async (req, res) => {
  const { userId } = req.params;
  if (userId === NON_REMOVABLE_ADMIN_ID) {
    return res.status(403).json({ error: 'This admin cannot be removed' });
  }
  if (ADMIN_IDS.has(userId)) {
    return res.status(403).json({ error: 'Core admins cannot be removed' });
  }

  const removed = await pool.query('DELETE FROM admin_users WHERE user_id=$1', [userId]);
  if (!removed.rowCount) return res.status(404).json({ error: 'Admin record not found' });
  res.json({ success: true });
});

module.exports = router;
module.exports.ADMIN_IDS = ADMIN_IDS;
module.exports.isGlobalAdmin = isGlobalAdmin;
