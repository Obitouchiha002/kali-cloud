// ===================================================================
//  Kali-Cloud control panel (Phase 1)
//  - Serves a web page with a "Launch my Kali" button
//  - On launch, runs a PRIVATE real-Kali container for that user
//  - Each session gets its own host port -> its own noVNC desktop
//  - Auto-stops idle sessions to save resources
//
//  Requires: Docker running, and the `kali-cloud:latest` image built
//  (docker compose build, or ./start.sh once).
// ===================================================================
import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planFor } from "./plans.js";
import * as auth from "./auth.js";
import * as mailer from "./mailer.js";
import httpProxy from "http-proxy";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Reverse proxy so every desktop streams through THIS server (one HTTPS origin),
// instead of exposing a public port per box. Also lets us auth-gate each desktop.
const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });
proxy.on("error", (err, req, res) => {
  try { if (res && res.writeHead && !res.headersSent) { res.writeHead(502); res.end("desktop unavailable"); } }
  catch {}
});

const APP_PORT      = Number(process.env.PORT || 3000);
const IMAGE         = process.env.KALI_IMAGE || "kali-cloud:latest";
const PORT_BASE     = 6100;                 // per-session noVNC host ports
const PORT_MAX      = 6200;
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 60 * 60 * 1000); // 1h
const MEM_LIMIT     = process.env.KALI_MEM || "3g";
const CPU_LIMIT     = process.env.KALI_CPUS || "2";
const ALLOW_EGRESS  = process.env.ALLOW_EGRESS === "1"; // default: isolated

// Host capacity, detected at startup, so a plan can never request more CPUs/RAM
// than the machine has (Docker rejects --cpus > NCPU). Works on a tiny dev VM
// and a big production server alike.
let HOST_CPUS = 4;
let HOST_MEM_GB = 8;
async function detectHostCaps() {
  try {
    const out = await docker(["info", "--format", "{{.NCPU}}|{{.MemTotal}}"]);
    const [ncpu, mem] = out.split("|");
    if (Number(ncpu) > 0) HOST_CPUS = Number(ncpu);
    if (Number(mem) > 0) HOST_MEM_GB = Math.max(1, Math.floor(Number(mem) / (1024 ** 3)));
    console.log(`host capacity: ${HOST_CPUS} CPUs, ${HOST_MEM_GB} GB`);
  } catch { /* keep defaults */ }
}
// clamp a plan's request to what the host can actually give
function clampCpus(planCpus) { return String(Math.min(Number(planCpus) || 2, HOST_CPUS)); }
function clampMem(planMem) {
  const gb = parseInt(planMem) || 2;
  return `${Math.min(gb, Math.max(1, Math.floor(HOST_MEM_GB * 0.9)))}g`;
}

// --- Adaptive quality profiles ------------------------------------------------
// The browser measures the device/network and asks for a profile; a weak laptop
// or slow link gets a smaller screen, fewer colours, and heavier compression so
// the stream stays smooth instead of laggy. `quality`/`compression` are noVNC
// URL params (0-9); geometry/depth shrink the actual desktop the server renders.
// resize: "scale" keeps the server framebuffer small and lets the browser
// upscale it (cheap for weak devices); "remote" makes the server render at the
// browser's real size (crisp, but heavier) for strong devices.
const QUALITY_PROFILES = {
  low:    { geometry: "1280x720",  depth: 16, quality: 2, compression: 9, resize: "scale"  },
  medium: { geometry: "1440x900",  depth: 24, quality: 6, compression: 6, resize: "scale"  },
  high:   { geometry: "1600x1000", depth: 24, quality: 8, compression: 2, resize: "remote" },
};
const DEFAULT_PROFILE = "medium";

/** @type {Map<string, {id:string, containerName:string, port:number, createdAt:number, timer:NodeJS.Timeout}>} */
const sessions = new Map();
const usedPorts = new Set();

