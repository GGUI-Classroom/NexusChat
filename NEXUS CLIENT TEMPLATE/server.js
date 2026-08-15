const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();
const port = Number(process.env.PORT || 4174);
const host = process.env.HOST || '127.0.0.1';
const isProduction = process.env.NODE_ENV === 'production';
const nexusOrigin = String(process.env.NEXUS_ORIGIN || '').replace(/\/$/, '');
const clientId = String(process.env.NEXUS_CLIENT_API_CLIENT_ID || '');
const clientSecret = String(process.env.NEXUS_CLIENT_API_CLIENT_SECRET || '');
const sessionSecret = String(process.env.CLIENT_TEMPLATE_SESSION_SECRET || '');

if (!nexusOrigin || !clientId || !clientSecret || !sessionSecret) {
  throw new Error('Set NEXUS_ORIGIN, NEXUS_CLIENT_API_CLIENT_ID, NEXUS_CLIENT_API_CLIENT_SECRET, and CLIENT_TEMPLATE_SESSION_SECRET.');
}
if (isProduction && sessionSecret.length < 32) {
  throw new Error('CLIENT_TEMPLATE_SESSION_SECRET must be at least 32 characters in production.');
}

if (isProduction) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(session({
  name: 'nexus.client.sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

function nexusUrl(endpoint, query = {}) {
  const target = new URL(`/api/client/v1${endpoint}`, nexusOrigin);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value != null) target.searchParams.set(key, String(value));
  });
  return target;
}

function nexusHeaders(req, { includeUserToken = true, json = false } = {}) {
  const headers = {
    'x-nexus-client-id': clientId,
    'x-nexus-client-secret': clientSecret,
    accept: 'application/json'
  };
  if (includeUserToken && req.session?.nexusAccessToken) {
    headers.authorization = `Bearer ${req.session.nexusAccessToken}`;
  }
  if (json) headers['content-type'] = 'application/json';
  return headers;
}

async function requestNexus(req, endpoint, { method = 'GET', body, query, includeUserToken = true, accept } = {}) {
  const headers = nexusHeaders(req, { includeUserToken, json: body !== undefined });
  if (accept) headers.accept = accept;
  return fetch(nexusUrl(endpoint, query), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    return { error: 'Nexus returned an invalid response.' };
  }
}

function requireLocalUser(req, res, next) {
  if (!req.session?.nexusAccessToken) {
    return res.status(401).json({ error: 'Sign in to your Nexus account first.' });
  }
  next();
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save(error => error ? reject(error) : resolve());
  });
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(error => error ? reject(error) : resolve());
  });
}

function destroySession(req) {
  return new Promise(resolve => {
    if (!req.session) return resolve();
    req.session.destroy(() => resolve());
  });
}

async function forgetNexusUser(req) {
  if (!req.session) return;
  delete req.session.nexusAccessToken;
  delete req.session.nexusUser;
  await saveSession(req).catch(() => {});
}

async function sendJsonFromNexus(req, res, endpoint, options = {}) {
  const response = await requestNexus(req, endpoint, options);
  const payload = await readJson(response);
  if (response.status === 401) await forgetNexusUser(req);
  return res.status(response.status).json(payload);
}

async function completeAuthentication(req, res, endpoint) {
  const response = await requestNexus(req, endpoint, {
    method: 'POST',
    body: req.body,
    includeUserToken: false
  });
  const payload = await readJson(response);
  if (!response.ok) return res.status(response.status).json(payload);
  if (!payload.accessToken || !payload.user) {
    return res.status(502).json({ error: 'Nexus returned an incomplete sign-in response.' });
  }

  await regenerateSession(req);
  req.session.nexusAccessToken = payload.accessToken;
  req.session.nexusUser = payload.user;
  await saveSession(req);

  const { accessToken, ...publicPayload } = payload;
  return res.status(response.status).json(publicPayload);
}

app.use('/api/nexus', (req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  next();
});

app.get('/api/nexus/auth/terms', async (req, res, next) => {
  try {
    await sendJsonFromNexus(req, res, '/auth/terms', { includeUserToken: false });
  } catch (error) {
    next(error);
  }
});

app.post('/api/nexus/auth/login', async (req, res, next) => {
  try {
    await completeAuthentication(req, res, '/auth/login');
  } catch (error) {
    next(error);
  }
});

