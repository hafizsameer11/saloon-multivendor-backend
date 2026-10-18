import { Router } from 'express';
import { currentLang, m, pick, tr } from '../../lib/i18n';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from '../../lib/prisma';
import { ah, badRequest, conflict, forbidden, unauthorized } from '../../lib/errors';
import { claimsFor, hashPassword, issueRefresh, revokeRefresh, rotateRefresh, signAccess, verifyPassword } from '../../lib/auth';
import { randomToken, sha256, slugify } from '../../lib/ids';
import { sendMail } from '../../lib/mailer';
import { notifyAdmins } from '../../lib/notify';
import { sUser, sSalon } from '../../lib/serialize';
import { body } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import { env, isTest } from '../../config';
import { DEFAULT_SETTINGS, getSettings } from '../../lib/settings';

export const authRouter = Router();

const limiter = rateLimit({ windowMs: 15 * 60_000, limit: isTest ? 10_000 : 20, standardHeaders: 'draft-7', legacyHeaders: false, handler: (_req, res) => res.status(429).json({ error: { code: 'rate_limited', message: tr('Troppi tentativi, riprova tra qualche minuto') } }) });

const password = z.string().min(8, 'Minimo 8 caratteri').max(128);
const email = z.string().trim().toLowerCase().email('Email non valida');

const registerSchema = z.object({
  role: z.enum(['customer', 'seller']).default('customer'),
  name: z.string().trim().min(2).max(80),
  email,
  phone: z.string().trim().max(30).default(''),
  password,
  city: z.string().trim().max(60).optional(),
  // seller only
  salonName: z.string().trim().min(2).max(80).optional(),
  salonCategory: z.enum(['parrucchiere', 'barber', 'unghie', 'estetica', 'spa']).optional(),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: 'Devi accettare i termini' }) }),
});

const userInclude = { addresses: true, salon: { select: { id: true } } } as const;

async function sessionFor(userId: string, userAgent?: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { ...userInclude, salon: true } });
  const accessToken = signAccess(claimsFor(user));
  const refresh = await issueRefresh(user.id, userAgent);
  return { user: sUser(user), salon: user.salon ? sSalon(user.salon) : null, accessToken, refreshToken: refresh.token, refreshExpiresAt: refresh.expiresAt.toISOString() };
}

