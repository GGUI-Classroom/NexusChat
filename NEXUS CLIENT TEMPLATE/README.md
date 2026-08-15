# Nexus Client Template

This is a starter HTML/CSS/JS client for the private Nexus Client API. It is a real client of the existing Nexus account: DMs, server memberships, channel permissions, messages, NexusGuard checks, mutes, achievements, Socket.IO events, and the PostgreSQL data all remain in the main Nexus app.

It does not contain an API key in browser code. The tiny Node proxy in `server.js` holds the key server-side and is intentionally local-only by default.

## Enable the API

In the **main Nexus Render service**, add these environment variables and redeploy it:

```text
NEXUS_PRIVATE_CLIENT_USER_ID=your Nexus user UUID
NEXUS_PRIVATE_CLIENT_API_KEY=a-long-random-secret-at-least-32-characters
```

There is no key-generator page or public developer portal. The API is disabled until both values exist.

## Run the starter client locally

From this folder:

```powershell
npm install
$env:NEXUS_ORIGIN="https://your-nexus-domain"
$env:NEXUS_PRIVATE_CLIENT_API_KEY="the-exact-same-key-from-Render"
npm start
```

Open `http://127.0.0.1:4174`.

## Give This To Another AI

Give it the contents of `public/index.html`, `public/styles.css`, and `public/app.js`, plus this API list. It can replace the UI completely while keeping the proxy contract.

| Method | Local proxy route | Nexus action |
| --- | --- | --- |
| `GET` | `/api/nexus/session` | Configured account identity |
| `GET` | `/api/nexus/friends` | Friends / DM list |
| `GET` | `/api/nexus/dms/:userId?limit=50` | Direct-message history |
| `POST` | `/api/nexus/dms/:userId` | Send `{ "content": "..." }` |
| `GET` | `/api/nexus/servers` | Joined servers |
| `GET` | `/api/nexus/servers/:serverId` | Server metadata and visible channels |
| `GET` | `/api/nexus/servers/:serverId/channels/:channelId/messages?limit=50` | Channel history |
| `POST` | `/api/nexus/servers/:serverId/channels/:channelId/messages` | Send `{ "content": "...", "replyToMessageId": "optional" }` |
| `GET` | `/api/nexus/media/users/:userId/avatar` | Avatar media |
| `GET` | `/api/nexus/media/servers/:serverId/icon` | Server icon media |

The actual private Nexus API is at `/api/private-client/v1/...` on the main Nexus service. It only accepts a server-side `Authorization: Bearer ...` request with no browser `Origin` header. Do not call it from frontend JavaScript and do not put the key in HTML, a mobile bundle, local storage, or GitHub.

## Before You Host This Publicly

This starter is deliberately bound to `127.0.0.1` because it controls one real Nexus account. A public deployment needs its own login and authorization layer in front of the proxy so each person can access only the Nexus identity they are meant to use. The main Nexus API remains private either way.
