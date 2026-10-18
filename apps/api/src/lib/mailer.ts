import nodemailer from 'nodemailer';
import { env, isTest } from '../config';

const transport = env.SMTP_HOST
  ? nodemailer.createTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_PORT === 465, auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined })
  : null;

/** Last emails sent in dev/test (no SMTP) — used by tests and the /dev/mails endpoint. */
export const outbox: { to: string; subject: string; text: string; at: string }[] = [];

export async function sendMail(to: string, subject: string, text: string) {
  if (!transport) {
    outbox.unshift({ to, subject, text, at: new Date().toISOString() });
    outbox.length = Math.min(outbox.length, 50);
    if (!isTest) console.log(`\n📧 [mail → ${to}] ${subject}\n${text}\n`);
    return;
  }
  try {
    await transport.sendMail({ from: env.MAIL_FROM, to, subject, text });
  } catch (e) {
    // never fail a user action because email is down
    console.error('[mail] failed', to, subject, e);
  }
}
