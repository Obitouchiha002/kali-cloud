# Kali-Cloud

**Real, full Kali Linux desktop — in your browser. Zero setup for the end user.**

Not a fake terminal, not a demo. The official Kali image runs on a server; its
entire XFCE desktop (menus, GUI tools, Burp, Wireshark, file manager, every
command) is streamed to a browser tab over noVNC. The user installs nothing —
they open a URL and they are *inside* Kali.

> WiFi / Bluetooth / radio (aircrack, deauth, etc.) need physical antenna
> hardware a cloud server does not have — that's a future **paid** tier backed by
> real hardware, kept separate on purpose. Everything else is 100% real Kali.

---

## How it works

```
 Browser tab            Server
 ┌──────────┐   noVNC   ┌──────────────────────────────┐
 │ your      │ <=======> │  Docker container            │
 │ Kali      │  (WS)     │  Kali + XFCE + VNC + noVNC    │
 │ desktop   │           │  = the REAL operating system  │
 └──────────┘           └──────────────────────────────┘
```

- **Kali + XFCE** — the actual desktop OS (`kalilinux/kali-rolling` + `kali-desktop-xfce`).
- **TigerVNC** — turns that desktop into a streamable screen.
- **noVNC / websockify** — bridges the screen to the browser over WebSocket.

---

## Setup (one time)

### 1. Install a Docker runtime

**Option A — Docker Desktop (easiest, GUI):**
Download from https://www.docker.com/products/docker-desktop/ , install, launch it once.

**Option B — Colima (lightweight, CLI, no GUI):**
```bash
# needs Homebrew (https://brew.sh)
brew install colima docker docker-compose
colima start --cpu 4 --memory 8 --disk 60
```

Verify it works:
```bash
docker info
```

### 2. Launch Kali-Cloud
```bash
./start.sh
```
First run downloads + builds the full Kali image (several GB — grab a coffee).
When it's done, your browser opens the **real Kali desktop**.

Stop it:
```bash
docker compose down
```

### Faster first build (core tools only)
Edit `docker-compose.yml` -> `METAPACKAGE: kali-linux-headless`, then `./start.sh`.
Swap back to `kali-linux-default` any time for the full toolset.

---

## Roadmap

- **Phase 0 (this):** one real Kali desktop in the browser. ✅ code ready
- **Phase 1:** login + a private Kali box per user + auto-timeout + network isolation.
- **Phase 2:** persistent /home, performance, controlled internet egress.
- **Phase 3:** scale (Kubernetes), paid tier, open-source release.
- **Paid/future:** real-hardware WiFi/Bluetooth/RF lab.

## Security notes
- Containers default to **no outbound internet** (`network_mode: none` in compose).
- Per-user resource caps + auto-shutdown come in Phase 1.
- This tool spins up real attack machines — self-host responsibly, add ToS before public launch.

---

## Run it as a background service (permanent)

The control panel is installed as a macOS **launchd** service so it starts on login,
restarts if it crashes, and brings up the Docker daemon (Colima) if it's down — no more
"server error" when you come back later.

```bash
./kalictl status     # is it up? (service / control panel / docker / active boxes)
./kalictl restart    # restart after code changes
./kalictl logs       # tail the server log
./kalictl stop       # stop the service
./kalictl start      # start it again
./kalictl open       # open the control panel in your browser
```

Service definition: `~/Library/LaunchAgents/com.kalicloud.server.plist`
(runs `run-kalicloud.sh`). Orphaned boxes/networks from a previous run are auto-reaped on start.
