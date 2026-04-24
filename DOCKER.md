# Docker Deployment Guide

This guide explains how to build, run, and manage tocco-cli in Docker.

## Quick Start

### Build the image
```bash
docker build -t tocco-cli .
```

### Run with compose
```bash
# Create .env from .env.example and populate with your secrets
cp .env.example .env
# Edit .env with your MS_EMAIL, MS_PASSWORD, API_TOKEN, etc.

# Start container
docker-compose up -d

# View logs
docker-compose logs -f tocco-cli

# Stop container
docker-compose down
```

## Architecture

### Base Image
- **`mcr.microsoft.com/playwright:v1.50.0-jammy`**
  - Debian 12 (Jammy) + Node 24
  - Chromium pre-installed (Playwright uses this for web scraping)
  - All system dependencies for headless browser automation
  - Default user: `pwuser`; our image creates `app` user for least privilege

### Multi-Stage Build

1. **base**: Playwright + Node runtime
2. **deps**: Install `package.json` dependencies (npm ci --omit=dev)
3. **runtime**: Copy deps, app files, run as non-root `app` user

Benefits:
- Faster rebuilds (deps cached separately)
- Smaller final image (no npm cache, no devDependencies)
- Security: non-root user, limited filesystem permissions

## Volumes

### data/
- **SQLite database** (auto-created by app on startup)
- **storage.json** (persistent settings, generated credentials)
- **.api-token** (auto-generated if API_TOKEN not set in .env)

Mount at runtime:
```yaml
volumes:
  - ./data:/app/data
```

Data persists across container restarts. Backup `data/` for disaster recovery.

## Environment Variables

Load from `.env` file via `env_file: .env` in compose.

Required at startup:
- `MS_EMAIL`: Microsoft SSO account
- `MS_PASSWORD`: Microsoft SSO password

Optional:
- `API_TOKEN`: API authentication token (auto-generated if unset)
- `ALLOW_UI_CREDENTIALS`: Allow credential changes via web UI (default: false)
- `PORT`: Server port (default: 3000)
- `HEADLESS`: "true" for production, "false" for debugging (default: true)
- `DEBUG_SCRAPER`: Enable DOM dumps on scraper errors (default: false)

Never commit `.env` to git. Use `.env.example` as template.

## Networking

### Default: LAN-Open (port 3000:3000)
Server is accessible from any machine on the network.

To restrict to localhost only:
```yaml
ports:
  - "127.0.0.1:3000:3000"
```

## Health Checks

Container includes built-in healthcheck via HTTP GET to `/healthz`:

```bash
docker ps  # STATUS will show "healthy" or "unhealthy"

# Manual healthcheck
docker exec tocco-cli node -e "require('http').get('http://127.0.0.1:3000/healthz', r => console.log(r.statusCode))"
```

Healthcheck will trigger automatic restart if `restart: unless-stopped` is set.

## Development

For local development, use `docker-compose.override.yml`:

```bash
cp docker-compose.override.yml.example docker-compose.override.yml
docker-compose up
```

Override settings:
- Localhost-only binding (prevent accidental exposure)
- `HEADLESS=false` to see the browser
- `SLOW_MO=100` to slow down Playwright actions for debugging
- `DEBUG_SCRAPER=true` for detailed error logging

## Troubleshooting

### Chromium sandbox errors
If you see "The Chromium sandbox is not available" in logs:

Option A: Uncomment in `docker-compose.yml`:
```yaml
security_opt:
  - seccomp=unconfined
cap_add:
  - SYS_ADMIN
```

Option B: Set env var (less permissive):
```bash
export PLAYWRIGHT_CHROMIUM_ARGS=--no-sandbox
```

Both allow Chromium to run without strict sandboxing. Option B is preferred for security.

### Port already in use
```bash
# Check what's on 3000
lsof -i :3000

# Or use a different port
docker-compose run tocco-cli -e PORT=3001 # (requires compose override)
```

### Missing .env secrets
```bash
docker-compose logs tocco-cli
# Should show: "API_TOKEN auto-generated: ..."
# Check data/.api-token for generated token
```

### Data directory permissions
```bash
# If data/ folder is inaccessible, fix ownership:
sudo chown -R $USER:$USER ./data
chmod 750 ./data
```

## Production Deployment

### 1. Pre-deployment checklist
- [ ] `.env` populated with production secrets
- [ ] `.env` not committed to git (check .gitignore)
- [ ] `data/` directory exists and is writable
- [ ] Port 3000 accessible from required clients
- [ ] Reverse proxy configured (if using one)

### 2. Build once, run everywhere
```bash
# Build on CI/CD
docker build -t tocco-cli:v1.0.0 .

# Push to registry (optional)
docker tag tocco-cli:v1.0.0 myregistry.com/tocco-cli:v1.0.0
docker push myregistry.com/tocco-cli:v1.0.0

# Deploy to production
docker-compose pull  # If using registry
docker-compose up -d
```

### 3. Monitoring
```bash
# Container status
docker-compose ps

# Health status
docker-compose exec tocco-cli curl -s http://127.0.0.1:3000/healthz | jq

# Logs with timestamp
docker-compose logs --timestamps tocco-cli
```

### 4. Updates
```bash
# Pull latest image (if using registry)
docker-compose pull

# Rebuild from local Dockerfile
docker-compose build

# Restart with zero downtime
docker-compose up -d --no-deps --build tocco-cli
```

### 5. Backup
```bash
# Backup SQLite database
tar -czf data-backup-$(date +%Y%m%d).tar.gz ./data

# Restore
tar -xzf data-backup-20240424.tar.gz
docker-compose restart
```

## Security Notes

### Non-root user
App runs as `app` user (UID 1000+), not root. Limits damage from potential container escape.

### Secrets management
- Never hardcode API_TOKEN, MS_PASSWORD in Dockerfile or compose
- Use `.env` file (not committed to git)
- Or pass via docker secrets / Kubernetes secrets in orchestrated environments

### Network isolation
- Default binding: `0.0.0.0:3000` (LAN-open)
- For internet-facing deployment: use firewall or reverse proxy
- Consider nginx/Caddy with SSL/TLS termination
- Enable rate limiting on API endpoints (helmet + express-rate-limit configured)

## Kubernetes Deployment (Future)

If deploying to K8s:
1. Build image and push to registry
2. Create Deployment with image pullPolicy
3. Mount ConfigMap for non-secret env vars
4. Mount Secret for API_TOKEN, MS_PASSWORD
5. Mount PersistentVolume for `data/`
6. Expose via Service/Ingress

See `.k8s/` directory if provided.

---

**Questions?** Check logs: `docker-compose logs -f tocco-cli`
