#!/usr/bin/env bash
#
# CompassDocs one-command installer.
#
#   Community:   curl -fsSL https://raw.githubusercontent.com/mattny20/CompassDocs/main/install.sh | bash
#   Enterprise:  curl -fsSL https://raw.githubusercontent.com/mattny20/CompassDocs/main/install.sh | COMPASSDOCS_EDITION=enterprise bash
#
# Creates a ./compassdocs directory with a docker-compose.yml and a .env
# (generating strong random passwords), then starts the app + Postgres.
# Re-running it updates to the latest image without touching your data or .env.
#
# Enterprise: the image is public (no login needed); paste your license in the
# app under Settings → License, or pass COMPASSDOCS_LICENSE_KEY=... to this
# script to bake it into the generated .env.
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/mattny20/CompassDocs/main"
APP_DIR="${COMPASSDOCS_DIR:-compassdocs}"

# Edition: "community" (default) or "enterprise" (aka "ee").
case "${COMPASSDOCS_EDITION:-community}" in
  ee|enterprise) EDITION=enterprise; COMPOSE_SRC="deploy/docker-compose.ee.yml"; LABEL="CompassDocs Enterprise" ;;
  *)             EDITION=community;  COMPOSE_SRC="deploy/docker-compose.yml";    LABEL="CompassDocs" ;;
esac

say()  { printf '\033[1;34m›\033[0m %s\n' "$1"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$1"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# --- prerequisites ------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "Docker is required. Install it: https://docs.docker.com/get-docker/"
if ! docker compose version >/dev/null 2>&1; then
  die "Docker Compose v2 is required (the 'docker compose' command). Update Docker: https://docs.docker.com/get-docker/"
fi
docker info >/dev/null 2>&1 || die "Docker doesn't appear to be running. Start Docker Desktop (or the docker daemon) and re-run."

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 24
  else LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 48; fi
}

# --- fetch compose ------------------------------------------------------------
say "Installing $LABEL into ./$APP_DIR"
mkdir -p "$APP_DIR"
cd "$APP_DIR"
curl -fsSL "$REPO_RAW/$COMPOSE_SRC" -o docker-compose.yml || die "Couldn't download docker-compose.yml"
ok "Fetched docker-compose.yml ($EDITION)"

# --- generate .env once -------------------------------------------------------
FRESH=0
if [ ! -f .env ]; then
  FRESH=1
  cat > .env <<EOF
POSTGRES_PASSWORD=$(gen_secret)
# You'll create your admin account in the browser on first run (the setup
# wizard). To pre-create it headlessly instead, uncomment and set these:
# COMPASSDOCS_ADMIN_USER=admin
# COMPASSDOCS_ADMIN_PASSWORD=a-strong-password
# ANTHROPIC_API_KEY=sk-ant-...
PORT=3000
EOF
  if [ "$EDITION" = "enterprise" ]; then
    cat >> .env <<EOF
# Enterprise license key. Leave blank to apply it in the app (Settings → License).
COMPASSDOCS_LICENSE_KEY=${COMPASSDOCS_LICENSE_KEY:-}
EOF
  fi
  ok "Generated .env with fresh secrets"
else
  ok "Existing .env found — keeping your settings"
fi

# --- launch -------------------------------------------------------------------
say "Pulling the latest image…"
docker compose pull
say "Starting CompassDocs…"
docker compose up -d

# --- done ---------------------------------------------------------------------
PORT_VAL="$(grep -E '^PORT=' .env | cut -d= -f2)"; PORT_VAL="${PORT_VAL:-3000}"
echo
ok "$LABEL is running at http://localhost:${PORT_VAL}"
if [ "$FRESH" = "1" ]; then
  echo
  echo "  → Open http://localhost:${PORT_VAL} to create your admin account and finish setup."
  if [ "$EDITION" = "enterprise" ] && ! grep -qE '^COMPASSDOCS_LICENSE_KEY=.+' .env; then
    echo "  → Then apply your license under Settings → License to activate Enterprise features."
  fi
fi
echo
echo "  Update later:  cd $APP_DIR && docker compose pull && docker compose up -d"
echo "  View logs:     cd $APP_DIR && docker compose logs -f app"
echo "  Stop:          cd $APP_DIR && docker compose down"
