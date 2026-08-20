#!/usr/bin/env bash
# ===================================================================
#  Kali-Cloud one-command VPS deploy (repeatable / VPS-portable).
#  Run on a fresh Ubuntu/Debian VPS as root:
#     ADMIN_EMAIL=you@example.com bash deploy.sh
#  Optional HTTPS (needs a domain pointed at this VPS):
#     ADMIN_EMAIL=you@example.com DOMAIN=app.example.com bash deploy.sh
#  Moving to a new VPS? Just run this again there.
# ===================================================================
set -euo pipefail

REPO="${REPO:-https://github.com/Obitouchiha002/kali-cloud.git}"
DIR="${DIR:-/opt/kali-cloud}"
PORT="${PORT:-3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-vk1234888i@gmail.com}"
DOMAIN="${DOMAIN:-}"
METAPACKAGE="${METAPACKAGE:-kali-linux-headless}"   # or kali-linux-default (full, big)

log(){ echo -e "\n\033[1;36m==> $*\033[0m"; }

log "Installing prerequisites (docker, node, git, caddy)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git ufw
# Docker
if ! command -v docker >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sh; fi
systemctl enable --now docker
# Node.js 20+
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

log "Fetching the code into $DIR"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO" "$DIR"; fi

log "Building the Kali image (this takes a while the first time)"
docker build --build-arg METAPACKAGE="$METAPACKAGE" -t kali-cloud:latest "$DIR/docker"

log "Installing server dependencies"
( cd "$DIR/server" && npm install --omit=dev )

log "Creating the systemd service"
cat > /etc/systemd/system/kali-cloud.service <<UNIT
[Unit]
Description=Kali-Cloud control panel
After=docker.service network-online.target
Requires=docker.service

[Service]
WorkingDirectory=$DIR/server
Environment=PORT=$PORT
Environment=ADMIN_EMAIL=$ADMIN_EMAIL
ExecStart=$(command -v node) $DIR/server/index.js
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now kali-cloud
systemctl restart kali-cloud

log "Firewall"
ufw allow OpenSSH >/dev/null 2>&1 || true
if [ -n "$DOMAIN" ]; then ufw allow 80 >/dev/null 2>&1 || true; ufw allow 443 >/dev/null 2>&1 || true;
else ufw allow "$PORT" >/dev/null 2>&1 || true; fi
yes | ufw enable >/dev/null 2>&1 || true

IP=$(curl -fsSL https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
if [ -n "$DOMAIN" ]; then
  log "Setting up HTTPS with Caddy for $DOMAIN"
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
  cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
    reverse_proxy localhost:$PORT
}
CADDY
  systemctl restart caddy
  ENGINE="https://$DOMAIN"
else
  ENGINE="http://$IP:$PORT"
fi

echo ""
echo "======================================================================"
echo "  Kali-Cloud is LIVE:  $ENGINE"
echo "  Admin account: sign up with  $ADMIN_EMAIL"
echo ""
echo "  Point the website at this engine (run on your Mac):"
echo "     ./set-engine.sh $ENGINE"
echo ""
echo "  Manage:  systemctl {status|restart|stop} kali-cloud   ·   journalctl -u kali-cloud -f"
echo "======================================================================"
