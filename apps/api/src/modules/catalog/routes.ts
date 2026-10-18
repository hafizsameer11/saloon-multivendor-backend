/** Public catalog: anyone (guests too) can browse approved salons and published products. */
import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, badRequest, notFound } from '../../lib/errors';
import { sBanner, sProduct, sReview, sSalonPublic, sService, sStaff, sWindow } from '../../lib/serialize';
import { placesTaken } from '../bookings/windows';
import { query, q } from '../../middleware/validate';
import { addDays, isISODate, toHHMM, toISODate } from '../../lib/time';
import { loadAvailability } from '../bookings/availability';

export const catalogRouter = Router();

const salonList = z.object({
  q: z.string().trim().max(80).optional(),
  city: z.string().trim().max(60).optional(),
  category: z.enum(['parrucchiere', 'barber', 'unghie', 'estetica', 'spa']).optional(),
  featured: z.enum(['true', 'false']).optional(),
  priceLevel: z.coerce.number().int().min(1).max(3).optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  sort: z.enum(['rating', 'reviews', 'newest', 'name']).default('rating'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
});

catalogRouter.get(
  '/salons',
  query(salonList),
  ah(async (_req, res) => {
    const f = q(res, salonList);
    const where: Prisma.SalonWhereInput = {
      status: 'approved',
      services: { some: { active: true, deletedAt: null } },
      ...(f.city ? { city: f.city } : {}),
      ...(f.category ? { category: f.category } : {}),
      ...(f.featured ? { featured: f.featured === 'true' } : {}),
      ...(f.priceLevel ? { priceLevel: f.priceLevel } : {}),
      ...(f.minRating ? { rating: { gte: f.minRating } } : {}),
      ...(f.q ? { OR: [{ name: { contains: f.q } }, { tagline: { contains: f.q } }, { city: { contains: f.q } }, { services: { some: { name: { contains: f.q }, active: true } } }] } : {}),
    };
    const orderBy: Prisma.SalonOrderByWithRelationInput =
      f.sort === 'reviews' ? { reviewCount: 'desc' } : f.sort === 'newest' ? { createdAt: 'desc' } : f.sort === 'name' ? { name: 'asc' } : { rating: 'desc' };
    const [total, rows] = await Promise.all([
      prisma.salon.count({ where }),
      prisma.salon.findMany({ where, orderBy, skip: (f.page - 1) * f.pageSize, take: f.pageSize, include: { services: { where: { active: true, deletedAt: null }, select: { priceCents: true } } } }),
    ]);
    res.json({
      total, page: f.page, pageSize: f.pageSize,
      items: rows.map((s) => ({ ...sSalonPublic(s), fromPrice: s.services.length ? Math.min(...s.services.map((x) => x.priceCents)) / 100 : null })),
    });
  }),
);

catalogRouter.get(
  '/salons/:slug',
  ah(async (req, res) => {
    const salon = await prisma.salon.findFirst({ where: { OR: [{ slug: req.params.slug }, { id: req.params.slug }], status: 'approved' } });
    if (!salon) throw notFound('Salone');
    const [services, staff, products, reviews, windows] = await Promise.all([
      prisma.service.findMany({ where: { salonId: salon.id, active: true, deletedAt: null }, orderBy: [{ category: 'asc' }, { priceCents: 'asc' }] }),
      prisma.staff.findMany({ where: { salonId: salon.id, active: true } }),
      prisma.product.findMany({ where: { salonId: salon.id, status: 'published', deletedAt: null }, include: { variants: true } }),
      prisma.review.findMany({ where: { salonId: salon.id, hidden: false }, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.timeWindow.findMany({ where: { salonId: salon.id, open: true, date: { gte: toISODate(new Date()), lte: toISODate(addDays(new Date(), 90)) } }, orderBy: [{ date: 'asc' }, { startMin: 'asc' }] }),
    ]);
    const taken = await placesTaken(prisma, windows.map((w) => w.id));
    res.json({
      salon: sSalonPublic(salon), services: services.map(sService), staff: staff.map(sStaff), products: products.map(sProduct), reviews: reviews.map(sReview),
      windows: windows.filter((w) => (taken.get(w.id) ?? 0) < w.capacity).map((w) => sWindow(w, taken.get(w.id) ?? 0)),
    });
  }),
);

const availQuery = z.object({
  date: z.string().refine(isISODate, 'Data non valida (AAAA-MM-GG)'),
  serviceIds: z.string().min(1).transform((s) => s.split(',').filter(Boolean)),
  staffId: z.string().optional(),
});

catalogRouter.get(
  '/salons/:id/availability',
  query(availQuery),
  ah(async (req, res) => {
    const f = q(res, availQuery);
    const salon = await prisma.salon.findFirst({ where: { id: req.params.id, status: 'approved' } });
    if (!salon) throw notFound('Salone');
    const { services, slots } = await loadAvailability(prisma, salon.id, f.date, f.serviceIds, f.staffId);
    if (services.length !== new Set(f.serviceIds).size) throw badRequest('Uno o più servizi non disponibili', 'service_unavailable');
    res.json({ date: f.date, durationMin: services.reduce((a, s) => a + s.durationMin, 0), slots });
  }),
);

/** Next N days with at least one free slot (for the date strip). */
catalogRouter.get(
  '/salons/:id/availability/days',
  query(z.object({ serviceIds: z.string().min(1).transform((s) => s.split(',')), staffId: z.string().optional(), from: z.string().optional(), days: z.coerce.number().int().min(1).max(31).default(14) })),
  ah(async (req, res) => {
    const f = res.locals.query as { serviceIds: string[]; staffId?: string; from?: string; days: number };
    const start = f.from && isISODate(f.from) ? new Date(f.from) : new Date();
    const out: { date: string; free: number }[] = [];
    for (let i = 0; i < f.days; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const date = toISODate(d);
      const { slots } = await loadAvailability(prisma, req.params.id, date, f.serviceIds, f.staffId);
      out.push({ date, free: slots.filter((s) => s.free).length });
    }
    res.json(out);
  }),
);

const productList = z.object({
  q: z.string().trim().max(80).optional(),
  category: z.enum(['capelli', 'unghie', 'viso', 'corpo', 'barba', 'strumenti']).optional(),
  brand: z.string().max(60).optional(),
  salonId: z.string().optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  inStock: z.enum(['true', 'false']).optional(),
  sort: z.enum(['popular', 'newest', 'price_asc', 'price_desc', 'rating']).default('popular'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
});

catalogRouter.get(
  '/products',
  query(productList),
  ah(async (_req, res) => {
    const f = q(res, productList);
    const where: Prisma.ProductWhereInput = {
      status: 'published', deletedAt: null, salon: { status: 'approved' },
      ...(f.category ? { category: f.category } : {}),
      ...(f.brand ? { brand: f.brand } : {}),
      ...(f.salonId ? { salonId: f.salonId } : {}),
      ...(f.inStock === 'true' ? { stock: { gt: 0 } } : {}),
      ...(f.minPrice != null || f.maxPrice != null ? { priceCents: { ...(f.minPrice != null ? { gte: Math.round(f.minPrice * 100) } : {}), ...(f.maxPrice != null ? { lte: Math.round(f.maxPrice * 100) } : {}) } } : {}),
      ...(f.q ? { OR: [{ name: { contains: f.q } }, { brand: { contains: f.q } }, { short: { contains: f.q } }] } : {}),
    };
    const orderBy: Prisma.ProductOrderByWithRelationInput =
      f.sort === 'newest' ? { createdAt: 'desc' } : f.sort === 'price_asc' ? { priceCents: 'asc' } : f.sort === 'price_desc' ? { priceCents: 'desc' } : f.sort === 'rating' ? { rating: 'desc' } : { sold: 'desc' };
    const [total, rows] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({ where, orderBy, skip: (f.page - 1) * f.pageSize, take: f.pageSize, include: { variants: true, salon: { select: { id: true, name: true, slug: true, city: true } } } }),
    ]);
    res.json({ total, page: f.page, pageSize: f.pageSize, items: rows.map((p) => ({ ...sProduct(p), salon: p.salon })) });
  }),
);

catalogRouter.get(
  '/products/:id',
  ah(async (req, res) => {
    const p = await prisma.product.findFirst({ where: { id: req.params.id, status: 'published', deletedAt: null, salon: { status: 'approved' } }, include: { variants: true, salon: true } });
    if (!p) throw notFound('Prodotto');
    const [reviews, related] = await Promise.all([
      prisma.review.findMany({ where: { productId: p.id, hidden: false }, orderBy: { createdAt: 'desc' }, take: 30 }),
      prisma.product.findMany({ where: { category: p.category, status: 'published', deletedAt: null, id: { not: p.id } }, take: 8, orderBy: { sold: 'desc' }, include: { variants: true } }),
    ]);
    res.json({ product: sProduct(p), salon: sSalonPublic(p.salon), reviews: reviews.map(sReview), related: related.map(sProduct) });
  }),
);

catalogRouter.get(
  '/banners',
  ah(async (_req, res) => res.json((await prisma.banner.findMany({ where: { active: true }, orderBy: { sort: 'asc' } })).map(sBanner))),
);

catalogRouter.get(
  '/categories',
  ah(async (_req, res) => {
    const [salons, products] = await Promise.all([
      prisma.salon.groupBy({ by: ['category'], where: { status: 'approved' }, _count: true }),
      prisma.product.groupBy({ by: ['category'], where: { status: 'published', deletedAt: null }, _count: true }),
    ]);
    res.json({ salons: salons.map((s) => ({ id: s.category, count: s._count })), products: products.map((p) => ({ id: p.category, count: p._count })) });
  }),
);

catalogRouter.get(
  '/cities',
  ah(async (_req, res) => {
    const rows = await prisma.salon.groupBy({ by: ['city'], where: { status: 'approved' }, _count: true, orderBy: { city: 'asc' } });
    res.json(rows.map((r) => ({ city: r.city, count: r._count })));
  }),
);

/**
 * Whole public catalog in ONE call (apps load it at start-up): approved salons, their active services and staff,
 * published products, visible reviews, banners, and anonymous "busy" blocks for the next 90 days so the apps can
 * show availability with the shared engine. Fine for a regional marketplace (hundreds of salons); past a few
 * thousand products switch the apps to the paginated /salons and /products endpoints.
 */
catalogRouter.get(
  '/catalog',
  ah(async (_req, res) => {
    const today = toISODate(new Date());
    const until = toISODate(addDays(new Date(), 90));
    // approved salons with at least one active service (an empty salon page helps nobody)
    const salons = await prisma.salon.findMany({ where: { status: 'approved', services: { some: { active: true, deletedAt: null } } } });
    const ids = salons.map((s) => s.id);
    const [services, staff, products, reviews, banners, busy, windows] = await Promise.all([
      prisma.service.findMany({ where: { salonId: { in: ids }, active: true, deletedAt: null } }),
      prisma.staff.findMany({ where: { salonId: { in: ids }, active: true } }),
      prisma.product.findMany({ where: { salonId: { in: ids }, status: 'published', deletedAt: null }, include: { variants: true } }),
      prisma.review.findMany({ where: { salonId: { in: ids }, hidden: false }, orderBy: { createdAt: 'desc' }, take: 2000 }),
      prisma.banner.findMany({ where: { active: true }, orderBy: { sort: 'asc' } }),
      prisma.booking.findMany({
        where: { salonId: { in: ids }, date: { gte: today, lte: until }, status: { notIn: ['cancelled', 'no_show'] } },
        select: { id: true, salonId: true, staffId: true, date: true, startMin: true, durationMin: true, status: true, holdExpiresAt: true, windowId: true },
      }),
      prisma.timeWindow.findMany({ where: { salonId: { in: ids }, date: { gte: today, lte: until } }, orderBy: [{ date: 'asc' }, { startMin: 'asc' }] }),
    ]);
    const taken = await placesTaken(prisma, windows.map((w) => w.id));
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      at: new Date().toISOString(),
      salons: salons.map(sSalonPublic),
      services: services.map(sService),
      staff: staff.map(sStaff),
      products: products.map(sProduct),
      reviews: reviews.map(sReview),
      banners: banners.map(sBanner),
      // normal capacity in use: window bookings never count; a window tied to a staff member blocks that person
      busy: [
        ...busy
          .filter((b) => !b.windowId && !(b.status === 'awaiting_payment' && b.holdExpiresAt && b.holdExpiresAt < new Date()))
          .map((b) => ({ id: b.id, salonId: b.salonId, staffId: b.staffId, date: b.date, time: toHHMM(b.startMin), durationMin: b.durationMin, status: b.status })),
        ...windows
          .filter((w) => w.staffId)
          .map((w) => ({ id: `win-${w.id}`, salonId: w.salonId, staffId: w.staffId, date: w.date, time: toHHMM(w.startMin), durationMin: w.endMin - w.startMin, status: 'booked' })),
      ],
      // bookable windows only (open, places left); seller sees all of theirs via /seller/windows
      windows: windows.filter((w) => w.open && (taken.get(w.id) ?? 0) < w.capacity).map((w) => sWindow(w, taken.get(w.id) ?? 0)),
    });
  }),
);

catalogRouter.get('/time', (_req, res) => res.json({ now: new Date().toISOString(), today: toISODate(new Date()), tz: process.env.TZ }));
