const express = require('express');
const path = require('path');

const app = express();
const port = Number(process.env.PORT || 4174);
const host = process.env.HOST || '127.0.0.1';
const nexusOrigin = String(process.env.NEXUS_ORIGIN || '').replace(/\/$/, '');
const privateKey = String(process.env.NEXUS_PRIVATE_CLIENT_API_KEY || '');

if (!nexusOrigin || !privateKey) {
  throw new Error('Set NEXUS_ORIGIN and NEXUS_PRIVATE_CLIENT_API_KEY before starting this template.');
}

app.use(express.json({ limit: '64kb' }));

function nexusUrl(endpoint, query = {}) {
  const url = new URL(`/api/private-client/v1${endpoint}`, nexusOrigin);
  Object.entries(query).forEach(([key, value]) => {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  });
  return url;
}

async function forward(req, res, endpoint, { includeQuery = false } = {}) {
  try {
    const response = await fetch(nexusUrl(endpoint, includeQuery ? req.query : {}), {
      method: req.method,
      headers: {
        authorization: `Bearer ${privateKey}`,
        ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { 'content-type': 'application/json' })
      },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body || {})
    });
    const body = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type');
    const cacheControl = response.headers.get('cache-control');
    if (contentType) res.setHeader('content-type', contentType);
    if (cacheControl) res.setHeader('cache-control', cacheControl);
    res.status(response.status).send(body);
  } catch (error) {
    console.error('Nexus API proxy error:', error.message);
    res.status(502).json({ error: 'The local Nexus client could not reach Nexus.' });
  }
}

app.get('/api/nexus/session', (req, res) => forward(req, res, '/session'));
app.get('/api/nexus/friends', (req, res) => forward(req, res, '/friends'));
app.get('/api/nexus/servers', (req, res) => forward(req, res, '/servers'));
app.get('/api/nexus/servers/:serverId', (req, res) => forward(req, res, `/servers/${encodeURIComponent(req.params.serverId)}`));
app.get('/api/nexus/dms/:userId', (req, res) => forward(req, res, `/dms/${encodeURIComponent(req.params.userId)}`, { includeQuery: true }));
app.post('/api/nexus/dms/:userId', (req, res) => forward(req, res, `/dms/${encodeURIComponent(req.params.userId)}`));
app.get('/api/nexus/servers/:serverId/channels/:channelId/messages', (req, res) => forward(
  req,
  res,
  `/servers/${encodeURIComponent(req.params.serverId)}/channels/${encodeURIComponent(req.params.channelId)}/messages`,
  { includeQuery: true }
));
app.post('/api/nexus/servers/:serverId/channels/:channelId/messages', (req, res) => forward(
  req,
  res,
  `/servers/${encodeURIComponent(req.params.serverId)}/channels/${encodeURIComponent(req.params.channelId)}/messages`
));
app.get('/api/nexus/media/users/:userId/avatar', (req, res) => forward(req, res, `/media/users/${encodeURIComponent(req.params.userId)}/avatar`));
app.get('/api/nexus/media/servers/:serverId/icon', (req, res) => forward(req, res, `/media/servers/${encodeURIComponent(req.params.serverId)}/icon`));

app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0 }));

app.listen(port, host, () => {
  console.log(`Nexus Client Template running at http://${host}:${port}`);
});
