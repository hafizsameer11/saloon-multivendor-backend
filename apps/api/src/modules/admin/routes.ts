/** Admin panel API (/api/v1/admin) — admin role only. */
import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, badRequest, notFound } from '../../lib/errors';
import { sApplication, sBanner, sBooking, sCoupon, sLedger, sOrder, sProduct, sReview, sSalon, sTicket, sUser, sWithdrawal } from '../../lib/serialize';
import { body, query, q } from '../../middleware/validate';
import { requireAuth, requireRole } from '../../middleware/auth';
import { audit, notify } from '../../lib/notify';
import { signedUrl } from '../../lib/storage';
import { getSettings, updateSettings, DEFAULT_SETTINGS } from '../../lib/settings';
import { rateToBps, toCents } from '../../lib/money';
import { addDays, toISODate } from '../../lib/time';
import { executeWithdrawal, rejectWithdrawal } from '../wallet/withdrawals';
import { centsSummaryToEuro, recordAdjustment, walletSummary } from '../wallet/ledger';
import { refundPayment } from '../payments/service';
import { refreshRatings } from '../reviews/routes';
import { missingForSubmit } from '../seller/application';
import { m } from '../../lib/i18n';

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole('admin'));
const page = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) });

// ── applications ──
adminRouter.get(
  '/applications',
  query(z.object({ status: z.enum(['draft', 'pending', 'needs_info', 'approved', 'rejected', 'suspended']).optional() })),
  ah(async (_req, res) => {
    const status = (res.locals.query as { status?: string }).status;
    const rows = await prisma.sellerApplication.findMany({ where: status ? { status: status as never } : { status: { not: 'draft' } }, include: { documents: true, salon: true }, orderBy: { submittedAt: 'desc' } });
    res.json(rows.map((a) => ({ ...sApplication(a), salon: sSalon(a.salon) })));
  }),
);

adminRouter.get(
  '/applications/:id',
  ah(async (req, res) => {
    const a = await prisma.sellerApplication.findUnique({ where: { id: req.params.id }, include: { documents: true, salon: { include: { owner: true } } } });
    if (!a) throw notFound('Candidatura');
    const [services, products] = await Promise.all([
      prisma.service.findMany({ where: { salonId: a.salonId, deletedAt: null } }),
      prisma.product.findMany({ where: { salonId: a.salonId, deletedAt: null }, include: { variants: true } }),
    ]);
    const docs = await Promise.all(a.documents.map(async (d) => ({ id: d.id, type: d.type, name: d.name, uploadedAt: d.uploadedAt.toISOString(), url: d.fileKey.startsWith('demo/') ? null : await signedUrl(d.fileKey) })));
    res.json({ application: { ...sApplication(a), documents: docs }, salon: sSalon(a.salon), owner: sUser(a.salon.owner), servicesCount: services.length, products: products.map(sProduct), missing: await missingForSubmit(a.salonId) });
  }),
);

adminRouter.patch(
  '/applications/:id/checklist',
  body(z.object({ docs: z.boolean(), vat: z.boolean(), iban: z.boolean(), photos: z.boolean() }).partial()),
  ah(async (req, res) => {
    const a = await prisma.sellerApplication.findUniqueOrThrow({ where: { id: req.params.id } });
    const checklist = { ...(a.checklist as object), ...req.body };
    res.json(sApplication(await prisma.sellerApplication.update({ where: { id: a.id }, data: { checklist }, include: { documents: true } })));
  }),
);

