/** Signed-in user's own data: profile, addresses, favourites, notifications, bookings, orders, reviews. */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { ah, notFound } from '../../lib/errors';
import { sAddress, sBooking, sNotification, sOrder, sReview, sUser } from '../../lib/serialize';
import { body } from '../../middleware/validate';
import { requireAuth } from '../../middleware/auth';

export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.patch(
  '/',
  body(z.object({ name: z.string().trim().min(2).max(80).optional(), phone: z.string().trim().max(30).optional(), city: z.string().trim().max(60).optional(), avatar: z.string().url().max(2000).optional(), lang: z.enum(['it', 'en']).optional() })),
  ah(async (req, res) => {
    const u = await prisma.user.update({ where: { id: req.user!.sub }, data: req.body, include: { addresses: true, salon: { select: { id: true } } } });
    res.json(sUser(u));
  }),
);

const addressSchema = z.object({
  label: z.string().trim().min(1).max(40), name: z.string().trim().min(2).max(80), street: z.string().trim().min(3).max(120),
  city: z.string().trim().min(2).max(60), zip: z.string().trim().regex(/^\d{5}$/, 'CAP non valido'), province: z.string().trim().min(2).max(2).toUpperCase(),
  phone: z.string().trim().min(6).max(30), isDefault: z.boolean().optional(),
});

meRouter.get('/addresses', ah(async (req, res) => res.json((await prisma.address.findMany({ where: { userId: req.user!.sub } })).map(sAddress))));

meRouter.post(
  '/addresses',
  body(addressSchema),
  ah(async (req, res) => {
    const uid = req.user!.sub;
    const count = await prisma.address.count({ where: { userId: uid } });
    const isDefault = req.body.isDefault || count === 0;
    const a = await prisma.$transaction(async (tx) => {
      if (isDefault) await tx.address.updateMany({ where: { userId: uid }, data: { isDefault: false } });
      return tx.address.create({ data: { ...req.body, isDefault, userId: uid } });
    });
    res.status(201).json(sAddress(a));
  }),
);

meRouter.put(
  '/addresses/:id',
  body(addressSchema.partial()),
  ah(async (req, res) => {
    const uid = req.user!.sub;
    const existing = await prisma.address.findFirst({ where: { id: req.params.id, userId: uid } });
    if (!existing) throw notFound('Indirizzo');
    const a = await prisma.$transaction(async (tx) => {
      if (req.body.isDefault) await tx.address.updateMany({ where: { userId: uid }, data: { isDefault: false } });
      return tx.address.update({ where: { id: existing.id }, data: req.body });
    });
    res.json(sAddress(a));
  }),
);

meRouter.delete(
  '/addresses/:id',
  ah(async (req, res) => {
    const r = await prisma.address.deleteMany({ where: { id: req.params.id, userId: req.user!.sub } });
    if (!r.count) throw notFound('Indirizzo');
    res.json({ ok: true });
  }),
);

meRouter.get(
  '/favourites',
  ah(async (req, res) => {
    const rows = await prisma.favourite.findMany({ where: { userId: req.user!.sub } });
    res.json({ salons: rows.filter((r) => r.kind === 'salon').map((r) => r.targetId), products: rows.filter((r) => r.kind === 'product').map((r) => r.targetId) });
  }),
);

meRouter.post(
  '/favourites/toggle',
  body(z.object({ kind: z.enum(['salon', 'product']), id: z.string().min(1) })),
  ah(async (req, res) => {
    const key = { userId: req.user!.sub, kind: req.body.kind, targetId: req.body.id };
    const existing = await prisma.favourite.findUnique({ where: { userId_kind_targetId: key } });
    if (existing) await prisma.favourite.delete({ where: { userId_kind_targetId: key } });
    else await prisma.favourite.create({ data: key });
    res.json({ favourite: !existing });
  }),
);

meRouter.get(
  '/notifications',
  ah(async (req, res) => {
    const rows = await prisma.notification.findMany({ where: { userId: req.user!.sub }, orderBy: { at: 'desc' }, take: 100 });
    res.json(rows.map(sNotification));
  }),
);

meRouter.post(
  '/notifications/read',
  body(z.object({ ids: z.array(z.string()).optional() })),
  ah(async (req, res) => {
    await prisma.notification.updateMany({ where: { userId: req.user!.sub, ...(req.body.ids ? { id: { in: req.body.ids } } : {}) }, data: { read: true } });
    res.json({ ok: true });
  }),
);

meRouter.get(
  '/bookings',
  ah(async (req, res) => {
    const rows = await prisma.booking.findMany({ where: { customerId: req.user!.sub }, orderBy: [{ date: 'desc' }, { startMin: 'desc' }] });
    res.json(rows.map(sBooking));
  }),
);

meRouter.get(
  '/orders',
  ah(async (req, res) => {
    const rows = await prisma.order.findMany({ where: { customerId: req.user!.sub, status: { not: 'pending_payment' } }, include: { subOrders: true }, orderBy: { createdAt: 'desc' } });
    res.json(rows.map(sOrder));
  }),
);

meRouter.get(
  '/orders/:id',
  ah(async (req, res) => {
    const o = await prisma.order.findFirst({ where: { id: req.params.id, customerId: req.user!.sub }, include: { subOrders: true } });
    if (!o) throw notFound('Ordine');
    res.json(sOrder(o));
  }),
);

meRouter.get(
  '/reviews',
  ah(async (req, res) => {
    const rows = await prisma.review.findMany({ where: { customerId: req.user!.sub }, orderBy: { createdAt: 'desc' } });
    res.json(rows.map(sReview));
  }),
);
