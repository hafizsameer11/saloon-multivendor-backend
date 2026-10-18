/** Seller catalog: storefront settings, services, products (with moderation), staff, coupons. */
import { Router } from 'express';
import { z } from 'zod';
import type { Salon } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, badRequest, conflict, notFound } from '../../lib/errors';
import { sCoupon, sProduct, sSalon, sService, sStaff } from '../../lib/serialize';
import { body } from '../../middleware/validate';
import { requireSalon } from '../../middleware/auth';
import { notifyAdmins } from '../../lib/notify';
import { toCents } from '../../lib/money';
import { salonPatch } from './application';
import { m } from '../../lib/i18n';

export const sellerCatalogRouter = Router();
const own = <T extends { salonId: string } | null>(row: T, salon: Salon, what: string) => {
  if (!row || row.salonId !== salon.id) throw notFound(what);
  return row as NonNullable<T>;
};
const images = z.array(z.string().url().max(2000)).max(10);

// ── storefront ──
sellerCatalogRouter.patch(
  '/salon',
  requireSalon(),
  body(salonPatch),
  ah(async (req, res) => {
    const salon = res.locals.salon as Salon;
    res.json(sSalon(await prisma.salon.update({ where: { id: salon.id }, data: req.body })));
  }),
);

// ── services ──
const serviceSchema = z.object({
  category: z.string().trim().min(2).max(60),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(2000).default(''),
  images: images.min(1, 'Almeno una foto'),
  durationMin: z.number().int().min(5).max(600),
  price: z.number().min(0).max(5000),
  bufferMin: z.number().int().min(0).max(120).default(0),
  depositPct: z.number().int().min(0).max(100).default(0),
  active: z.boolean().default(true),
  popular: z.boolean().default(false),
});
const svcData = (b: Partial<z.infer<typeof serviceSchema>>) => {
  const { price, ...rest } = b;
  return { ...rest, ...(price !== undefined ? { priceCents: toCents(price) } : {}) };
};

sellerCatalogRouter.get('/services', requireSalon(), ah(async (_req, res) => res.json((await prisma.service.findMany({ where: { salonId: (res.locals.salon as Salon).id, deletedAt: null }, orderBy: [{ category: 'asc' }, { name: 'asc' }] })).map(sService))));

sellerCatalogRouter.post(
  '/services',
  requireSalon(),
  body(serviceSchema),
  ah(async (req, res) => {
    const salon = res.locals.salon as Salon;
    const s = await prisma.service.create({ data: { ...svcData(req.body), salonId: salon.id } as never });
    res.status(201).json(sService(s));
  }),
);

sellerCatalogRouter.put(
  '/services/:id',
  requireSalon(),
  body(serviceSchema.partial()),
  ah(async (req, res) => {
    const salon = res.locals.salon as Salon;
    own(await prisma.service.findFirst({ where: { id: req.params.id, deletedAt: null } }), salon, 'Servizio');
    res.json(sService(await prisma.service.update({ where: { id: req.params.id }, data: svcData(req.body) })));
  }),
);

sellerCatalogRouter.delete(
  '/services/:id',
  requireSalon(),
  ah(async (req, res) => {
    const salon = res.locals.salon as Salon;
    own(await prisma.service.findFirst({ where: { id: req.params.id, deletedAt: null } }), salon, 'Servizio');
    // soft delete: past bookings still reference it
    await prisma.service.update({ where: { id: req.params.id }, data: { deletedAt: new Date(), active: false } });
    res.json({ ok: true });
  }),
);

// ── products ──
const variantSchema = z.object({ id: z.string().optional(), label: z.string().trim().min(1).max(40), priceDelta: z.number().min(-1000).max(1000).default(0), stock: z.number().int().min(0).max(100000) });
const productSchema = z.object({
  brand: z.string().trim().min(1).max(60),
  category: z.enum(['capelli', 'unghie', 'viso', 'corpo', 'barba', 'strumenti']),
  name: z.string().trim().min(2).max(120),
  short: z.string().trim().max(160).default(''),
  description: z.string().trim().max(5000).default(''),
  images: images.min(1, 'Almeno una foto'),
  price: z.number().min(0.5).max(5000),
  compareAtPrice: z.number().min(0).max(5000).nullish(),
  stock: z.number().int().min(0).max(100000),
  sku: z.string().trim().max(40).default(''),
  inci: z.string().max(5000).default(''),
  howToUse: z.string().max(2000).default(''),
  weightGr: z.number().int().min(0).max(30000).default(0),
  isNew: z.boolean().default(false),
  variants: z.array(variantSchema).max(30).default([]),
  /** true = send to admin review now; false = keep as draft */
  submit: z.boolean().default(true),
});
// fields that change what customers see → need re-moderation if the product was published
const MODERATED = ['brand', 'category', 'name', 'short', 'description', 'images', 'inci', 'howToUse'] as const;

