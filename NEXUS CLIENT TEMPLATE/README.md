# Nexus Client Template

This folder is a small, rebrandable starter app for Nexus. It is **multi-user**: every visitor signs into their own Nexus account or creates one, then sees their own friends, DMs, servers, channels, permissions, and messages.

It does not create a second chat database. The template talks to the main Nexus service, so all chat data, NexusGuard checks, server roles, mutes, reports, achievements, Socket.IO events, and PostgreSQL records remain shared with Nexus.

## How It Works

```text
Browser -> your branded client site -> Nexus Client API -> main Nexus PostgreSQL/chat service
```

Your branded site keeps its app secret and every user's short-lived Nexus access token on its server. The browser receives only an HTTP-only session cookie for the branded site. Do not move the client secret into HTML, JavaScript, a mobile bundle, local storage, or GitHub.

## 1. Enable The Main Nexus API

Add these variables to the **main Nexus Render service** and redeploy it:

```text
NEXUS_CLIENT_API_CLIENT_ID=nexus-rebrand-client-v1
NEXUS_CLIENT_API_CLIENT_SECRET=your-long-random-client-secret
NEXUS_CLIENT_API_TOKEN_SECRET=a-different-long-random-token-secret
NEXUS_CLIENT_API_TOKEN_TTL_SECONDS=604800
```

`CLIENT_ID` identifies the one branded app. The other two values are secrets. Keep them only in Render environment variables.

## 2. Run The Template Locally

From this folder:

```powershell
npm install
$env:NEXUS_ORIGIN="https://your-nexus-domain"
$env:NEXUS_CLIENT_API_CLIENT_ID="nexus-rebrand-client-v1"
$env:NEXUS_CLIENT_API_CLIENT_SECRET="the-same-client-secret-from-main-nexus"
$env:CLIENT_TEMPLATE_SESSION_SECRET="a-third-long-random-secret-for-this-site"
npm start
```

Open `http://127.0.0.1:4174`.

The template is local-only by default. To deploy it as a separate public website, add:

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=10000
NEXUS_ORIGIN=https://your-nexus-domain
NEXUS_CLIENT_API_CLIENT_ID=nexus-rebrand-client-v1
NEXUS_CLIENT_API_CLIENT_SECRET=the-same-client-secret-from-main-nexus
CLIENT_TEMPLATE_SESSION_SECRET=a-long-random-secret-at-least-32-characters
```

For a multi-instance production deployment, replace the built-in memory session store with a shared session store such as PostgreSQL or Redis. One Render instance is fine for testing and a small launch.

## Customizing The Brand

Change these files freely:

- `public/index.html` for structure and visible product name
- `public/styles.css` for the visual system
- `public/app.js` for client interactions

Keep `server.js` as the server-side bridge, or preserve the same behavior in your own backend. Another AI can rebuild the entire UI around it without losing the shared Nexus accounts and chat system.

## Local API Routes

The browser calls these routes on **your branded site**. They are already backed by the main Nexus service.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/nexus/auth/terms` | Read the current Nexus Terms of Service |
| `POST` | `/api/nexus/auth/register` | Create a Nexus account and start its branded-site session |
| `POST` | `/api/nexus/auth/login` | Sign in to an existing Nexus account |
| `POST` | `/api/nexus/auth/tos/accept` | Accept the current terms for the signed-in account |
| `POST` | `/api/nexus/auth/logout` | End the branded-site session |
| `GET` | `/api/nexus/session` | Current Nexus account |
| `GET` | `/api/nexus/friends` | Friends and DM targets |
| `GET` | `/api/nexus/dms/:userId?limit=50` | Direct-message history |
| `POST` | `/api/nexus/dms/:userId` | Send `{ "content": "..." }` |
| `GET` | `/api/nexus/servers` | Servers the account joined |
| `GET` | `/api/nexus/servers/:serverId` | Server data and visible channels |
| `GET` | `/api/nexus/servers/:serverId/channels/:channelId/messages?limit=50` | Channel history |
| `POST` | `/api/nexus/servers/:serverId/channels/:channelId/messages` | Send `{ "content": "...", "replyToMessageId": "optional" }` |
| `GET` | `/api/nexus/media/users/:userId/avatar` | Avatar media |
| `GET` | `/api/nexus/media/servers/:serverId/icon` | Server icon media |

The actual Nexus endpoint is `/api/client/v1/...` on the main Nexus service. It rejects browser requests and expects the app credentials from a server-side bridge such as this template.
