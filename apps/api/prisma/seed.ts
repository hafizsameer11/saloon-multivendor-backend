/**
 * Seeds MySQL with the same demo world the web/mobile prototypes use (packages/shared/src/mock/seed.ts),
 * plus wallet history (ledger + paid withdrawals) built from past bookings and delivered orders.
 *
 *   npm run seed           → wipes and reloads all demo data
 * All demo accounts use the password:  demo1234
 */
import { PrismaClient, type LedgerStatus, type Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { createSeed } from '../../../packages/shared/src/mock/seed';

process.env.TZ = 'Europe/Rome'; // salon local time, regardless of the machine's zone
const prisma = new PrismaClient();
const cents = (e: number) => Math.round(e * 100);
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const DEMO_PASSWORD = 'demo1234';

async function wipe() {
  // child → parent order
  await prisma.$transaction([
    prisma.ledgerEntry.deleteMany(), prisma.withdrawal.deleteMany(), prisma.payment.deleteMany(), prisma.stripeEvent.deleteMany(),
    prisma.auditLog.deleteMany(), prisma.notification.deleteMany(), prisma.review.deleteMany(), prisma.subOrder.deleteMany(),
    prisma.order.deleteMany(), prisma.booking.deleteMany(), prisma.timeWindow.deleteMany(), prisma.productVariant.deleteMany(), prisma.product.deleteMany(),
    prisma.service.deleteMany(), prisma.staff.deleteMany(), prisma.applicationDocument.deleteMany(), prisma.sellerApplication.deleteMany(),
    prisma.salon.deleteMany(), prisma.favourite.deleteMany(), prisma.address.deleteMany(), prisma.refreshToken.deleteMany(),
    prisma.passwordReset.deleteMany(), prisma.supportTicket.deleteMany(), prisma.user.deleteMany(), prisma.coupon.deleteMany(),
    prisma.banner.deleteMany(), prisma.platformSetting.deleteMany(),
  ]);
}

export async function seed() {
  // Safety: the seed DELETES all rows. Never run it against production by accident.
  if (process.env.NODE_ENV === 'production' && !process.argv.includes('--i-know-this-wipes-production')) {
    throw new Error('Refusing to seed: NODE_ENV=production. The seed deletes all data.');
  }
  const db = createSeed(new Date());
  await wipe();
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);

  await prisma.user.createMany({
    data: db.users.map((u) => ({
      id: u.id, role: u.role, name: u.name, email: u.email.toLowerCase(), phone: u.phone, passwordHash: hash, avatar: u.avatar,
      city: u.city, blocked: !!u.blocked, loyaltyPoints: u.loyaltyPoints ?? 0, createdAt: new Date(u.createdAt),
    })),
  });
  await prisma.address.createMany({
    data: db.users.flatMap((u) => u.addresses.map((a) => ({ ...a, id: `${u.id}-${a.id}`, userId: u.id, isDefault: !!a.isDefault }))),
  });

  await prisma.salon.createMany({
    data: db.salons.map((s) => ({
      id: s.id, slug: s.slug, ownerId: s.ownerId, name: s.name, tagline: s.tagline, description: s.description, category: s.category,
      city: s.city, address: s.address, zip: s.zip, lat: s.lat, lng: s.lng, phone: s.phone, email: s.email, cover: s.cover, logo: s.logo,
      gallery: s.gallery, hours: s.hours as unknown as Prisma.InputJsonValue, amenities: s.amenities, policies: s.policies,
      rating: s.rating, reviewCount: s.reviewCount, status: s.status, commissionBps: Math.round(s.commissionRate * 10000),
      featured: !!s.featured, verified: !!s.verified, priceLevel: s.priceLevel, createdAt: new Date(s.createdAt),
      // demo: the flagship salon has a (mock) Stripe Connect account ready for withdrawals
      stripeAccountId: s.id === 's1' ? 'acct_mock_s1' : null, stripePayoutsReady: s.id === 's1',
    })),
  });

  for (const a of db.applications) {
    await prisma.sellerApplication.create({
      data: {
        id: a.id, salonId: a.salonId, ownerId: a.ownerId, ragioneSociale: a.ragioneSociale, pIva: a.pIva, codiceFiscale: a.codiceFiscale,
        sdi: a.sdi, pec: a.pec, legalAddress: a.legalAddress, iban: a.iban, accountHolder: a.accountHolder, status: a.status,
        submittedAt: a.submittedAt ? new Date(a.submittedAt) : null, reviewedAt: a.reviewedAt ? new Date(a.reviewedAt) : null,
        rejectionReason: a.rejectionReason, adminNotes: a.adminNotes, checklist: a.checklist,
        documents: { create: a.documents.map((d) => ({ id: d.id, type: d.type, name: d.name, fileKey: `demo/${d.name}`, uploadedAt: new Date(d.uploadedAt) })) },
      },
    });
  }

  await prisma.staff.createMany({ data: db.staff.map((s) => ({ ...s })) });
  await prisma.service.createMany({
    data: db.services.map((s) => ({
      id: s.id, salonId: s.salonId, category: s.category, name: s.name, description: s.description, images: s.images,
      durationMin: s.durationMin, priceCents: cents(s.price), bufferMin: s.bufferMin, depositPct: s.depositPct, active: s.active, popular: !!s.popular,
    })),
  });
  for (const p of db.products) {
    await prisma.product.create({
      data: {
        id: p.id, salonId: p.salonId, brand: p.brand, category: p.category, name: p.name, short: p.short, description: p.description,
        images: p.images, priceCents: cents(p.price), compareAtCents: p.compareAtPrice ? cents(p.compareAtPrice) : null, stock: p.stock,
        sku: p.sku, inci: p.inci, howToUse: p.howToUse, rating: p.rating, reviewCount: p.reviewCount, status: p.status,
        rejectionReason: p.rejectionReason, weightGr: p.weightGr, isNew: !!p.isNew, sold: p.sold, createdAt: new Date(p.createdAt),
        variants: { create: p.variants.map((v) => ({ id: `${p.id}-${v.id}`, label: v.label, priceDeltaCents: cents(v.priceDelta), stock: v.stock })) },
      },
    });
  }

  const salonById = new Map(db.salons.map((s) => [s.id, s]));
  const ledger: Prisma.LedgerEntryCreateManyInput[] = [];
  const now = new Date();

  // salon time windows (before bookings: some bookings sit inside a window)
  await prisma.timeWindow.createMany({
    data: db.windows.map((w) => ({ id: w.id, salonId: w.salonId, date: w.date, startMin: toMin(w.start), endMin: toMin(w.end), serviceIds: w.serviceIds, capacity: w.capacity, staffId: w.staffId, note: w.note ?? '', open: w.open })),
  });

  // bookings (+ online deposit payments, ledger lines for finished ones)
  await prisma.booking.createMany({
    data: db.bookings.map((b) => {
      const total = cents(b.total);
      const deposit = b.paymentMode === 'deposit' ? Math.round(total * 0.2) : b.paymentMode === 'card' ? total : 0;
      const paid = b.status === 'cancelled' ? 0 : deposit;
      if (['completed', 'no_show'].includes(b.status)) {
        const bps = Math.round(salonById.get(b.salonId)!.commissionRate * 10000);
        const at = new Date(`${b.date}T20:00:00`);
        if (paid > 0) ledger.push({ salonId: b.salonId, type: 'sale', amountCents: paid, commissionBps: bps, commissionCents: Math.round((paid * bps) / 10000), sourceType: 'booking', sourceId: b.id, description: `Prenotazione ${b.code} (online)`, createdAt: at, availableAt: new Date(at.getTime() + 48 * 3600_000) });
        if (b.status === 'completed' && total - paid > 0) ledger.push({ salonId: b.salonId, type: 'cash_commission', amountCents: 0, commissionBps: bps, commissionCents: Math.round(((total - paid) * bps) / 10000), sourceType: 'booking', sourceId: b.id, description: `Prenotazione ${b.code} (pagata in salone)`, createdAt: at, availableAt: new Date(at.getTime() + 48 * 3600_000) });
      }
      return {
        id: b.id, code: b.code, customerId: b.customerId || null, customerName: b.customerName, customerPhone: b.customerPhone,
        salonId: b.salonId, staffId: b.staffId, serviceIds: b.serviceIds, date: b.date, startMin: toMin(b.time), durationMin: b.durationMin,
        totalCents: total, depositCents: deposit, paidCents: paid, paymentMode: b.paymentMode, status: b.status, notes: b.notes,
        pickupProductIds: b.pickupProductIds, reviewed: !!b.reviewed, createdAt: new Date(b.createdAt), windowId: b.windowId ?? null,
      };
    }),
  });

  // orders + sub-orders
  for (const o of db.orders) {
    const subs = db.subOrders.filter((s) => s.orderId === o.id);
    await prisma.order.create({
      data: {
        id: o.id, code: o.code, customerId: o.customerId, customerName: o.customerName, address: (o.address ?? undefined) as Prisma.InputJsonValue | undefined,
        paymentMethod: o.paymentMethod, discountCents: cents(o.discount), totalCents: cents(o.total), status: 'paid', createdAt: new Date(o.createdAt),
        subOrders: {
          create: subs.map((s) => {
            const delivered = s.timeline.find((t) => t.status === 'delivered')?.at;
            const gross = cents(s.subtotal + s.shippingFee);
            const bps = Math.round(salonById.get(s.salonId)!.commissionRate * 10000);
            if (!['cancelled', 'refunded'].includes(s.status)) {
              ledger.push({ salonId: s.salonId, type: 'sale', amountCents: gross, commissionBps: bps, commissionCents: Math.round((gross * bps) / 10000), sourceType: 'sub_order', sourceId: s.id, description: `Ordine ${s.code}`, createdAt: new Date(o.createdAt), availableAt: delivered ? new Date(new Date(delivered).getTime() + 14 * 86400_000) : null });
            }
            return {
              id: s.id, code: s.code, salonId: s.salonId, items: s.items as unknown as Prisma.InputJsonValue, shippingMethod: s.shippingMethod,
              shippingFeeCents: cents(s.shippingFee), subtotalCents: cents(s.subtotal), status: s.status, trackingNo: s.trackingNo, carrier: s.carrier,
              timeline: s.timeline, returnRequested: !!s.returnRequested, deliveredAt: delivered ? new Date(delivered) : null,
            };
          }),
        },
      },
    });
  }

  // ledger status: older than 30 days → included in monthly paid withdrawals (history); else available/pending
  const cutoff = new Date(now.getTime() - 30 * 86400_000);
  const byMonth = new Map<string, Prisma.LedgerEntryCreateManyInput[]>();
  for (const e of ledger) {
    const created = e.createdAt as Date;
    if (created > now) continue; // future bookings never have ledger lines
    const avail = e.availableAt as Date | null;
    let status: LedgerStatus = avail && avail <= now ? 'available' : 'pending';
    if (status === 'available' && created < cutoff) {
      status = 'withdrawn';
      const key = `${e.salonId}|${created.toISOString().slice(0, 7)}`;
      byMonth.set(key, [...(byMonth.get(key) ?? []), e]);
    }
    e.status = status;
  }
  for (const [key, entries] of byMonth) {
    const [salonId, month] = key.split('|');
    const gross = entries.reduce((a, e) => a + e.amountCents, 0);
    const comm = entries.reduce((a, e) => a + e.commissionCents, 0);
    if (gross - comm <= 0) {
      // mostly cash month: commission owed exceeds online money → nothing to pay out, lines stay open
      entries.forEach((e) => (e.status = 'available'));
      byMonth.delete(key);
      continue;
    }
    const paidAt = new Date(`${month}-28T10:00:00`);
    paidAt.setMonth(paidAt.getMonth() + 1);
    const w = await prisma.withdrawal.create({
      data: { salonId, grossCents: gross, commissionCents: comm, netCents: gross - comm, status: 'paid', stripeTransferId: `tr_seed_${salonId}_${month}`, requestedAt: paidAt, decidedAt: paidAt, paidAt },
    });
    entries.forEach((e) => (e.withdrawalId = w.id));
  }
  await prisma.ledgerEntry.createMany({ data: ledger.filter((e) => e.status) });

  await prisma.review.createMany({
    data: db.reviews.map((r) => ({
      id: r.id, customerId: r.customerId, customerName: r.customerName, customerAvatar: r.customerAvatar, salonId: r.salonId, productId: r.productId,
      bookingId: r.bookingId, rating: r.rating, text: r.text, reply: r.reply, hidden: !!r.hidden, reported: !!r.reported, createdAt: new Date(r.createdAt),
    })),
  });
  await prisma.coupon.createMany({
    data: db.coupons.map((c) => ({
      id: c.id, code: c.code, type: c.type, value: c.type === 'fixed' ? cents(c.value) : c.value, scope: c.scope, minSpendCents: cents(c.minSpend),
      uses: c.uses, maxUses: c.maxUses, active: c.active, expiresAt: c.expiresAt,
    })),
  });
  const userIds = new Set(db.users.map((u) => u.id));
  await prisma.notification.createMany({
    data: db.notifications.filter((n) => userIds.has(n.userId)).map((n) => ({ id: n.id, userId: n.userId, title: n.title, body: n.body, at: new Date(n.at), read: n.read, link: n.link })),
  });
  await prisma.banner.createMany({ data: db.banners.map((b, i) => ({ ...b, sort: i })) });
  await prisma.supportTicket.createMany({ data: db.tickets.map((t) => ({ id: t.id, from: t.from, subject: t.subject, status: t.status, at: new Date(t.at) })) });

  return {
    users: db.users.length, salons: db.salons.length, services: db.services.length, products: db.products.length,
    bookings: db.bookings.length, orders: db.orders.length, ledger: ledger.length, withdrawals: byMonth.size,
  };
}

if (require.main === module) {
  seed()
    .then((r) => {
      console.log('✅ Seed complete', r, `\n   Demo password for every account: ${DEMO_PASSWORD}`);
    })
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
