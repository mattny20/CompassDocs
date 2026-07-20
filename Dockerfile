# --- Build stage ---------------------------------------------------------------
FROM node:26-alpine AS builder
WORKDIR /app

# Install dependencies against the lockfile for reproducible builds.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Edition switch: the community build (default) resolves `@ee` to the stub. The
# enterprise build overlays a private `./ee` package and sets COMPASSDOCS_EE=1
# (see next.config.js). DATABASE_URL is only needed at runtime (DB access is lazy).
ARG COMPASSDOCS_EE=0
ENV COMPASSDOCS_EE=$COMPASSDOCS_EE
RUN npm run build

# --- Runtime stage -------------------------------------------------------------
FROM node:26-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# pg_dump / pg_restore for database backups (match the Postgres 16 server).
RUN apk add --no-cache postgresql16-client
# Default locations for backups and attachments (mount volumes to persist).
ENV COMPASSDOCS_BACKUP_DIR=/backups
ENV COMPASSDOCS_UPLOAD_DIR=/uploads
# Bind to all interfaces so the container is reachable (Next standalone
# otherwise defaults to localhost, which is unreachable from outside).
ENV HOSTNAME=0.0.0.0

# Run as a non-root user (uid/gid 1001). The three writable data directories
# — attachments, backups, and the optional custom-TLS cert dir shared with the
# bundled proxy — are created up front and owned by that user. Existing
# deployments with root-owned volumes need a one-time chown on upgrade; see
# the self-hosting "Updating" guide.
RUN addgroup -g 1001 -S nodejs \
 && adduser -u 1001 -S nextjs -G nodejs \
 && mkdir -p /uploads /backups /caddy-certs \
 && chown -R nextjs:nodejs /uploads /backups /caddy-certs

# Next.js standalone output bundles only the files the server actually needs.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