app.post('/api/nexus/auth/register', async (req, res, next) => {
  try {
    await completeAuthentication(req, res, '/auth/register');
  } catch (error) {
    next(error);
  }
});

app.post('/api/nexus/auth/tos/accept', requireLocalUser, async (req, res, next) => {
  try {
    await sendJsonFromNexus(req, res, '/auth/tos/accept', { method: 'POST', body: req.body });
  } catch (error) {
    next(error);
  }
});

app.post('/api/nexus/auth/logout', async (req, res) => {
  if (req.session?.nexusAccessToken) {
    try {
      await requestNexus(req, '/auth/logout', { method: 'POST', body: {} });
    } catch (_) {
      // The local logout should still succeed if Nexus is briefly unavailable.
    }
  }
  await destroySession(req);
  res.clearCookie('nexus.client.sid', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax'
  });
  res.json({ success: true });
});

app.get('/api/nexus/session', requireLocalUser, async (req, res, next) => {
  try {
    await sendJsonFromNexus(req, res, '/session');
  } catch (error) {
    next(error);
  }
});

app.get('/api/nexus/friends', requireLocalUser, async (req, res, next) => {
  try {
    await sendJsonFromNexus(req, res, '/friends');
  } catch (error) {
    next(error);
  }
});

app.get('/api/nexus/servers', requireLocalUser, async (req, res, next) => {
  try {
    await sendJsonFromNexus(req, res, '/servers');
  } catch (error) {
    next(error);
  }
});

app.get('/api/nexus/servers/:serverId', requireLocalUser, async (req, res, next) => {
  try {
    await sendJsonFromNexus(req, res, `/servers/${encodeURIComponent(req.params.serverId)}`);
  } catch (error) {
    next(error);
  }
});

app.get('/api/nexus/dms/:userId', requireLocalUser, async (req, res, next) => {
  try {
    await sendJsonFromNexus(req, res, `/dms/${encodeURIComponent(req.params.userId)}`, {
      query: { limit: req.query.limit }
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/nexus/dms/:userId', requireLocalUser, async (req, res, next) => {
  try {
    await sendJsonFromNexus(req, res, `/dms/${encodeURIComponent(req.params.userId)}`, {
      method: 'POST',
      body: req.body
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/nexus/servers/:serverId/channels/:channelId/messages', requireLocalUser, async (req, res, next) => {
  try {
    await sendJsonFromNexus(req, res, `/servers/${encodeURIComponent(req.params.serverId)}/channels/${encodeURIComponent(req.params.channelId)}/messages`, {
      query: { limit: req.query.limit }
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/nexus/servers/:serverId/channels/:channelId/messages', requireLocalUser, async (req, res, next) => {
  try {
    await sendJsonFromNexus(req, res, `/servers/${encodeURIComponent(req.params.serverId)}/channels/${encodeURIComponent(req.params.channelId)}/messages`, {
      method: 'POST',
      body: req.body
    });
  } catch (error) {
    next(error);
  }
});

async function sendMediaFromNexus(req, res, endpoint) {
  const response = await requestNexus(req, endpoint, { accept: 'image/*' });
  if (!response.ok) {
    const payload = await readJson(response);
    if (response.status === 401) await forgetNexusUser(req);
    return res.status(response.status).json(payload);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  res.setHeader('Cache-Control', 'private, max-age=3600, stale-while-revalidate=86400');
  return res.type(contentType).send(buffer);
}

app.get('/api/nexus/media/users/:userId/avatar', requireLocalUser, async (req, res, next) => {
  try {
    await sendMediaFromNexus(req, res, `/media/users/${encodeURIComponent(req.params.userId)}/avatar`);
  } catch (error) {
    next(error);
  }
});

app.get('/api/nexus/media/servers/:serverId/icon', requireLocalUser, async (req, res, next) => {
  try {
    await sendMediaFromNexus(req, res, `/media/servers/${encodeURIComponent(req.params.serverId)}/icon`);
  } catch (error) {
    next(error);
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'nexus-client-template' });
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error('Nexus client template error:', error.message);
  res.status(502).json({ error: 'The branded Nexus client could not reach Nexus.' });
});

app.listen(port, host, () => {
  console.log(`Nexus client template listening at http://${host}:${port}`);
});
