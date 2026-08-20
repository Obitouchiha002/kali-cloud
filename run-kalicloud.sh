#!/bin/bash
# Kali-Cloud service wrapper: ensures the Docker daemon (Colima) is up, then
# runs the control-panel server. launchd keeps this alive & restarts on crash.
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
LOG=/Library/code/kali-cloud/kalicloud.log
echo "[$(date)] wrapper start" >> "$LOG"

# 1) make sure docker (colima VM) is running
if ! docker info >/dev/null 2>&1; then
  echo "[$(date)] docker down -> colima start" >> "$LOG"
  colima start --vm-type vz --cpu 4 --memory 8 --disk 60 >> "$LOG" 2>&1 || true
fi
# 2) wait until docker is reachable (up to ~2 min)
for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done

# 3) run the control panel (exec so launchd supervises the node process directly)
cd /Library/code/kali-cloud/server || exit 1
echo "[$(date)] launching control panel" >> "$LOG"
exec node index.js
