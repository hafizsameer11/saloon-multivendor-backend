import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from '../../lib/prisma';
import { ah } from '../../lib/errors';
import { sTicket } from '../../lib/serialize';
import { body } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';
import { notifyAdmins } from '../../lib/notify';
import { isTest } from '../../config';
import { m } from '../../lib/i18n';

export const supportRouter = Router();
const limiter = rateLimit({ windowMs: 60 * 60_000, limit: isTest ? 10_000 : 10 });

/** Contact form (guests too). */
supportRouter.post(
  '/support/tickets',
  limiter,
  body(z.object({ email: z.string().email().optional(), name: z.string().max(80).optional(), subject: z.string().trim().min(3).max(160), message: z.string().trim().min(10).max(4000) })),
  ah(async (req, res) => {
    const u = req.user ? await prisma.user.findUnique({ where: { id: req.user.sub } }) : null;
    const from = u ? `${u.name} <${u.email}>` : `${req.body.name ?? 'Ospite'} <${req.body.email ?? 'sconosciuto'}>`;
    const t = await prisma.supportTicket.create({ data: { userId: u?.id, from, subject: req.body.subject, message: req.body.message } });
    await notifyAdmins(m('Nuovo ticket di supporto', 'New support ticket'), `${from}: ${req.body.subject}`, '/admin/supporto');
    res.status(201).json(sTicket(t));
  }),
);

supportRouter.get('/me/tickets', requireAuth, ah(async (req, res) => res.json((await prisma.supportTicket.findMany({ where: { userId: req.user!.sub }, orderBy: { at: 'desc' } })).map(sTicket))));
