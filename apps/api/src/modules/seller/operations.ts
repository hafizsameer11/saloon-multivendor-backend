/** Seller day-to-day: agenda, walk-ins, booking status, orders, returns, reviews, clients, stats. */
import { Router } from 'express';
import { z } from 'zod';
import type { BookingStatus, Salon, SubOrderStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, badRequest, conflict, notFound } from '../../lib/errors';
import { sBooking, sOrder, sReview, sSubOrder } from '../../lib/serialize';
import { body, query, q } from '../../middleware/validate';
import { requireSalon } from '../../middleware/auth';
import { humanCode } from '../../lib/ids';
import { addDays, isISODate, toISODate, toMin } from '../../lib/time';
import { getSettings } from '../../lib/settings';
import { notify } from '../../lib/notify';
import { computeSlots } from '../bookings/availability';
import { recordCashCommission, scheduleRelease, voidPending } from '../wallet/ledger';
import { refundPayment } from '../payments/service';
import { m } from '../../lib/i18n';

export const sellerOpsRouter = Router();

// ── agenda ──
const agendaQ = z.object({ from: z.string().refine(isISODate), to: z.string().refine(isISODate).optional() });
sellerOpsRouter.get(
  '/agenda',
  requireSalon({ approved: true }),
  query(agendaQ),
  ah(async (_req, res) => {
    const salon = res.locals.salon as Salon;
    const f = q(res, agendaQ);
    const rows = await prisma.booking.findMany({
      where: { salonId: salon.id, date: { gte: f.from, lte: f.to ?? f.from }, NOT: { status: 'awaiting_payment', holdExpiresAt: { lt: new Date() } } },
      orderBy: [{ date: 'asc' }, { startMin: 'asc' }],
    });
    res.json(rows.map(sBooking));
  }),
);

