# --- Build stage ---------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

# Install dependencies against the lockfile for reproducible builds.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# DATABASE_URL is only needed at runtime, not build time (DB access is lazy).
RUN npm run build

# --- Runtime stage -------------------------------------------------------------
FROM node:22-alpine AS runner
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
# Next.js standalone output bundles only the files the server actually needs.
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000
CMD ["node", "server.js"]
