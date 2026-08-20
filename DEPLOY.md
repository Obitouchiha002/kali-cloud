# Deploying Kali-Cloud

Kali-Cloud has two parts with **different hosting needs**:

| Part | What it is | Where it can run |
|------|-----------|------------------|
| **Website** (`web/`) | Landing, login, app pages | Any static host **or** the server below |
| **Engine** (`server/` + Docker) | Spawns real Kali desktops | A **Linux server with Docker** (a VPS) — **not** Vercel/Netlify |

> Vercel and other serverless hosts **cannot** run Docker or a long-lived
> container-spawning server. The engine must run on a real VM.

---

## Option A — Everything on one VPS (recommended, simplest)

The Node server already serves the website **and** runs the engine, so one box does it all.

1. Get a small Linux VPS with Docker (e.g. Hetzner CX22, DigitalOcean, AWS EC2). 2 vCPU / 4–8 GB RAM to start.
2. Install Docker, clone this repo, build the image, run the server:
   ```bash
   git clone https://github.com/Obitouchiha002/kali-cloud.git
   cd kali-cloud
   docker build -t kali-cloud:latest ./docker         # build the Kali image
   cd server && npm install && cd ..
   ADMIN_EMAIL=vk1234888i@gmail.com PORT=3000 node server/index.js
   ```
3. Put HTTPS + a domain in front with **Caddy** (auto-TLS). Example `Caddyfile`:
   ```
   your-domain.com {
       reverse_proxy localhost:3000
   }
   ```
   Point your domain's DNS at the VPS IP, run Caddy, and you're live at `https://your-domain.com`.
4. Run it as a service (systemd) so it restarts on crash/reboot.

That's the whole product, public.

---

## Option B — Marketing page on Vercel + engine on a VPS

Use Vercel only for the **public landing page**; the real app runs on the VPS.

1. **Vercel** (this repo has `vercel.json` for it): import the GitHub repo on vercel.com,
   or run `vercel` in this folder. It publishes `web/` as a static site — the landing page
   goes live at `something.vercel.app`.
2. Host the **engine** on a VPS as in Option A.
3. Point the landing page's "Launch" button at your VPS app URL (e.g. `https://app.your-domain.com`).

Note: login and desktop launching only work against the VPS engine — Vercel serves the
marketing page only.

---

## Production checklist before real public launch
- [ ] HTTPS everywhere (Caddy/Let's Encrypt)
- [ ] A domain
- [ ] `ADMIN_EMAIL` set to your admin address
- [ ] Firewall: only expose 80/443; keep per-session ports internal (use the reverse proxy)
- [ ] Backups for `server/data/` (users) if not using an external DB
- [ ] Payment provider (e.g. Stripe) for paid upgrades — not included yet
- [ ] Reviewed Terms/Privacy/Acceptable-Use with a lawyer for your country
