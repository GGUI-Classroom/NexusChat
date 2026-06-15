# Host Nexus Chat on a Linux PC

This app now runs well as a single Node service on a Linux PC with PostgreSQL. Redis is optional unless you run multiple Node processes. The repo includes a Docker Compose file if you want the database bundled beside the app.

## 1. Install system packages

Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y nodejs npm postgresql postgresql-contrib nginx
```

Use Node 18 or newer:

```bash
node --version
```

## 2. Create the database

Fast path with Docker:

```bash
npm run db:up
cp .env.example .env
```

That starts local PostgreSQL at `127.0.0.1:5432` and Redis at `127.0.0.1:6379` using the default `.env.example` URLs.

Manual PostgreSQL path:

```bash
sudo -u postgres psql
```

Inside `psql`:

```sql
CREATE USER nexus WITH PASSWORD 'change-this-password';
CREATE DATABASE nexus OWNER nexus;
\q
```

## 3. Put the app on the PC

Example location:

```bash
sudo mkdir -p /opt/nexus-chat
sudo chown "$USER":"$USER" /opt/nexus-chat
cd /opt/nexus-chat
git clone YOUR_REPO_URL .
npm install
```

## 4. Configure environment

For a quick direct-LAN setup, create `.env` in the app folder:

```bash
cp .env.example .env
nano .env
```

Use values like:

```env
NODE_ENV=production
PORT=3000
SESSION_SECRET=make-this-a-long-random-string
DATABASE_URL=postgres://nexus:change-this-password@127.0.0.1:5432/nexus
DATABASE_SSL=false
REDIS_URL=redis://127.0.0.1:6379
REQUIRE_REDIS=false
COOKIE_SECURE=false
TRUST_PROXY=
```

Start it:

```bash
npm start
```

Open `http://YOUR_PC_IP:3000`.

## 5. Run it as a systemd service

Create a service user and env file:

```bash
sudo useradd --system --home /opt/nexus-chat --shell /usr/sbin/nologin nexus
sudo chown -R nexus:nexus /opt/nexus-chat
sudo mkdir -p /etc/nexus-chat
sudo cp /opt/nexus-chat/.env /etc/nexus-chat/nexus-chat.env
sudo chmod 600 /etc/nexus-chat/nexus-chat.env
sudo cp /opt/nexus-chat/deploy/nexus-chat.service.example /etc/systemd/system/nexus-chat.service
```

Then enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nexus-chat
sudo systemctl status nexus-chat
```

Logs:

```bash
journalctl -u nexus-chat -f
```

## 6. Optional: use Nginx on port 80/443

Copy `deploy/nginx.conf.example` to `/etc/nginx/sites-available/nexus-chat`, edit `server_name`, then enable it:

```bash
sudo ln -s /etc/nginx/sites-available/nexus-chat /etc/nginx/sites-enabled/nexus-chat
sudo nginx -t
sudo systemctl reload nginx
```

If you add HTTPS with Certbot or another TLS tool, set these in `/etc/nexus-chat/nexus-chat.env`:

```env
COOKIE_SECURE=true
TRUST_PROXY=1
```

Then restart:

```bash
sudo systemctl restart nexus-chat
```

## Useful checks

```bash
curl http://127.0.0.1:3000/health
npm run db:logs
sudo systemctl restart nexus-chat
sudo systemctl stop nexus-chat
```

## Environment switches

| Key | Linux PC default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | required | PostgreSQL connection string |
| `DATABASE_SSL` | `false` | Set `true` for managed PostgreSQL that requires SSL |
| `REDIS_URL` | blank | Optional for one app process |
| `REQUIRE_REDIS` | `false` | Set `true` only when Redis must be present |
| `COOKIE_SECURE` | `false` | Set `true` when users access the app over HTTPS |
| `TRUST_PROXY` | blank | Set `1` behind Nginx/Caddy/Apache reverse proxy |