authRouter.post(
  '/register',
  limiter,
  body(registerSchema),
  ah(async (req, res) => {
    const b = req.body as z.infer<typeof registerSchema>;
    if (await prisma.user.findUnique({ where: { email: b.email } })) throw conflict('Esiste già un account con questa email', 'email_taken');
    if (b.role === 'seller' && !b.salonName) throw badRequest('Nome del salone obbligatorio', 'salon_name_required');
    const settings = await getSettings();
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({ data: { role: b.role, name: b.name, email: b.email, phone: b.phone, city: b.city, lang: currentLang(), passwordHash: await hashPassword(b.password) } });
      if (b.role === 'seller') {
        let slug = slugify(b.salonName!);
        if (await tx.salon.findUnique({ where: { slug } })) slug = `${slug}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
        const salon = await tx.salon.create({
          data: {
            slug, ownerId: u.id, name: b.salonName!, category: b.salonCategory ?? 'parrucchiere', city: b.city ?? '', email: b.email, phone: b.phone,
            gallery: [], amenities: [], status: 'draft', commissionBps: Math.round((settings.defaultCommissionRate ?? DEFAULT_SETTINGS.defaultCommissionRate) * 10000),
            hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: day < 6 ? '09:00' : null, close: day < 6 ? '19:00' : null })),
            policies: { cancellation: 'Cancellazione gratuita fino a 24 ore prima.', noShow: 'In caso di mancata presentazione la caparra non è rimborsabile.', shippingZones: 'Italia', shippingFee: 5.9, freeShippingOver: 49 },
          },
        });
        await tx.sellerApplication.create({ data: { salonId: salon.id, ownerId: u.id, accountHolder: b.name, checklist: { docs: false, vat: false, iban: false, photos: false } } });
      }
      return u;
    });
    const L = currentLang();
    void sendMail(user.email, pick(m('Benvenuto su MyBeauty+', 'Welcome to MyBeauty+'), L), pick(m(`Ciao ${user.name}, il tuo account è pronto.${b.role === 'seller' ? ' Completa la candidatura del tuo salone per iniziare a vendere.' : ''}`, `Hi ${user.name}, your account is ready.${b.role === 'seller' ? ' Complete your salon application to start selling.' : ''}`), L));
    if (b.role === 'seller') void notifyAdmins(m('Nuovo salone registrato', 'New salon signed up'), m(`${b.salonName} (${b.email}) ha creato un account venditore.`, `${b.salonName} (${b.email}) created a seller account.`), '/admin/richieste');
    res.status(201).json(await sessionFor(user.id, req.headers['user-agent']));
  }),
);

authRouter.post(
  '/login',
  limiter,
  body(z.object({ email, password: z.string().min(1) })),
  ah(async (req, res) => {
    const { email: e, password: pw } = req.body as { email: string; password: string };
    const user = await prisma.user.findUnique({ where: { email: e } });
    // same message for unknown email and wrong password (no account enumeration)
    if (!user || !(await verifyPassword(pw, user.passwordHash))) throw unauthorized('Email o password non corretti', 'invalid_credentials');
    if (user.blocked) throw forbidden('Account sospeso. Contatta il supporto.', 'blocked');
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    res.json(await sessionFor(user.id, req.headers['user-agent']));
  }),
);

authRouter.post(
  '/refresh',
  body(z.object({ refreshToken: z.string().min(10) })),
  ah(async (req, res) => {
    const r = await rotateRefresh(req.body.refreshToken, req.headers['user-agent']);
    if (!r) throw unauthorized('Sessione non valida, accedi di nuovo', 'refresh_invalid');
    res.json({ accessToken: signAccess(claimsFor(r.user)), refreshToken: r.refresh.token, refreshExpiresAt: r.refresh.expiresAt.toISOString() });
  }),
);

authRouter.post(
  '/logout',
  body(z.object({ refreshToken: z.string().optional() })),
  ah(async (req, res) => {
    if (req.body.refreshToken) await revokeRefresh(req.body.refreshToken);
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/forgot',
  limiter,
  body(z.object({ email })),
  ah(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { email: req.body.email } });
    if (user && !user.blocked) {
      const token = randomToken(32);
      await prisma.passwordReset.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 60 * 60_000) } });
      const link = `${env.WEB_PUBLIC_URL}/#/reimposta-password?token=${token}`;
      const L = user.lang === 'en' ? 'en' : 'it';
      await sendMail(user.email, pick(m('Reimposta la tua password', 'Reset your password'), L), pick(m(`Ciao ${user.name},\napri questo link entro 1 ora per scegliere una nuova password:\n${link}\n\nSe non sei stato tu, ignora questa email.`, `Hi ${user.name},\nopen this link within 1 hour to choose a new password:\n${link}\n\nIf this wasn’t you, ignore this email.`), L));
    }
    // always 200: don't reveal whether the email exists
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/reset',
  limiter,
  body(z.object({ token: z.string().min(10), password })),
  ah(async (req, res) => {
    const row = await prisma.passwordReset.findUnique({ where: { tokenHash: sha256(req.body.token) } });
    if (!row || row.usedAt || row.expiresAt < new Date()) throw badRequest('Link scaduto o già usato', 'reset_invalid');
    await prisma.$transaction([
      prisma.user.update({ where: { id: row.userId }, data: { passwordHash: await hashPassword(req.body.password) } }),
      prisma.passwordReset.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
      prisma.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  ah(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.user!.sub }, include: { ...userInclude, salon: true } });
    if (!user || user.blocked) throw unauthorized();
    res.json({ user: sUser(user), salon: user.salon ? sSalon(user.salon) : null });
  }),
);

authRouter.post(
  '/change-password',
  requireAuth,
  body(z.object({ currentPassword: z.string(), newPassword: password })),
  ah(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.sub } });
    if (!(await verifyPassword(req.body.currentPassword, user.passwordHash))) throw badRequest('Password attuale errata', 'wrong_password');
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(req.body.newPassword) } });
    res.json({ ok: true });
  }),
);
