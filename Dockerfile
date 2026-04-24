# tocco-mate Production Dockerfile
# Base: mcr.microsoft.com/playwright:v1.59.1-jammy (Node 24 + Chromium + system deps)
# IMPORTANT: Playwright version MUST match package.json exactly (browser binaries are version-locked).
# Multi-stage: deps -> runtime with non-root user

# --------- base: Playwright + Node 24 ---------
FROM mcr.microsoft.com/playwright:v1.59.1-jammy AS base
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Pull latest security patches from Ubuntu + upgrade bundled npm
# (fixes Trivy HIGH in /usr/lib/node_modules/npm: tar, minimatch, picomatch,
#  and MEDIUM/LOW in openssl, libssl3, libudev1, libgdk-pixbuf, libcap2)
USER root
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g npm@latest \
 && npm cache clean --force

# --------- deps: install production dependencies ---------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --------- runtime: final production image ---------
FROM base AS runtime

# Create app user (playwright image already has 'pwuser' but for clarity, use app)
RUN groupadd -r app && useradd -r -g app -m -d /home/app app

WORKDIR /app

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy app files with correct ownership
COPY --chown=app:app package.json package-lock.json ./
COPY --chown=app:app src ./src
COPY --chown=app:app web ./web

# Create data + cache directories, set ownership
# - /app/data  : runtime volume (SQLite DB, storage.json, .api-token)
# - /home/app/.cache : Playwright/npm cache fallback (image ships browsers in /ms-playwright)
RUN mkdir -p /app/data /home/app/.cache \
    && chown -R app:app /app /home/app \
    && chmod 750 /app/data

# Switch to non-root user
USER app

EXPOSE 3000

# Healthcheck: verify server is responding on /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Run server with experimental-sqlite flag (Node 22+ feature)
CMD ["node", "--experimental-sqlite", "--no-warnings=ExperimentalWarning", "src/server.js"]