const productData = (b: Partial<z.infer<typeof productSchema>>) => {
  const { price, compareAtPrice, variants: _v, submit: _s, ...rest } = b;
  return {
    ...rest,
    ...(price !== undefined ? { priceCents: toCents(price) } : {}),
    ...(compareAtPrice !== undefined ? { compareAtCents: compareAtPrice ? toCents(compareAtPrice) : null } : {}),
  };
};

sellerCatalogRouter.get(
  '/products',
  requireSalon(),
  ah(async (_req, res) => res.json((await prisma.product.findMany({ where: { salonId: (res.locals.salon as Salon).id, deletedAt: null }, include: { variants: true }, orderBy: { createdAt: 'desc' } })).map(sProduct))),
);

sellerCatalogRouter.post(
  '/products',
  requireSalon(),
  body(productSchema),
  ah(async (req, res) => {
    const salon = res.locals.salon as Salon;
    const b = req.body as z.infer<typeof productSchema>;
    // before approval products wait as draft; they go to review with the application
    const status = b.submit && salon.status === 'approved' ? 'review' : 'draft';
    const p = await prisma.product.create({
      data: { ...(productData(b) as object), salonId: salon.id, status, variants: { create: b.variants.map((v) => ({ label: v.label, priceDeltaCents: toCents(v.priceDelta), stock: v.stock })) } } as never,
      include: { variants: true },
    });
    if (status === 'review') await notifyAdmins(m('Prodotto da moderare', 'Product to review'), `${salon.name}: ${p.name}`, '/admin/prodotti');
    res.status(201).json(sProduct(p));
  }),
);

sellerCatalogRouter.put(
  '/products/:id',
  requireSalon(),
  body(productSchema.partial()),
  ah(async (req, res) => {
    const salon = res.locals.salon as Salon;
    const b = req.body as Partial<z.infer<typeof productSchema>>;
    const existing = own(await prisma.product.findFirst({ where: { id: req.params.id, deletedAt: null } }), salon, 'Prodotto');
    const contentChanged = MODERATED.some((k) => b[k] !== undefined && JSON.stringify(b[k]) !== JSON.stringify((existing as Record<string, unknown>)[k]));
    let status = existing.status;
    if (existing.status === 'published' && contentChanged) status = 'review';
    if (['draft', 'rejected'].includes(existing.status) && b.submit) status = salon.status === 'approved' ? 'review' : 'draft';
    const p = await prisma.$transaction(async (tx) => {
      if (b.variants) {
        const keep = b.variants.filter((v) => v.id).map((v) => v.id!);
        await tx.productVariant.deleteMany({ where: { productId: existing.id, id: { notIn: keep } } });
        for (const v of b.variants) {
          const data = { label: v.label, priceDeltaCents: toCents(v.priceDelta), stock: v.stock };
          if (v.id) await tx.productVariant.updateMany({ where: { id: v.id, productId: existing.id }, data });
          else await tx.productVariant.create({ data: { ...data, productId: existing.id } });
        }
      }
      return tx.product.update({ where: { id: existing.id }, data: { ...(productData(b) as object), status, rejectionReason: status === 'review' ? null : existing.rejectionReason }, include: { variants: true } });
    });
    if (status === 'review' && existing.status !== 'review') await notifyAdmins(m('Prodotto da moderare', 'Product to review'), `${salon.name}: ${p.name}`, '/admin/prodotti');
    res.json(sProduct(p));
  }),
);

sellerCatalogRouter.delete(
  '/products/:id',
  requireSalon(),
  ah(async (req, res) => {
    const salon = res.locals.salon as Salon;
    own(await prisma.product.findFirst({ where: { id: req.params.id, deletedAt: null } }), salon, 'Prodotto');
    await prisma.product.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
    res.json({ ok: true });
  }),
);

sellerCatalogRouter.patch(
  '/products/:id/stock',
  requireSalon(),
  body(z.object({ stock: z.number().int().min(0).max(100000) })),
  ah(async (req, res) => {
    const salon = res.locals.salon as Salon;
    own(await prisma.product.findFirst({ where: { id: req.params.id, deletedAt: null } }), salon, 'Prodotto');
    res.json(sProduct(await prisma.product.update({ where: { id: req.params.id }, data: { stock: req.body.stock }, include: { variants: true } })));
  }),
);

