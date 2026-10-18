import { prisma, type Tx } from './prisma';
import { sendMail } from './mailer';
import { pick, type Lang, type Msg } from './i18n';

/**
 * In-app notification (+ optional email), written in the RECIPIENT's language (User.lang).
 * title/body: plain string (same for both languages) or m('italiano', 'english').
 */
export async function notify(userId: string, title: Msg, body: Msg, opts: { link?: string; email?: boolean; tx?: Tx } = {}) {
  const db = opts.tx ?? prisma;
  const u = await db.user.findUnique({ where: { id: userId }, select: { email: true, lang: true } });
  const lang = (u?.lang === 'en' ? 'en' : 'it') as Lang;
  await db.notification.create({ data: { userId, title: pick(title, lang), body: pick(body, lang), link: opts.link } });
  if (opts.email && u) void sendMail(u.email, pick(title, lang), pick(body, lang));
}

export async function notifyAdmins(title: Msg, body: Msg, link?: string) {
  const admins = await prisma.user.findMany({ where: { role: 'admin' }, select: { id: true, lang: true } });
  await prisma.notification.createMany({
    data: admins.map((a) => {
      const lang = (a.lang === 'en' ? 'en' : 'it') as Lang;
      return { userId: a.id, title: pick(title, lang), body: pick(body, lang), link };
    }),
  });
}

export async function audit(actorId: string | undefined, action: string, entity: string, entityId: string, data?: object) {
  await prisma.auditLog.create({ data: { actorId, action, entity, entityId, data: data as object | undefined } });
}