const walkIn = z.object({
  customerName: z.string().trim().min(2).max(80), customerPhone: z.string().trim().max(30).default(''), serviceIds: z.array(z.string()).min(1).max(6),
  staffId: z.string().nullish(), date: z.string().refine(isISODate), time: z.string().regex(/^\d{2}:\d{2}$/), notes: z.string().max(500).optional(),
  /** allow double-booking on purpose (salon decision) */
  force: z.boolean().default(false),
});
sellerOpsRouter.post(
  '/bookings',
  requireSalon({ approved: true }),
  body(walkIn),
  ah(async (req, res) => {
    const salon = res.locals.salon as Salon;
    const b = req.body as z.infer<typeof walkIn>;
    const booking = await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM Salon WHERE id = ${salon.id} FOR UPDATE`;
        const [services, staff, day, windows] = await Promise.all([
          tx.service.findMany({ where: { id: { in: b.serviceIds }, salonId: salon.id, deletedAt: null } }),
          tx.staff.findMany({ where: { salonId: salon.id } }),
          tx.booking.findMany({ where: { salonId: salon.id, date: b.date } }),
          tx.timeWindow.findMany({ where: { salonId: salon.id, date: b.date } }),
        ]);
        if (services.length !== new Set(b.serviceIds).size) throw badRequest('Servizio non valido', 'service_unavailable');
        const slot = computeSlots({ salon, date: b.date, services, staff, bookings: day, windows, staffId: b.staffId ?? null, now: new Date(0) }).find((s) => s.time === b.time);
        if (!b.force && (!slot || !slot.free)) throw conflict('Orario occupato (usa force per sovrapporre)', 'slot_taken');
        return tx.booking.create({
          data: {
            code: humanCode('MB'), customerId: null, customerName: b.customerName, customerPhone: b.customerPhone, salonId: salon.id,
            staffId: b.staffId ?? slot?.staffIds[0] ?? null, serviceIds: b.serviceIds, date: b.date, startMin: toMin(b.time),
            durationMin: services.reduce((a, s) => a + s.durationMin + s.bufferMin, 0), totalCents: services.reduce((a, s) => a + s.priceCents, 0),
            paymentMode: 'in_salon', status: 'confirmed', notes: b.notes,
          },
        });
      },
      { isolationLevel: 'ReadCommitted' },
    );
    res.status(201).json(sBooking(booking));
  }),
);

const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  awaiting_payment: ['cancelled'],
  booked: ['confirmed', 'in_progress', 'completed', 'no_show', 'cancelled'],
  confirmed: ['in_progress', 'completed', 'no_show', 'cancelled'],
  in_progress: ['completed'],
  completed: [],
  no_show: [],
  cancelled: [],
};

sellerOpsRouter.patch(
  '/bookings/:id',
  requireSalon({ approved: true }),
  body(z.object({ status: z.enum(['confirmed', 'in_progress', 'completed', 'no_show', 'cancelled']).optional(), staffId: z.string().nullish(), notes: z.string().max(500).optional(), reason: z.string().max(300).optional() })),
  ah(async (req, res) => {
    const salon = res.locals.salon as Salon;
    const settings = await getSettings();
    const b = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!b || b.salonId !== salon.id) throw notFound('Prenotazione');
    const next = req.body.status as BookingStatus | undefined;
    if (next && next !== b.status && !TRANSITIONS[b.status].includes(next)) throw badRequest(`Non puoi passare da ${b.status} a ${next}`, 'bad_transition');
    if (next && ['completed', 'no_show'].includes(next) && b.date > toISODate(new Date())) throw badRequest('Appuntamento non ancora avvenuto', 'in_future');

    const updated = await prisma.booking.update({ where: { id: b.id }, data: { ...(next ? { status: next } : {}), ...(req.body.staffId !== undefined ? { staffId: req.body.staffId } : {}), ...(req.body.notes !== undefined ? { notes: req.body.notes } : {}), ...(next === 'cancelled' ? { cancelledAt: new Date() } : {}) } });
    const releaseAt = new Date(Date.now() + settings.bookingReleaseHours * 3600_000);

    if (next === 'completed' && b.status !== 'completed') {
      await scheduleRelease(prisma, 'booking', b.id, releaseAt);
      const cash = b.totalCents - b.paidCents;
      if (settings.commissionOnCash && cash > 0)
        await recordCashCommission(prisma, { salonId: salon.id, cashCents: cash, sourceType: 'booking', sourceId: b.id, description: `Prenotazione ${b.code} (pagata in salone)`, availableAt: releaseAt });
      if (b.customerId) await notify(b.customerId, m('Com’è andata?', 'How did it go?'), m(`Lascia una recensione per ${salon.name}.`, `Leave a review for ${salon.name}.`), { link: `/account/recensioni?booking=${b.id}` });
    }
    if (next === 'no_show') await scheduleRelease(prisma, 'booking', b.id, releaseAt); // salon keeps the deposit
    if (next === 'cancelled') {
      const p = await prisma.payment.findFirst({ where: { bookingId: b.id, status: { in: ['succeeded', 'partially_refunded'] } } });
      if (p) await refundPayment(p.id, p.amountCents - p.refundedCents, 'Annullata dal salone'); // salon cancels → customer always refunded
      await scheduleRelease(prisma, 'booking', b.id, new Date());
      if (b.customerId) await notify(b.customerId, m('Appuntamento annullato dal salone', 'Appointment cancelled by the salon'), m(`${salon.name} ha annullato il tuo appuntamento del ${b.date}.${p ? ' Riceverai il rimborso completo.' : ''}${req.body.reason ? ' Motivo: ' + req.body.reason : ''}`, `${salon.name} cancelled your appointment on ${b.date}.${p ? ' You will receive a full refund.' : ''}${req.body.reason ? ' Reason: ' + req.body.reason : ''}`), { link: '/account/prenotazioni', email: true });
    }
    if (next === 'confirmed' && b.customerId) await notify(b.customerId, m('Appuntamento confermato', 'Appointment confirmed'), m(`${salon.name} ha confermato il tuo appuntamento del ${b.date}.`, `${salon.name} confirmed your appointment on ${b.date}.`), { link: '/account/prenotazioni' });
    res.json(sBooking(updated));
  }),
);

// ── orders ──
const ordersQ = z.object({ status: z.string().optional() });
sellerOpsRouter.get(
  '/orders',
  requireSalon({ approved: true }),
  query(ordersQ),
  ah(async (_req, res) => {
    const salon = res.locals.salon as Salon;
    const f = q(res, ordersQ);
    const rows = await prisma.subOrder.findMany({
      where: { salonId: salon.id, status: f.status ? (f.status as SubOrderStatus) : { not: 'awaiting_payment' } },
      include: { order: { select: { code: true, customerName: true, address: true, createdAt: true, customerId: true } } },
      orderBy: { order: { createdAt: 'desc' } },
    });
    res.json(rows.map((s) => ({ ...sSubOrder(s), order: { code: s.order.code, customerName: s.order.customerName, address: s.order.address, createdAt: s.order.createdAt.toISOString() } })));
  }),
);

const NEXT: Record<SubOrderStatus, SubOrderStatus[]> = {
  awaiting_payment: [],
  received: ['preparing', 'cancelled'],
  preparing: ['shipped', 'ready_pickup', 'cancelled'],
  shipped: ['delivered'],
  ready_pickup: ['delivered'],
  delivered: ['refunded'],
  cancelled: [],
  refunded: [],
};

sellerOpsRouter.patch(
  '/sub-orders/:id',
  requireSalon({ approved: true }),
  body(z.object({ status: z.enum(['preparing', 'shipped', 'ready_pickup', 'delivered', 'cancelled', 'refunded']), trackingNo: z.string().max(60).optional(), carrier: z.string().max(40).optional(), reason: z.string().max(300).optional() })),
  ah(async (req, res) => {
    const salon = res.locals.salon as Salon;
    const settings = await getSettings();
    const s = await prisma.subOrder.findUnique({ where: { id: req.params.id }, include: { order: true } });
    if (!s || s.salonId !== salon.id) throw notFound('Ordine');
    const next = req.body.status as SubOrderStatus;
    if (!NEXT[s.status].includes(next)) throw badRequest(`Non puoi passare da ${s.status} a ${next}`, 'bad_transition');
    if (next === 'shipped' && s.shippingMethod !== 'standard') throw badRequest('Ordine con ritiro in salone', 'pickup_order');
    if (next === 'ready_pickup' && s.shippingMethod !== 'pickup') throw badRequest('Ordine da spedire', 'shipping_order');
    if (next === 'shipped' && !req.body.trackingNo) throw badRequest('Numero di tracking obbligatorio', 'tracking_required');
    if (next === 'refunded' && !s.returnRequested) throw badRequest('Nessuna richiesta di reso', 'no_return');

    const timeline = [...((s.timeline as { status: string; at: string }[]) ?? []), { status: next, at: new Date().toISOString() }];
    const updated = await prisma.subOrder.update({
      where: { id: s.id },
      data: {
        status: next, timeline, ...(req.body.trackingNo ? { trackingNo: req.body.trackingNo, carrier: req.body.carrier ?? 'BRT' } : {}),
        ...(next === 'shipped' ? { shippedAt: new Date() } : {}), ...(next === 'delivered' ? { deliveredAt: new Date() } : {}),
      },
    });

    // customer paid: items + shipping − salon coupon − platform coupon; seller earned: items + shipping − salon coupon
    const sellerGross = s.subtotalCents + s.shippingFeeCents - s.salonDiscountCents;
    const customerPaid = sellerGross - s.platformDiscountCents;
    const payment = await prisma.payment.findFirst({ where: { orderId: s.orderId, status: { in: ['succeeded', 'partially_refunded'] } } });

    if (next === 'delivered') await scheduleRelease(prisma, 'sub_order', s.id, addDays(new Date(), settings.returnWindowDays));
    if (next === 'cancelled') {
      await voidPending(prisma, 'sub_order', s.id);
      if (payment) await refundPayment(payment.id, customerPaid, 'Annullato dal venditore', { subOrderId: s.id, ledgerAmountCents: 0 });
      // put stock back
      for (const it of s.items as { productId: string; variantId?: string; qty: number }[]) {
        await prisma.product.update({ where: { id: it.productId }, data: { stock: { increment: it.qty }, sold: { decrement: it.qty } } });
        if (it.variantId) await prisma.productVariant.updateMany({ where: { id: it.variantId }, data: { stock: { increment: it.qty } } });
      }
    }
    if (next === 'refunded' && payment) {
      await refundPayment(payment.id, customerPaid, 'Reso accettato', { subOrderId: s.id, ledgerAmountCents: sellerGross });
      await scheduleRelease(prisma, 'sub_order', s.id, new Date());
    }
    const msg: Partial<Record<SubOrderStatus, readonly [string, string]>> = {
      preparing: m('Il salone sta preparando il tuo ordine.', 'The salon is preparing your order.'),
      shipped: m(`Ordine spedito. Tracking ${req.body.trackingNo ?? ''}`, `Order shipped. Tracking ${req.body.trackingNo ?? ''}`),
      ready_pickup: m('Il tuo ordine è pronto per il ritiro in salone.', 'Your order is ready for pickup at the salon.'),
      delivered: m('Ordine consegnato. Hai 14 giorni per un eventuale reso.', 'Order delivered. You have 14 days to request a return.'),
      cancelled: m(`Ordine annullato dal salone e rimborsato.${req.body.reason ? ' Motivo: ' + req.body.reason : ''}`, `Order cancelled by the salon and refunded.${req.body.reason ? ' Reason: ' + req.body.reason : ''}`),
      refunded: m('Reso accettato: il rimborso è in arrivo sulla tua carta.', 'Return accepted: the refund is on its way to your card.'),
    };
    await notify(s.order.customerId, m(`Ordine ${s.code}`, `Order ${s.code}`), msg[next] ?? next, { link: `/account/ordini/${s.orderId}`, email: ['shipped', 'ready_pickup', 'cancelled', 'refunded'].includes(next) });
    res.json(sSubOrder(updated));
  }),
);

sellerOpsRouter.post(
  '/sub-orders/:id/reject-return',
  requireSalon({ approved: true }),
  body(z.object({ reason: z.string().min(3).max(300) })),
  ah(async (req, res) => {
    const salon = res.locals.salon as Salon;
    const settings = await getSettings();
    const s = await prisma.subOrder.findUnique({ where: { id: req.params.id }, include: { order: true } });
    if (!s || s.salonId !== salon.id) throw notFound('Ordine');
    if (!s.returnRequested) throw badRequest('Nessuna richiesta di reso');
    await prisma.subOrder.update({ where: { id: s.id }, data: { returnRequested: false, returnReason: `${s.returnReason ?? ''} — Rifiutato: ${req.body.reason}` } });
    await scheduleRelease(prisma, 'sub_order', s.id, addDays(s.deliveredAt ?? new Date(), settings.returnWindowDays));
    await notify(s.order.customerId, m(`Reso ${s.code} non accettato`, `Return ${s.code} not accepted`), m(`Motivo: ${req.body.reason}. Puoi contattare il supporto MyBeauty+.`, `Reason: ${req.body.reason}. You can contact MyBeauty+ support.`), { email: true, link: `/account/ordini/${s.orderId}` });
    res.json({ ok: true });
  }),
);

// ── reviews ──
sellerOpsRouter.get('/reviews', requireSalon(), ah(async (_req, res) => res.json((await prisma.review.findMany({ where: { salonId: (res.locals.salon as Salon).id, hidden: false }, orderBy: { createdAt: 'desc' } })).map(sReview))));
sellerOpsRouter.post(
  '/reviews/:id/reply',
  requireSalon({ approved: true }),
  body(z.object({ reply: z.string().trim().min(2).max(1000) })),
  ah(async (req, res) => {
    const r = await prisma.review.findUnique({ where: { id: req.params.id } });
    if (!r || r.salonId !== (res.locals.salon as Salon).id) throw notFound('Recensione');
    const u = await prisma.review.update({ where: { id: r.id }, data: { reply: req.body.reply } });
    await notify(r.customerId, m('Il salone ha risposto', 'The salon replied'), m(`${(res.locals.salon as Salon).name} ha risposto alla tua recensione.`, `${(res.locals.salon as Salon).name} replied to your review.`), { link: '/account/recensioni' });
    res.json(sReview(u));
  }),
);
sellerOpsRouter.post(
  '/reviews/:id/report',
  requireSalon({ approved: true }),
  ah(async (req, res) => {
    const r = await prisma.review.findUnique({ where: { id: req.params.id } });
    if (!r || r.salonId !== (res.locals.salon as Salon).id) throw notFound('Recensione');
    await prisma.review.update({ where: { id: r.id }, data: { reported: true } });
    res.json({ ok: true });
  }),
);

// ── clients ──
sellerOpsRouter.get(
  '/clients',
  requireSalon({ approved: true }),
  ah(async (_req, res) => {
    const salon = res.locals.salon as Salon;
    const rows = await prisma.booking.groupBy({ by: ['customerName', 'customerPhone', 'customerId'], where: { salonId: salon.id, status: { in: ['completed', 'booked', 'confirmed'] } }, _count: true, _sum: { totalCents: true }, _max: { date: true } });
    res.json(rows.map((r) => ({ customerId: r.customerId, name: r.customerName, phone: r.customerPhone, visits: r._count, spent: (r._sum.totalCents ?? 0) / 100, lastVisit: r._max.date })).sort((a, b) => b.spent - a.spent));
  }),
);

// ── dashboard stats ──
sellerOpsRouter.get(
  '/stats',
  requireSalon(),
  query(z.object({ days: z.coerce.number().int().min(7).max(365).default(30) })),
  ah(async (_req, res) => {
    const salon = res.locals.salon as Salon;
    const days = (res.locals.query as { days: number }).days;
    const from = toISODate(addDays(new Date(), -days + 1));
    const today = toISODate(new Date());
    const [bookings, subs, upcoming, pendingOrders, unanswered] = await Promise.all([
      prisma.booking.findMany({ where: { salonId: salon.id, date: { gte: from, lte: today }, status: { in: ['completed', 'booked', 'confirmed', 'in_progress'] } }, select: { date: true, totalCents: true } }),
      prisma.subOrder.findMany({ where: { salonId: salon.id, status: { notIn: ['awaiting_payment', 'cancelled', 'refunded'] }, order: { createdAt: { gte: new Date(from) } } }, select: { subtotalCents: true, order: { select: { createdAt: true } } } }),
      prisma.booking.count({ where: { salonId: salon.id, date: { gte: today }, status: { in: ['booked', 'confirmed'] } } }),
      prisma.subOrder.count({ where: { salonId: salon.id, status: { in: ['received', 'preparing'] } } }),
      prisma.review.count({ where: { salonId: salon.id, reply: null, hidden: false } }),
    ]);
    const series = new Map<string, { date: string; services: number; products: number }>();
    for (let i = 0; i < days; i++) {
      const d = toISODate(addDays(new Date(from), i));
      series.set(d, { date: d, services: 0, products: 0 });
    }
    for (const b of bookings) series.get(b.date) && (series.get(b.date)!.services += b.totalCents / 100);
    for (const s of subs) {
      const d = toISODate(s.order.createdAt);
      if (series.get(d)) series.get(d)!.products += s.subtotalCents / 100;
    }
    res.json({
      revenueServices: bookings.reduce((a, b) => a + b.totalCents, 0) / 100,
      revenueProducts: subs.reduce((a, s) => a + s.subtotalCents, 0) / 100,
      bookings: bookings.length, orders: subs.length, upcoming, pendingOrders, unansweredReviews: unanswered, rating: salon.rating, reviewCount: salon.reviewCount,
      series: [...series.values()],
    });
  }),
);

export const _unused = sOrder;