function pickPort() {
  for (let p = PORT_BASE; p <= PORT_MAX; p++) {
    if (!usedPorts.has(p)) { usedPorts.add(p); return p; }
  }
  throw new Error("No free session ports — server at capacity.");
}

async function docker(args) {
  const { stdout } = await execFileP("docker", args, { maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function stopSession(sid, reason = "stopped") {
  const s = sessions.get(sid);
  if (!s) return;
  clearTimeout(s.timer);
  sessions.delete(sid);
  usedPorts.delete(s.port);
  try { await docker(["rm", "-f", s.containerName]); } catch {}
  if (s.network) { try { await docker(["network", "rm", s.network]); } catch {} }
  const durMs = Date.now() - (s.createdAt || Date.now());
  auth.logActivity({ email: s.email, type: "end", sid, durMs, reason });
  console.log(`[session ${sid.slice(0,8)}] ${reason} (${Math.round(durMs/1000)}s)`);
}

// one active box per user (prevents resource abuse); stop the old one first
function sessionForUser(uid) {
  return [...sessions.values()].find((s) => s.uid === uid);
}

async function startSession(user, profileName = DEFAULT_PROFILE) {
  const plan = planFor(user.plan);
  // enforce a plan-allowed quality profile
  if (!plan.profiles.includes(profileName)) profileName = DEFAULT_PROFILE;
  const profile = QUALITY_PROFILES[profileName] || QUALITY_PROFILES[DEFAULT_PROFILE];

  // one box per user: reap any existing one so a user can't hoard resources
  const existing = sessionForUser(user.id);
  if (existing) await stopSession(existing.id, "replaced by new session");

  const sid = crypto.randomUUID();
  const port = pickPort();
  const containerName = `kali-cloud-${sid.slice(0, 8)}`;

  // --- per-user isolated network -------------------------------------------
  // A dedicated bridge with NAT/masquerade DISABLED: the browser still reaches
  // the box's noVNC (published port), but the box cannot reach the internet or
  // any other user's box. This is the safety boundary — a box can never attack
  // the real world. (Controlled per-plan egress is a future, audited feature;
  // for now every box is fully sealed regardless of plan.)
  const network = `kali-net-${sid.slice(0, 8)}`;
  await docker([
    "network", "create",
    "-o", "com.docker.network.bridge.enable_ip_masquerade=false",
    network,
  ]);

  const args = [
    "run", "-d",
    "--name", containerName,
    "--hostname", "kali",
    "--add-host", "kali:127.0.0.1",
    "--shm-size", "1g",
    // --- resource caps from the plan (clamped to real host capacity) ---
    "--memory", clampMem(plan.memory),
    "--cpus", clampCpus(plan.cpus),
    "--pids-limit", String(plan.pids),
    // --- baseline hardening (all plans): no root, no privilege escalation ---
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--sysctl", "net.ipv4.ping_group_range=0 2147483647",
    // --- adaptive desktop size/colour for this device ---
    "-e", `SCREEN_GEOMETRY=${profile.geometry}`,
    "-e", `VNC_DEPTH=${profile.depth}`,
    "-p", `${port}:6080`,
    "--network", network,
  ];

  // paid plans: persistent per-user home so files/setup survive between sessions
  let volume = null;
  if (plan.persistent) {
    volume = `kali-home-${user.id.slice(0, 12)}`;
    args.push("-v", `${volume}:/home/kali`);
  }

  // paid EXTRA security layer: read-only root filesystem. The system can't be
  // modified/tampered; only the persistent /home volume and small tmpfs scratch
  // areas are writable. (Requires the persistent home above.)
  if (plan.security === "hardened" && volume) {
    args.push(
      "--read-only",
      "--tmpfs", "/tmp:rw,exec,size=512m",
      "--tmpfs", "/run:rw,size=128m",
      "--tmpfs", "/var/tmp:rw,size=128m",
    );
  }

  args.push(IMAGE);

  try {
    await docker(args);
  } catch (e) {
    usedPorts.delete(port);
    try { await docker(["network", "rm", network]); } catch {}
    throw e;
  }

  const ttl = plan.maxSessionMs;
  const timer = setTimeout(() => stopSession(sid, "auto-timeout (session limit)"), ttl);
  sessions.set(sid, {
    id: sid, uid: user.id, email: user.email, plan: user.plan,
    containerName, port, network, volume,
    createdAt: Date.now(), timer, profile: profileName,
  });
  console.log(`[session ${sid.slice(0,8)}] ${user.email} (${user.plan}) on port ${port}, profile ${profileName}`);
  return { sid, port, profile, plan, ttlMs: ttl };
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true); // behind Traefik/Caddy — use X-Forwarded-For for the real IP
// block banned IPs before anything else
app.use((req, res, next) => {
  if (auth.isIpBanned(req.ip)) return res.status(403).send("Access denied.");
  next();
});
app.use(express.json());

const WEB = path.join(__dirname, "..", "web");

// --- page routes -------------------------------------------------------
// Landing is public; the app (launcher) requires sign-in. Login sits in the
// middle: you browse freely, then sign in when you click Launch.
app.get(["/app", "/app.html"], (req, res) => {
  if (!auth.currentUser(req)) return res.redirect("/login");
  res.sendFile(path.join(WEB, "app.html"));
});
app.get(["/login", "/login.html"], (_req, res) => res.sendFile(path.join(WEB, "login.html")));
app.get("/admin", (req, res) => {
  const u = auth.currentUser(req);
  if (!u) return res.redirect("/login");
  if (u.plan !== "admin") return res.status(403).send("Admins only.");
  res.sendFile(path.join(WEB, "admin.html"));
});

// --- desktop reverse proxy (auth-gated) --------------------------------
// Only the session's owner (or an admin) may reach /desktop/:sid/* — the
// desktops themselves have no VNC password, so this is their access control.
function authorizeDesktop(req, sid) {
  const user = auth.currentUser(req);
  if (!user) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (s.uid !== user.id && user.plan !== "admin") return null;
  return s;
}
app.use("/desktop/:sid", (req, res) => {
  const s = authorizeDesktop(req, req.params.sid);
  if (!s) return res.status(403).send("Forbidden");
  proxy.web(req, res, { target: `http://127.0.0.1:${s.port}` });
});

app.use(express.static(WEB)); // landing, assets, legal, etc.

// --- auth API ----------------------------------------------------------
app.post("/api/auth/register", (req, res) => {
  try {
    const user = auth.register(req.body || {});
    auth.recordUserIp(user.email, req.ip);
    auth.logActivity({ email: user.email, type: "signup", ip: req.ip });
    auth.issueSession(res, user);
    mailer.notify("New signup", `${user.email} just signed up (IP ${req.ip}).`);
    res.json({ ok: true, user });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});
app.post("/api/auth/login", (req, res) => {
  try {
    const user = auth.login(req.body || {});
    auth.recordUserIp(user.email, req.ip);
    auth.issueSession(res, user);
    res.json({ ok: true, user });
  } catch (e) { res.status(401).json({ ok: false, error: String(e.message || e) }); }
});
app.post("/api/auth/logout", (_req, res) => { auth.logout(res); res.json({ ok: true }); });
app.get("/api/auth/me", (req, res) => {
  const u = auth.currentUser(req);
  if (!u) return res.status(401).json({ ok: false });
  res.json({ ok: true, user: u, plan: planFor(u.plan) });
});

// --- simple per-user rate limit on launches ----------------------------
const lastLaunch = new Map();
const LAUNCH_COOLDOWN_MS = 8000;

// --- session API (auth required) ---------------------------------------
app.post("/api/session/start", auth.requireAuth, async (req, res) => {
  try {
    const now = Date.now();
    const prev = lastLaunch.get(req.user.id) || 0;
    if (now - prev < LAUNCH_COOLDOWN_MS) {
      return res.status(429).json({ ok: false, error: "Please wait a few seconds between launches." });
    }
    lastLaunch.set(req.user.id, now);

    const profileName = (req.body && req.body.profile) || DEFAULT_PROFILE;
    const { sid, port, profile, plan, ttlMs } = await startSession(req.user, profileName);
    const sObj = sessions.get(sid); if (sObj) sObj.ip = req.ip;
    auth.logActivity({ email: req.user.email, type: "launch", sid, profile: profileName, ip: req.ip });
    // relative URL through our reverse proxy — works on localhost AND the live
    // domain, over one HTTPS origin. `path` tells noVNC where to open its WebSocket.
    const wsPath = encodeURIComponent(`desktop/${sid}/websockify`);
    const url = `/desktop/${sid}/vnc.html?autoconnect=1&resize=${profile.resize}`
      + `&quality=${profile.quality}&compression=${profile.compression}&path=${wsPath}`;
    res.json({ ok: true, sessionId: sid, url, profile: profileName, plan: plan.id, planName: plan.name, ttlMs });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post("/api/session/stop", auth.requireAuth, async (req, res) => {
  const { sessionId } = req.body || {};
  const s = sessions.get(sessionId);
  if (s && s.uid !== req.user.id && req.user.plan !== "admin") {
    return res.status(403).json({ ok: false, error: "Not your session." });
  }
  await stopSession(sessionId, "user stopped");
  res.json({ ok: true });
});

app.get("/api/sessions", auth.requireAuth, (req, res) => {
  const mine = [...sessions.values()].filter(s => s.uid === req.user.id || req.user.plan === "admin");
  res.json(mine.map(s => ({ sessionId: s.id, port: s.port, plan: s.plan, email: s.email, ageMs: Date.now() - s.createdAt })));
});

// admin: change a user's plan
app.post("/api/admin/set-plan", auth.requireAuth, (req, res) => {
  if (req.user.plan !== "admin") return res.status(403).json({ ok: false, error: "Admins only." });
  try {
    const { email, plan } = req.body || {};
    if (!planFor(plan) || !["free", "pro", "admin"].includes(plan)) throw new Error("Invalid plan.");
    const u = auth.setUserPlan(email, plan);
    res.json({ ok: true, email: u.email, plan: u.plan });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});

// --- admin dashboard API (admins only) ---------------------------------
// count each user's currently-active boxes
function activeCountByEmail() {
  const m = {};
  for (const s of sessions.values()) m[s.email] = (m[s.email] || 0) + 1;
  return m;
}

app.get("/api/admin/users", auth.requireAdmin, (_req, res) => {
  const active = activeCountByEmail();
  res.json({ ok: true, users: auth.listUsers().map(u => ({ ...u, activeSessions: active[u.email] || 0 })) });
});

app.get("/api/admin/live", auth.requireAdmin, (_req, res) => {
  const now = Date.now();
  res.json({ ok: true, sessions: [...sessions.values()].map(s => ({
    email: s.email, plan: s.plan, profile: s.profile, ip: s.ip || null, startedAt: s.createdAt, durationMs: now - s.createdAt,
  })).sort((a, b) => a.startedAt - b.startedAt) });
});

app.get("/api/admin/activity", auth.requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  res.json({ ok: true, activity: auth.getActivity(limit) });
});

// block a user (and immediately kill their running boxes)
app.post("/api/admin/block", auth.requireAdmin, async (req, res) => {
  try {
    const { email } = req.body || {};
    auth.setBlocked(email, true);
    for (const s of [...sessions.values()]) {
      if (s.email && s.email.toLowerCase() === String(email).toLowerCase()) await stopSession(s.id, "user blocked");
    }
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});

app.post("/api/admin/unblock", auth.requireAdmin, (req, res) => {
  try { auth.setBlocked((req.body || {}).email, false); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});

// ban / unban by IP (kills any live boxes from that IP too)
app.get("/api/admin/banned-ips", auth.requireAdmin, (_req, res) => res.json({ ok: true, ips: auth.listBannedIps() }));
app.post("/api/admin/ban-ip", auth.requireAdmin, async (req, res) => {
  try {
    const ip = (req.body || {}).ip;
    if (ip === req.ip) throw new Error("That's your own IP — you'd lock yourself out.");
    auth.banIp(ip);
    for (const s of [...sessions.values()]) if (s.ip === ip) await stopSession(s.id, "ip banned");
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});
app.post("/api/admin/unban-ip", auth.requireAdmin, (req, res) => {
  try { auth.unbanIp((req.body || {}).ip); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
});

// export data as CSV (opens a download)
function csv(rows, cols) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [cols.join(","), ...rows.map(r => cols.map(c => esc(r[c])).join(","))].join("\n");
}
app.get("/api/admin/export/users.csv", auth.requireAdmin, (_req, res) => {
  const rows = auth.listUsers().map(u => ({ ...u,
    createdAt: u.createdAt ? new Date(u.createdAt).toISOString() : "",
    lastLoginAt: u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : "" }));
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=users.csv");
  res.send(csv(rows, ["email", "plan", "blocked", "lastIp", "createdAt", "lastLoginAt", "loginCount"]));
});
app.get("/api/admin/export/activity.csv", auth.requireAdmin, (_req, res) => {
  const rows = auth.getActivity(5000).map(e => ({ ...e, time: new Date(e.t).toISOString() }));
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=activity.csv");
  res.send(csv(rows, ["time", "email", "type", "ip", "sid", "durMs", "reason"]));
});

app.get("/api/health", async (_req, res) => {
  try { await docker(["info"]); res.json({ ok: true, docker: true, image: IMAGE }); }
  catch { res.status(503).json({ ok: false, docker: false, hint: "Is Docker running?" }); }
});

// --- graceful shutdown: kill all spawned Kali boxes --------------------
async function cleanupAll() {
  console.log("\nShutting down — removing all Kali sessions...");
  await Promise.all([...sessions.keys()].map(sid => stopSession(sid, "server shutdown")));
  process.exit(0);
}
process.on("SIGINT", cleanupAll);
process.on("SIGTERM", cleanupAll);

// --- reap orphans from a previous run (crash/restart) so nothing leaks -------
// The session map lives in memory; after a restart, old kali-cloud-* containers
// and kali-net-* networks are untracked. Remove them on boot for a clean slate.
async function reapOrphans() {
  try {
    const ids = (await docker(["ps", "-aq", "--filter", "name=kali-cloud-"]))
      .split("\n").filter(Boolean);
    for (const id of ids) { try { await docker(["rm", "-f", id]); } catch {} }
    const nets = (await docker(["network", "ls", "--filter", "name=kali-net-", "-q"]))
      .split("\n").filter(Boolean);
    for (const n of nets) { try { await docker(["network", "rm", n]); } catch {} }
    if (ids.length || nets.length) {
      console.log(`reaped ${ids.length} orphan box(es), ${nets.length} network(s) from a previous run`);
    }
  } catch (e) {
    console.log("orphan reap skipped:", String(e.message || e));
  }
}

Promise.all([detectHostCaps(), reapOrphans()]).finally(() => {
  const server = app.listen(APP_PORT, () => {
    console.log(`Kali-Cloud control panel  ->  http://localhost:${APP_PORT}`);
    console.log(`Image: ${IMAGE} | egress: ${ALLOW_EGRESS ? "ON" : "isolated"} | TTL: ${SESSION_TTL_MS/60000}min`);
  });

  // proxy noVNC's WebSocket (the desktop stream) through this same server,
  // auth-gated exactly like the HTTP side.
  server.on("upgrade", (req, socket, head) => {
    const m = req.url.match(/^\/desktop\/([^/?]+)(\/[^?]*)?/);
    if (!m) { socket.destroy(); return; }
    const s = authorizeDesktop(req, m[1]);
    if (!s) { socket.destroy(); return; }
    req.url = (m[2] || "/") + (req.url.includes("?") ? "?" + req.url.split("?")[1] : "");
    proxy.ws(req, socket, head, { target: `http://127.0.0.1:${s.port}` });
  });
});
