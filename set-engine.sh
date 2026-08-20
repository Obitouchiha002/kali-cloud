#!/usr/bin/env bash
# Point the public website at the current engine (VPS) and redeploy Vercel.
# Usage:  ./set-engine.sh https://app.example.com   (or http://VPS_IP:3000)
# Change VPS anytime -> just run this again with the new URL.
set -euo pipefail
cd "$(dirname "$0")"

URL="${1:-}"
if [ -z "$URL" ]; then echo "Usage: ./set-engine.sh <engine-url>"; exit 1; fi
URL="${URL%/}"   # strip trailing slash

echo "window.KALI_ENGINE_URL = \"$URL\";" > web/config.js
echo "engine URL set to: $URL"

# commit (best-effort) and redeploy the static site to Vercel
git add web/config.js 2>/dev/null || true
git commit -q -m "Point website at engine $URL" 2>/dev/null || echo "(nothing to commit)"
git push origin main 2>/dev/null || echo "(git push skipped)"

echo "Redeploying the website to Vercel..."
npx --yes vercel --prod --yes

echo ""
echo "Done. The public site now launches against: $URL"
