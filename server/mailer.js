// ===================================================================
//  Optional email notifications. Configured via env; if SMTP isn't set,
//  it simply logs (so nothing breaks). To enable Gmail:
//    SMTP_HOST=smtp.gmail.com SMTP_PORT=587
//    SMTP_USER=you@gmail.com  SMTP_PASS=<gmail app password>
//    NOTIFY_EMAIL=where-to-send@gmail.com   (defaults to ADMIN_EMAIL)
// ===================================================================
import nodemailer from "nodemailer";

const HOST = process.env.SMTP_HOST;
const PORT = Number(process.env.SMTP_PORT || 587);
const USER = process.env.SMTP_USER;
const PASS = process.env.SMTP_PASS;
const TO   = process.env.NOTIFY_EMAIL || process.env.ADMIN_EMAIL || USER;

let transport = null;
if (HOST && USER && PASS) {
  transport = nodemailer.createTransport({
    host: HOST, port: PORT, secure: PORT === 465,
    auth: { user: USER, pass: PASS },
  });
}
export const emailConfigured = !!transport;

export async function notify(subject, text) {
  console.log(`[notify] ${subject} — ${text}`);
  if (!transport || !TO) return;
  try {
    await transport.sendMail({
      from: `"Kali-Cloud" <${USER}>`, to: TO,
      subject: `[Kali-Cloud] ${subject}`, text,
    });
  } catch (e) { console.log("[notify] email send failed:", e.message); }
}
