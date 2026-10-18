/** Verified reviews only: a completed booking, or a delivered order containing the product. */
import { Router } from 'express';
import { z } from 'zod';
import { prisma, type Tx } from '../../lib/prisma';
import { ah, badRequest, conflict, notFound } from '../../lib/errors';
import { sReview } from '../../lib/serialize';
import { body } from '../../middleware/validate';
import { requireAuth, requireRole } from '../../middleware/auth';
import { notify } from '../../lib/notify';
import { m } from '../../lib/i18n';

export const reviewsRouter = Router();

export async function refreshRatings(tx: Tx, salonId: string, productId?: string | null) {
  const s = await tx.review.aggregate({ where: { salonId, productId: null, hidden: false }, _avg: { rating: true }, _count: true });
  await tx.salon.update({ where: { id: salonId }, data: { rating: Math.round((s._avg.rating ?? 0) * 10) / 10, reviewCount: s._count } });
  if (productId) {
    const p = await tx.review.aggregate({ where: { productId, hidden: false }, _avg: { rating: true }, _count: true });
    await tx.product.update({ where: { id: productId }, data: { rating: Math.round((p._avg.rating ?? 0) * 10) / 10, reviewCount: p._count } });
  }
}

reviewsRouter.post(
  '/reviews',
  requireAuth,
  requireRole('customer'),
  body(z.object({ bookingId: z.string().optional(), productId: z.string().optional(), rating: z.number().int().min(1).max(5), text: z.string().trim().min(10, 'Scrivi almeno 10 caratteri').max(2000) }).refine((v) => !!v.bookingId !== !!v.productId, 'Indica una prenotazione oppure un prodotto')),
  ah(async (req, res) => {
    const uid = req.user!.sub;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: uid } });
    let salonId: string;
    if (req.body.bookingId) {
      const b = await prisma.booking.findUnique({ where: { id: req.body.bookingId } });
      if (!b || b.customerId !== uid) throw notFound('Prenotazione');
      if (b.status !== 'completed') throw badRequest('Puoi recensire solo dopo l’appuntamento', 'not_completed');
      if (b.reviewed) throw conflict('Hai già recensito questo appuntamento');
      salonId = b.salonId;
    } else {
      const p = await prisma.product.findUnique({ where: { id: req.body.productId } });
      if (!p) throw notFound('Prodotto');
      const bought = await prisma.subOrder.findFirst({ where: { salonId: p.salonId, status: 'delivered', order: { customerId: uid } } });
      const has = bought && (bought.items as { productId: string }[]).some((i) => i.productId === p.id);
      if (!has) throw badRequest('Puoi recensire solo prodotti acquistati e consegnati', 'not_purchased');
      if (await prisma.review.findFirst({ where: { customerId: uid, productId: p.id } })) throw conflict('Hai già recensito questo prodotto');
      salonId = p.salonId;
    }
    const r = await prisma.$transaction(async (tx) => {
      const created = await tx.review.create({ data: { customerId: uid, customerName: user.name, customerAvatar: user.avatar, salonId, bookingId: req.body.bookingId, productId: req.body.productId, rating: req.body.rating, text: req.body.text } });
      if (req.body.bookingId) await tx.booking.update({ where: { id: req.body.bookingId }, data: { reviewed: true } });
      await refreshRatings(tx, salonId, req.body.productId);
      return created;
    });
    const salon = await prisma.salon.findUniqueOrThrow({ where: { id: salonId } });
    await notify(salon.ownerId, m('Nuova recensione', 'New review'), `${user.name}: ${'★'.repeat(r.rating)}`, { link: '/seller/recensioni' });
    res.status(201).json(sReview(r));
  }),
);