const decide = (status: 'approved' | 'rejected' | 'needs_info') =>
  ah(async (req, res) => {
    const a = await prisma.sellerApplication.findUnique({ where: { id: req.params.id }, include: { salon: true } });
    if (!a) throw notFound('Candidatura');
    if (!['pending', 'needs_info'].includes(a.status) && !(status === 'approved' && a.status === 'rejected')) throw badRequest(`Candidatura in stato ${a.status}`, 'bad_state');
    const reason: string | undefined = req.body?.reason;
    if (status !== 'approved' && !reason) throw badRequest('Motivo obbligatorio', 'reason_required');
    if (status === 'approved') {
      const c = a.checklist as Record<string, boolean>;
      if (!req.body?.override && !['docs', 'vat', 'iban', 'photos'].every((k) => c?.[k])) throw badRequest('Completa la checklist di verifica prima di approvare', 'checklist_incomplete');
    }
    await prisma.$transaction(async (tx) => {
      await tx.sellerApplication.update({ where: { id: a.id }, data: { status, reviewedAt: new Date(), rejectionReason: status === 'approved' ? null : reason, adminNotes: req.body?.notes ?? a.adminNotes } });
      await tx.salon.update({ where: { id: a.salonId }, data: { status, verified: status === 'approved', ...(req.body?.commissionRate != null ? { commissionBps: rateToBps(req.body.commissionRate) } : {}) } });
    });
    const msg = {
      approved: [m('Il tuo salone è approvato!', 'Your salon is approved!'), m('Ora sei visibile su MyBeauty+. Completa la verifica Stripe per ricevere i prelievi.', 'You are now live on MyBeauty+. Complete the Stripe verification to receive withdrawals.')],
      rejected: [m('Candidatura non approvata', 'Application not approved'), m(`Motivo: ${reason}`, `Reason: ${reason}`)],
      needs_info: [m('Servono altre informazioni', 'More information needed'), m(`${reason} Aggiorna la candidatura e inviala di nuovo.`, `${reason} Update your application and send it again.`)],
    }[status];
    await notify(a.ownerId, msg[0], msg[1], { link: '/seller', email: true });
    await audit(req.user!.sub, `application.${status}`, 'application', a.id, { reason });
    res.json({ ok: true, status });
  });

const reasonBody = body(z.object({ reason: z.string().max(1000).optional(), notes: z.string().max(2000).optional(), override: z.boolean().optional(), commissionRate: z.number().min(0).max(0.5).optional() }));
adminRouter.post('/applications/:id/approve', reasonBody, decide('approved'));
adminRouter.post('/applications/:id/reject', reasonBody, decide('rejected'));
adminRouter.post('/applications/:id/request-info', reasonBody, decide('needs_info'));

// ── salons ──
adminRouter.get(
  '/salons',
  query(z.object({ status: z.string().optional(), q: z.string().optional() })),
  ah(async (_req, res) => {
    const f = res.locals.query as { status?: string; q?: string };
    const rows = await prisma.salon.findMany({ where: { ...(f.status ? { status: f.status as never } : {}), ...(f.q ? { name: { contains: f.q } } : {}) }, orderBy: { createdAt: 'desc' } });
    res.json(rows.map(sSalon));
  }),
);

adminRouter.patch(
  '/salons/:id',
  body(z.object({ status: z.enum(['approved', 'suspended']).optional(), commissionRate: z.number().min(0).max(0.5).optional(), featured: z.boolean().optional(), reason: z.string().max(500).optional() })),
  ah(async (req, res) => {
    const s = await prisma.salon.findUnique({ where: { id: req.params.id } });
    if (!s) throw notFound('Salone');
    const u = await prisma.salon.update({ where: { id: s.id }, data: { ...(req.body.status ? { status: req.body.status } : {}), ...(req.body.commissionRate != null ? { commissionBps: rateToBps(req.body.commissionRate) } : {}), ...(req.body.featured != null ? { featured: req.body.featured } : {}) } });
    if (req.body.status === 'suspended') await notify(s.ownerId, m('Salone sospeso', 'Salon suspended'), req.body.reason ?? m('Contatta il supporto per maggiori informazioni.', 'Please contact support for more information.'), { email: true });
    if (req.body.commissionRate != null) await notify(s.ownerId, m('Commissione aggiornata', 'Commission updated'), m(`Dalle prossime vendite la commissione sarà ${Math.round(req.body.commissionRate * 100)}%. Le vendite già registrate mantengono la percentuale precedente.`, `From your next sales the commission will be ${Math.round(req.body.commissionRate * 100)}%. Sales already recorded keep the previous rate.`), { email: true });
    await audit(req.user!.sub, 'salon.update', 'salon', s.id, req.body);
    res.json(sSalon(u));
  }),
);

