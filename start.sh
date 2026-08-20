#!/usr/bin/env bash
# Kali-Cloud launcher. Builds (first run) and starts the real Kali desktop.
set -e
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found. Install it first (see README.md -> Setup)."
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but not running. Start Docker/Colima, then re-run."
  exit 1
fi

echo "==> Building + starting Kali-Cloud (first build downloads full Kali, be patient)..."
docker compose up --build -d

URL="http://localhost:6080/vnc.html?autoconnect=1&resize=remote"
echo ""
echo "======================================================================"
echo "  REAL Kali desktop is booting. Open this in your browser:"
echo "     $URL"
echo "  VNC password: kali"
echo "  Stop it with:  docker compose down"
echo "======================================================================"
# try to auto-open on macOS
command -v open >/dev/null 2>&1 && sleep 4 && open "$URL" || true