// ── staff ──
const staffSchema = z.object({
  name: z.string().trim().min(2).max(80), role: z.string().trim().max(60).default(''), photo: z.string().max(2000).default(''), bio: z.string().max(1000).default(''),
  serviceIds: z.array(z.string()).max(200).default([]), workingDays: z.array(z.number().int().min(0).max(6)).max(7).default([1, 2, 3, 4, 5]), active: z.boolean().default(true),
});
sellerCatalogRouter.get('/staff', requireSalon(), ah(async (_req, res) => res.json((await prisma.staff.findMany({ where: { salonId: (res.locals.salon as Salon).id } })).map(sStaff))));
/** keep only ids of this salon's services (protects against stale/foreign ids sent by an app) */
async function cleanServiceIds(salonId: string, ids?: string[]) {
  if (!ids) return undefined;
  const valid = await prisma.service.findMany({ where: { salonId, id: { in: ids }, deletedAt: null }, select: { id: true } });
  return valid.map((v) => v.id);
}
sellerCatalogRouter.post(
  '/staff',
  requireSalon(),
  body(staffSchema),
  ah(async (req, res) => {
    const salonId = (res.locals.salon as Salon).id;
    res.status(201).json(sStaff(await prisma.staff.create({ data: { ...req.body, serviceIds: await cleanServiceIds(salonId, req.body.serviceIds), salonId } })));
  }),
);
sellerCatalogRouter.put(
  '/staff/:id',
  requireSalon(),
  body(staffSchema.partial()),
  ah(async (req, res) => {
    own(await prisma.staff.findUnique({ where: { id: req.params.id } }), res.locals.salon as Salon, 'Collaboratore');
    const serviceIds = await cleanServiceIds((res.locals.salon as Salon).id, req.body.serviceIds);
    res.json(sStaff(await prisma.staff.update({ where: { id: req.params.id }, data: { ...req.body, ...(serviceIds ? { serviceIds } : {}) } })));
  }),
);
sellerCatalogRouter.delete(
  '/staff/:id',
  requireSalon(),
  ah(async (req, res) => {
    own(await prisma.staff.findUnique({ where: { id: req.params.id } }), res.locals.salon as Salon, 'Collaboratore');
    const future = await prisma.booking.count({ where: { staffId: req.params.id, status: { in: ['booked', 'confirmed', 'awaiting_payment'] }, date: { gte: new Date().toISOString().slice(0, 10) } } });
    if (future) throw conflict(`Ha ${future} appuntamenti futuri: spostali o disattiva il collaboratore`, 'staff_has_bookings');
    await prisma.staff.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  }),
);

// ── coupons (salon-funded) ──
const couponSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,20}$/, 'Solo lettere, numeri, - e _ (3–20)'),
  type: z.enum(['percent', 'fixed']), value: z.number().positive().max(1000), minSpend: z.number().min(0).max(10000).default(0),
  maxUses: z.number().int().min(1).max(100000).default(100), active: z.boolean().default(true), expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
const couponData = (b: Partial<z.infer<typeof couponSchema>>) => {
  const { value, minSpend, ...rest } = b;
  if (b.type === 'percent' && value !== undefined && value > 90) throw badRequest('Sconto massimo 90%');
  return { ...rest, ...(value !== undefined ? { value: b.type === 'fixed' ? toCents(value) : Math.round(value) } : {}), ...(minSpend !== undefined ? { minSpendCents: toCents(minSpend) } : {}) };
};
sellerCatalogRouter.get('/coupons', requireSalon(), ah(async (_req, res) => res.json((await prisma.coupon.findMany({ where: { scope: (res.locals.salon as Salon).id }, orderBy: { createdAt: 'desc' } })).map(sCoupon))));
sellerCatalogRouter.post('/coupons', requireSalon({ approved: true }), body(couponSchema), ah(async (req, res) => res.status(201).json(sCoupon(await prisma.coupon.create({ data: { ...(couponData(req.body) as z.infer<typeof couponSchema> & { value: number }), scope: (res.locals.salon as Salon).id } as never })))));
sellerCatalogRouter.put(
  '/coupons/:id',
  requireSalon({ approved: true }),
  body(couponSchema.partial()),
  ah(async (req, res) => {
    const c = await prisma.coupon.findUnique({ where: { id: req.params.id } });
    if (!c || c.scope !== (res.locals.salon as Salon).id) throw notFound('Codice');
    res.json(sCoupon(await prisma.coupon.update({ where: { id: c.id }, data: couponData({ type: c.type as 'percent' | 'fixed', ...req.body }) })));
  }),
);