adminRouter.get(
  '/salons/:id/wallet',
  ah(async (req, res) => {
    const sum = await walletSummary(req.params.id);
    const [lines, withdrawals] = await Promise.all([
      prisma.ledgerEntry.findMany({ where: { salonId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.withdrawal.findMany({ where: { salonId: req.params.id }, orderBy: { requestedAt: 'desc' } }),
    ]);
    res.json({ pending: centsSummaryToEuro(sum.pending), available: centsSummaryToEuro(sum.available), inProgress: centsSummaryToEuro(sum.inProgress), withdrawn: centsSummaryToEuro(sum.withdrawn), ledger: lines.map(sLedger), withdrawals: withdrawals.map(sWithdrawal) });
  }),
);

adminRouter.post(
  '/salons/:id/adjustments',
  body(z.object({ amount: z.number().min(-10000).max(10000).refine((v) => v !== 0), description: z.string().min(3).max(200) })),
  ah(async (req, res) => {
    const e = await recordAdjustment(prisma, req.params.id, toCents(req.body.amount), req.body.description, req.user!.sub);
    await audit(req.user!.sub, 'ledger.adjustment', 'salon', req.params.id, req.body);
    res.status(201).json(sLedger(e));
  }),
);

// ── products moderation ──
adminRouter.get(
  '/products',
  query(z.object({ status: z.enum(['draft', 'review', 'published', 'rejected', 'all']).optional() })),
  ah(async (_req, res) => {
    const status = (res.locals.query as { status?: string }).status ?? 'review';
    const rows = await prisma.product.findMany({ where: { ...(status === 'all' ? {} : { status: status as never }), deletedAt: null }, include: { variants: true, salon: { select: { id: true, name: true, status: true } } }, orderBy: { createdAt: 'asc' } });
    res.json(rows.map((p) => ({ ...sProduct(p), salon: p.salon })));
  }),
);

adminRouter.post(
  '/products/:id/moderate',
  body(z.object({ decision: z.enum(['publish', 'reject']), reason: z.string().max(500).optional() })),
  ah(async (req, res) => {
    const p = await prisma.product.findUnique({ where: { id: req.params.id }, include: { salon: true } });
    if (!p) throw notFound('Prodotto');
    if (req.body.decision === 'reject' && !req.body.reason) throw badRequest('Motivo obbligatorio', 'reason_required');
    if (req.body.decision === 'publish' && p.salon.status !== 'approved') throw badRequest('Il salone non è ancora approvato', 'salon_not_approved');
    const u = await prisma.product.update({ where: { id: p.id }, data: { status: req.body.decision === 'publish' ? 'published' : 'rejected', rejectionReason: req.body.decision === 'reject' ? req.body.reason : null }, include: { variants: true } });
    await notify(p.salon.ownerId, req.body.decision === 'publish' ? m('Prodotto pubblicato', 'Product published') : m('Prodotto non approvato', 'Product not approved'), req.body.decision === 'publish' ? m(`"${p.name}" è ora in vendita.`, `"${p.name}" is now on sale.`) : `"${p.name}": ${req.body.reason}`, { link: '/seller/prodotti' });
    await audit(req.user!.sub, `product.${req.body.decision}`, 'product', p.id, { reason: req.body.reason });
    res.json(sProduct(u));
  }),
);

// ── users ──
adminRouter.get(
  '/users',
  query(page.extend({ role: z.enum(['customer', 'seller', 'admin']).optional(), q: z.string().optional() })),
  ah(async (_req, res) => {
    const f = res.locals.query as { role?: string; q?: string; page: number; pageSize: number };
    const where: Prisma.UserWhereInput = { ...(f.role ? { role: f.role as never } : {}), ...(f.q ? { OR: [{ name: { contains: f.q } }, { email: { contains: f.q } }] } : {}) };
    const [total, rows] = await Promise.all([prisma.user.count({ where }), prisma.user.findMany({ where, include: { salon: { select: { id: true } }, _count: { select: { bookings: true, orders: true } } }, orderBy: { createdAt: 'desc' }, skip: (f.page - 1) * f.pageSize, take: f.pageSize })]);
    res.json({ total, items: rows.map((u) => ({ ...sUser(u), bookings: u._count.bookings, orders: u._count.orders })) });
  }),
);

adminRouter.patch(
  '/users/:id',
  body(z.object({ blocked: z.boolean() })),
  ah(async (req, res) => {
    if (req.params.id === req.user!.sub) throw badRequest('Non puoi bloccare te stesso');
    const u = await prisma.user.update({ where: { id: req.params.id }, data: { blocked: req.body.blocked }, include: { salon: { select: { id: true } } } });
    if (req.body.blocked) await prisma.refreshToken.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(req.user!.sub, req.body.blocked ? 'user.block' : 'user.unblock', 'user', u.id);
    res.json(sUser(u));
  }),
);

// ── operations ──
adminRouter.get(
  '/bookings',
  query(page.extend({ status: z.string().optional(), salonId: z.string().optional(), from: z.string().optional() })),
  ah(async (_req, res) => {
    const f = res.locals.query as { status?: string; salonId?: string; from?: string; page: number; pageSize: number };
    const where: Prisma.BookingWhereInput = { ...(f.status ? { status: f.status as never } : {}), ...(f.salonId ? { salonId: f.salonId } : {}), ...(f.from ? { date: { gte: f.from } } : {}) };
    const [total, rows] = await Promise.all([prisma.booking.count({ where }), prisma.booking.findMany({ where, orderBy: [{ date: 'desc' }, { startMin: 'desc' }], skip: (f.page - 1) * f.pageSize, take: f.pageSize })]);
    res.json({ total, items: rows.map(sBooking) });
  }),
);

adminRouter.get(
  '/orders',
  query(page.extend({ returns: z.enum(['true', 'false']).optional() })),
  ah(async (_req, res) => {
    const f = res.locals.query as { returns?: string; page: number; pageSize: number };
    const where: Prisma.OrderWhereInput = { status: { not: 'pending_payment' }, ...(f.returns === 'true' ? { subOrders: { some: { returnRequested: true } } } : {}) };
    const [total, rows] = await Promise.all([prisma.order.count({ where }), prisma.order.findMany({ where, include: { subOrders: true }, orderBy: { createdAt: 'desc' }, skip: (f.page - 1) * f.pageSize, take: f.pageSize })]);
    res.json({ total, items: rows.map(sOrder) });
  }),
);

/** Dispute resolution: admin refunds a sub-order (or part of it) regardless of the seller. */
adminRouter.post(
  '/sub-orders/:id/refund',
  body(z.object({ amount: z.number().positive().optional(), reason: z.string().min(3).max(300) })),
  ah(async (req, res) => {
    const s = await prisma.subOrder.findUnique({ where: { id: req.params.id }, include: { order: true } });
    if (!s) throw notFound('Ordine');
    const p = await prisma.payment.findFirst({ where: { orderId: s.orderId, status: { in: ['succeeded', 'partially_refunded'] } } });
    if (!p) throw badRequest('Nessun pagamento rimborsabile', 'no_payment');
    const sellerGross = s.subtotalCents + s.shippingFeeCents - s.salonDiscountCents;
    const customerPaid = sellerGross - s.platformDiscountCents;
    const amount = req.body.amount ? Math.min(toCents(req.body.amount), customerPaid) : customerPaid;
    const ledgerAmount = Math.round((amount * sellerGross) / Math.max(customerPaid, 1));
    const r = await refundPayment(p.id, amount, req.body.reason, { subOrderId: s.id, ledgerAmountCents: ledgerAmount });
    if (amount >= customerPaid) await prisma.subOrder.update({ where: { id: s.id }, data: { status: 'refunded', timeline: [...(s.timeline as object[]), { status: 'refunded', at: new Date().toISOString() }] } });
    await notify(s.order.customerId, m('Rimborso effettuato', 'Refund issued'), m(`Abbiamo rimborsato €${(r.refundedCents / 100).toFixed(2)} per l’ordine ${s.code}.`, `We refunded €${(r.refundedCents / 100).toFixed(2)} for order ${s.code}.`), { email: true, link: `/account/ordini/${s.orderId}` });
    await audit(req.user!.sub, 'suborder.refund', 'sub_order', s.id, { amount: r.refundedCents, reason: req.body.reason });
    res.json({ refunded: r.refundedCents / 100 });
  }),
);

// ── reviews moderation ──
adminRouter.get('/reviews', query(z.object({ reported: z.enum(['true', 'false']).optional() })), ah(async (_req, res) => res.json((await prisma.review.findMany({ where: (res.locals.query as { reported?: string }).reported === 'true' ? { reported: true } : {}, orderBy: { createdAt: 'desc' }, take: 300 })).map(sReview))));
adminRouter.patch(
  '/reviews/:id',
  body(z.object({ hidden: z.boolean().optional(), reported: z.boolean().optional() })),
  ah(async (req, res) => {
    const r = await prisma.$transaction(async (tx) => {
      const u = await tx.review.update({ where: { id: req.params.id }, data: req.body });
      await refreshRatings(tx, u.salonId, u.productId);
      return u;
    });
    await audit(req.user!.sub, 'review.update', 'review', r.id, req.body);
    res.json(sReview(r));
  }),
);

// ── withdrawals ──
adminRouter.get(
  '/withdrawals',
  query(z.object({ status: z.enum(['requested', 'approved', 'paid', 'rejected', 'failed']).optional() })),
  ah(async (_req, res) => {
    const status = (res.locals.query as { status?: string }).status;
    const rows = await prisma.withdrawal.findMany({ where: status ? { status: status as never } : {}, include: { salon: { select: { id: true, name: true, stripePayoutsReady: true, stripeAccountId: true } } }, orderBy: { requestedAt: 'desc' }, take: 300 });
    res.json(rows.map((w) => ({ ...sWithdrawal(w), salon: w.salon })));
  }),
);
adminRouter.post('/withdrawals/:id/approve', ah(async (req, res) => res.json(sWithdrawal(await executeWithdrawal(req.params.id, req.user!.sub)))));
adminRouter.post(
  '/withdrawals/:id/reject',
  body(z.object({ reason: z.string().min(3).max(500) })),
  ah(async (req, res) => {
    await rejectWithdrawal(req.params.id, req.body.reason, req.user!.sub);
    res.json({ ok: true });
  }),
);

// ── coupons (platform-funded) ──
const couponSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,20}$/), type: z.enum(['percent', 'fixed']), value: z.number().positive().max(1000),
  minSpend: z.number().min(0).default(0), maxUses: z.number().int().min(1).default(1000), active: z.boolean().default(true), expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
adminRouter.get('/coupons', ah(async (_req, res) => res.json((await prisma.coupon.findMany({ orderBy: { createdAt: 'desc' } })).map(sCoupon))));
adminRouter.post(
  '/coupons',
  body(couponSchema),
  ah(async (req, res) => {
    const { value, minSpend, ...rest } = req.body;
    res.status(201).json(sCoupon(await prisma.coupon.create({ data: { ...rest, scope: 'platform', value: rest.type === 'fixed' ? toCents(value) : Math.round(value), minSpendCents: toCents(minSpend) } })));
  }),
);
adminRouter.patch('/coupons/:id', body(z.object({ active: z.boolean().optional(), maxUses: z.number().int().min(1).optional(), expiresAt: z.string().optional() })), ah(async (req, res) => res.json(sCoupon(await prisma.coupon.update({ where: { id: req.params.id }, data: req.body })))));

// ── CMS banners ──
const bannerSchema = z.object({ title: z.string().min(2).max(120), subtitle: z.string().max(200).default(''), image: z.string().url(), cta: z.string().max(40).default(''), link: z.string().max(300).default(''), active: z.boolean().default(true), sort: z.number().int().default(0) });
adminRouter.get('/banners', ah(async (_req, res) => res.json((await prisma.banner.findMany({ orderBy: { sort: 'asc' } })).map(sBanner))));
adminRouter.post('/banners', body(bannerSchema), ah(async (req, res) => res.status(201).json(sBanner(await prisma.banner.create({ data: req.body })))));
adminRouter.put('/banners/:id', body(bannerSchema.partial()), ah(async (req, res) => res.json(sBanner(await prisma.banner.update({ where: { id: req.params.id }, data: req.body })))));
adminRouter.delete('/banners/:id', ah(async (req, res) => { await prisma.banner.delete({ where: { id: req.params.id } }); res.json({ ok: true }); }));

// ── support ──
adminRouter.get('/tickets', ah(async (_req, res) => res.json((await prisma.supportTicket.findMany({ orderBy: { at: 'desc' } })).map(sTicket))));
adminRouter.patch('/tickets/:id', body(z.object({ status: z.enum(['open', 'closed']) })), ah(async (req, res) => res.json(sTicket(await prisma.supportTicket.update({ where: { id: req.params.id }, data: req.body })))));

// ── settings ──
adminRouter.get('/settings', ah(async (_req, res) => res.json(await getSettings())));
adminRouter.put(
  '/settings',
  body(z.object({
    defaultCommissionRate: z.number().min(0).max(0.5), minWithdrawal: z.number().min(1).max(1000), withdrawalAutoApprove: z.boolean(),
    autoWithdrawAfterDays: z.number().int().min(7).max(85), bookingReleaseHours: z.number().int().min(0).max(720), returnWindowDays: z.number().int().min(14).max(60),
    autoDeliverAfterDays: z.number().int().min(5).max(60), paymentHoldMinutes: z.number().int().min(5).max(60), commissionOnCash: z.boolean(),
    freeCancellationHours: z.number().int().min(0).max(168), supportEmail: z.string().email(),
  }).partial()),
  ah(async (req, res) => {
    const s = await updateSettings(req.body);
    await audit(req.user!.sub, 'settings.update', 'settings', 'platform', req.body);
    res.json(s);
  }),
);

// ── dashboard ──
adminRouter.get(
  '/stats',
  ah(async (_req, res) => {
    const from = addDays(new Date(), -30);
    const [paid, refunded, commission, pendingApps, reviewProducts, openWithdrawals, salons, customers, bookings30, openTickets, reported] = await Promise.all([
      prisma.payment.aggregate({ where: { status: { in: ['succeeded', 'partially_refunded', 'refunded'] }, createdAt: { gte: from } }, _sum: { amountCents: true } }),
      prisma.payment.aggregate({ where: { createdAt: { gte: from } }, _sum: { refundedCents: true } }),
      prisma.ledgerEntry.aggregate({ where: { createdAt: { gte: from } }, _sum: { commissionCents: true } }),
      prisma.sellerApplication.count({ where: { status: 'pending' } }),
      prisma.product.count({ where: { status: 'review', deletedAt: null } }),
      prisma.withdrawal.aggregate({ where: { status: { in: ['requested', 'approved'] } }, _sum: { netCents: true }, _count: true }),
      prisma.salon.count({ where: { status: 'approved' } }),
      prisma.user.count({ where: { role: 'customer' } }),
      prisma.booking.count({ where: { date: { gte: toISODate(from) } } }),
      prisma.supportTicket.count({ where: { status: 'open' } }),
      prisma.review.count({ where: { reported: true, hidden: false } }),
    ]);
    res.json({
      gmv30: (paid._sum.amountCents ?? 0) / 100, refunds30: (refunded._sum.refundedCents ?? 0) / 100, commission30: (commission._sum.commissionCents ?? 0) / 100,
      pendingApplications: pendingApps, productsToReview: reviewProducts, openWithdrawals: openWithdrawals._count, openWithdrawalsAmount: (openWithdrawals._sum.netCents ?? 0) / 100,
      salons, customers, bookings30, openTickets, reportedReviews: reported,
    });
  }),
);

adminRouter.get('/audit', query(page), ah(async (_req, res) => { const f = q(res, page); res.json(await prisma.auditLog.findMany({ orderBy: { at: 'desc' }, skip: (f.page - 1) * f.pageSize, take: f.pageSize })); }));
adminRouter.get('/settings/defaults', (_req, res) => res.json(DEFAULT_SETTINGS));
