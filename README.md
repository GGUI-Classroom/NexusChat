# Nexus Chat

A Discord-style real-time chat app with voice calls, DMs, and friend requests.

## Features
- Account creation with avatar upload
- Friend request system (send/accept/decline)
- Real-time direct messages
- Voice calls via WebRTC
- Dark themed UI

## Local Development

```bash
npm install
npm run dev
# Open http://localhost:3000
```

## Deploy to Render (Free Tier)

### Option A — Blueprint (recommended)
1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Blueprint
3. Connect your GitHub repo
4. Render will auto-detect `render.yaml` and configure everything
5. Hit **Apply** — your app will be live in ~2 minutes

### Option B — Manual
1. Push to GitHub
2. Render → New → Web Service → Connect repo
3. Set:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment**: Node
4. Add Environment Variables:
   - `SESSION_SECRET` → any long random string
   - `DATA_DIR` → `/opt/render/project/data`
   - `UPLOADS_DIR` → `/opt/render/project/data/avatars`
5. Add a **Disk** (under Advanced):
   - Mount Path: `/opt/render/project/data`
   - Size: 1 GB (free tier supports 1 GB)
6. Deploy!

## Notes
- The free Render tier spins down after 15min of inactivity (cold start ~30s)
- Persistent disk keeps your database and avatars safe across deploys
- Voice calls use STUN servers (Google's free ones) — works for most networks
- For production, consider adding TURN server credentials for users behind strict firewalls
