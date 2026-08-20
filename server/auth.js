// ===================================================================
//  Self-contained auth: scrypt password hashing + HMAC-signed session
//  cookie. Zero external dependencies. Users persisted to data/users.json.
//  (Swappable for Firebase/OAuth later without touching the rest.)
// ===================================================================
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SECRET_FILE = path.join(DATA_DIR, "secret");

// the account that automatically gets the full-access Admin plan
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "vk1234888i@gmail.com").toLowerCase();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

fs.mkdirSync(DATA_DIR, { recursive: true });

// persistent signing secret (survives restarts so sessions stay valid)
let SECRET;
try { SECRET = fs.readFileSync(SECRET_FILE, "utf8").trim(); } catch {}
if (!SECRET) { SECRET = crypto.randomBytes(32).toString("hex"); fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 }); }

function loadUsers() { try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } catch { return {}; } }
function saveUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2), { mode: 0o600 }); }

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const dk = crypto.scryptSync(pw, salt, 64).toString("hex");
  return `scrypt$${salt}$${dk}`;
}
function verifyPassword(pw, stored) {
  try {
    const [, salt, dk] = stored.split("$");
    const test = crypto.scryptSync(pw, salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(dk, "hex"), Buffer.from(test, "hex"));
  } catch { return false; }
}

function planForEmail(email) {
  return email.toLowerCase() === ADMIN_EMAIL ? "admin" : "free";
}

// --- session tokens (JWT-lite, HMAC-SHA256) ----------------------------------
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expect = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  if (!sig || sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

// --- cookie helpers ----------------------------------------------------------
const COOKIE = "kc_session";
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((c) => {
    const i = c.indexOf("="); if (i < 0) return;
    out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie",
    `${COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax${secure}`);
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

const emailOk = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e || "");

// --- public API --------------------------------------------------------------
export function register({ email, password }) {
  email = (email || "").trim().toLowerCase();
  if (!emailOk(email)) throw new Error("Enter a valid email address.");
  if (!password || password.length < 8) throw new Error("Password must be at least 8 characters.");
  const users = loadUsers();
  if (users[email]) throw new Error("An account with this email already exists.");
  const user = {
    id: crypto.randomUUID(), email,
    passHash: hashPassword(password),
    plan: planForEmail(email),
    createdAt: Date.now(),
  };
  users[email] = user;
  saveUsers(users);
  return { id: user.id, email: user.email, plan: user.plan };
}

export function login({ email, password }) {
  email = (email || "").trim().toLowerCase();
  const users = loadUsers();
  const user = users[email];
  if (!user || !verifyPassword(password, user.passHash)) throw new Error("Wrong email or password.");
  // keep admin plan in sync with ADMIN_EMAIL
  const wantPlan = planForEmail(email);
  if (wantPlan === "admin" && user.plan !== "admin") { user.plan = "admin"; users[email] = user; saveUsers(users); }
  return { id: user.id, email: user.email, plan: user.plan };
}

export function issueSession(res, user) {
  const token = signToken({ uid: user.id, email: user.email, plan: user.plan, exp: Date.now() + SESSION_TTL_MS });
  setSessionCookie(res, token);
}

export function logout(res) { clearSessionCookie(res); }

// returns the session payload or null
export function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  const p = verifyToken(token);
  if (!p) return null;
  // re-read the live plan (in case it changed) — cheap for a small user base
  const users = loadUsers();
  const u = Object.values(users).find((x) => x.id === p.uid);
  return u ? { id: u.id, email: u.email, plan: u.plan } : null;
}

// express middleware: attach req.user, 401 if required and missing
export function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: "Please sign in." });
  req.user = u; next();
}

export function setUserPlan(email, plan) {
  email = email.toLowerCase();
  const users = loadUsers();
  if (!users[email]) throw new Error("No such user.");
  users[email].plan = plan; saveUsers(users);
  return users[email];
}
