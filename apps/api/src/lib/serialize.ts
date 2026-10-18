/**
 * DB row → JSON shape the web/mobile apps already use (packages/shared/src/types.ts).
 * Money: cents → euros. Commission: bps → rate. Dates: ISO strings.
 */
import type {
  TimeWindow,
  Address, Banner, Booking, Coupon, LedgerEntry, Notification, Order, Product, ProductVariant, Review, Salon,
  SellerApplication, ApplicationDocument, Service, Staff, SubOrder, SupportTicket, User, Withdrawal, Payment,
} from '@prisma/client';
import { bpsToRate, toEuro } from './money';
import { toHHMM } from './time';

const arr = <T = string>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);

export const sUser = (u: User & { addresses?: Address[]; salon?: { id: string } | null }) => ({
  id: u.id,
  role: u.role,
  name: u.name,
  email: u.email,
  phone: u.phone,
  avatar: u.avatar ?? undefined,
  city: u.city ?? undefined,
  createdAt: u.createdAt.toISOString(),
  blocked: u.blocked,
  loyaltyPoints: u.loyaltyPoints,
  lang: u.lang,
  addresses: (u.addresses ?? []).map(sAddress),
  salonId: u.salon?.id,
});

export const sAddress = (a: Address) => ({
  id: a.id, label: a.label, name: a.name, street: a.street, city: a.city, zip: a.zip, province: a.province, phone: a.phone, isDefault: a.isDefault,
});

export const sSalon = (s: Salon) => {
  const pol = (s.policies ?? {}) as Record<string, unknown>;
  return {
    id: s.id,
    slug: s.slug,
    ownerId: s.ownerId,
    name: s.name,
    tagline: s.tagline,
    description: s.description,
    category: s.category,
    city: s.city,
    address: s.address,
    zip: s.zip,
    lat: s.lat,
    lng: s.lng,
    phone: s.phone,
    email: s.email,
    cover: s.cover,
    logo: s.logo ?? undefined,
    gallery: arr(s.gallery),
    hours: arr(s.hours),
    rating: s.rating,
    reviewCount: s.reviewCount,
    status: s.status,
    commissionRate: bpsToRate(s.commissionBps),
    featured: s.featured,
    verified: s.verified,
    priceLevel: s.priceLevel as 1 | 2 | 3,
    amenities: arr(s.amenities),
    policies: {
      cancellation: String(pol.cancellation ?? ''),
      noShow: String(pol.noShow ?? ''),
      shippingZones: String(pol.shippingZones ?? ''),
      shippingFee: Number(pol.shippingFee ?? 0),
      freeShippingOver: Number(pol.freeShippingOver ?? 0),
    },
    createdAt: s.createdAt.toISOString(),
    stripePayoutsReady: s.stripePayoutsReady,
  };
};

/** Public salon: hide commission + Stripe internals */
export const sSalonPublic = (s: Salon) => {
  const { commissionRate: _c, stripePayoutsReady: _p, ...rest } = sSalon(s);
  return rest;
};

export const sApplication = (a: SellerApplication & { documents?: ApplicationDocument[] }) => ({
  id: a.id,
  salonId: a.salonId,
  ownerId: a.ownerId,
  ragioneSociale: a.ragioneSociale,
  pIva: a.pIva,
  codiceFiscale: a.codiceFiscale,
  sdi: a.sdi,
  pec: a.pec,
  legalAddress: a.legalAddress,
  iban: a.iban,
  accountHolder: a.accountHolder,
  documents: (a.documents ?? []).map((d) => ({ id: d.id, type: d.type, name: d.name, uploadedAt: d.uploadedAt.toISOString() })),
  status: a.status,
  submittedAt: iso(a.submittedAt),
  reviewedAt: iso(a.reviewedAt),
  rejectionReason: a.rejectionReason ?? undefined,
  adminNotes: a.adminNotes ?? undefined,
  checklist: (a.checklist ?? { docs: false, vat: false, iban: false, photos: false }) as { docs: boolean; vat: boolean; iban: boolean; photos: boolean },
});

export const sStaff = (s: Staff) => ({
  id: s.id, salonId: s.salonId, name: s.name, role: s.role, photo: s.photo, bio: s.bio,
  serviceIds: arr(s.serviceIds), workingDays: arr<number>(s.workingDays), active: s.active,
});

export const sService = (s: Service) => {
  const images = arr(s.images);
  return {
    id: s.id, salonId: s.salonId, category: s.category, name: s.name, description: s.description,
    image: images[0] ?? '', images, durationMin: s.durationMin, price: toEuro(s.priceCents),
    bufferMin: s.bufferMin, depositPct: s.depositPct, active: s.active, popular: s.popular,
  };
};

export const sVariant = (v: ProductVariant) => ({ id: v.id, label: v.label, priceDelta: toEuro(v.priceDeltaCents), stock: v.stock });

export const sProduct = (p: Product & { variants?: ProductVariant[] }) => ({
  id: p.id, salonId: p.salonId, brand: p.brand, category: p.category, name: p.name, short: p.short,
  description: p.description, images: arr(p.images), price: toEuro(p.priceCents),
  compareAtPrice: p.compareAtCents != null ? toEuro(p.compareAtCents) : undefined, stock: p.stock, sku: p.sku,
  variants: (p.variants ?? []).map(sVariant), inci: p.inci, howToUse: p.howToUse, rating: p.rating,
  reviewCount: p.reviewCount, status: p.status, rejectionReason: p.rejectionReason ?? undefined, weightGr: p.weightGr,
  isNew: p.isNew, createdAt: p.createdAt.toISOString(), sold: p.sold,
});

export const sBooking = (b: Booking) => ({
  id: b.id, code: b.code, customerId: b.customerId ?? '', customerName: b.customerName, customerPhone: b.customerPhone,
  salonId: b.salonId, staffId: b.staffId, serviceIds: arr(b.serviceIds), date: b.date, time: toHHMM(b.startMin),
  durationMin: b.durationMin, total: toEuro(b.totalCents), deposit: toEuro(b.depositCents), paid: toEuro(b.paidCents),
  paymentMode: b.paymentMode, status: b.status, notes: b.notes ?? undefined,
  pickupProductIds: b.pickupProductIds ? arr(b.pickupProductIds) : undefined, createdAt: b.createdAt.toISOString(),
  reviewed: b.reviewed, holdExpiresAt: iso(b.holdExpiresAt), windowId: b.windowId ?? null,
});

/** booked = places taken (bookings that still hold a place) */
export const sWindow = (w: TimeWindow, booked: number) => ({
  id: w.id, salonId: w.salonId, date: w.date, start: toHHMM(w.startMin), end: toHHMM(w.endMin), serviceIds: arr(w.serviceIds),
  capacity: w.capacity, staffId: w.staffId, note: w.note || undefined, open: w.open, booked,
});

export const sSubOrder = (s: SubOrder) => ({
  id: s.id, code: s.code, orderId: s.orderId, salonId: s.salonId, items: arr(s.items), shippingMethod: s.shippingMethod,
  shippingFee: toEuro(s.shippingFeeCents), subtotal: toEuro(s.subtotalCents), salonDiscount: toEuro(s.salonDiscountCents), platformDiscount: toEuro(s.platformDiscountCents),
  status: s.status, trackingNo: s.trackingNo ?? undefined, carrier: s.carrier ?? undefined, timeline: arr(s.timeline),
  returnRequested: s.returnRequested, returnReason: s.returnReason ?? undefined, deliveredAt: iso(s.deliveredAt),
});

export const sOrder = (o: Order & { subOrders?: SubOrder[] }) => ({
  id: o.id, code: o.code, customerId: o.customerId, customerName: o.customerName, createdAt: o.createdAt.toISOString(),
  address: (o.address ?? undefined) as unknown, paymentMethod: o.paymentMethod, couponCode: o.couponCode ?? undefined,
  discount: toEuro(o.discountCents), total: toEuro(o.totalCents), status: o.status,
  subOrderIds: (o.subOrders ?? []).map((s) => s.id), subOrders: o.subOrders?.map(sSubOrder),
});

export const sReview = (r: Review) => ({
  id: r.id, customerId: r.customerId, customerName: r.customerName, customerAvatar: r.customerAvatar ?? undefined,
  salonId: r.salonId, productId: r.productId ?? undefined, bookingId: r.bookingId ?? undefined, rating: r.rating,
  text: r.text, createdAt: r.createdAt.toISOString(), reply: r.reply ?? undefined, hidden: r.hidden, reported: r.reported,
});

export const sCoupon = (c: Coupon) => ({
  id: c.id, code: c.code, type: c.type as 'percent' | 'fixed', value: c.type === 'fixed' ? toEuro(c.value) : c.value,
  scope: c.scope, minSpend: toEuro(c.minSpendCents), uses: c.uses, maxUses: c.maxUses, active: c.active, expiresAt: c.expiresAt,
});

export const sNotification = (n: Notification) => ({
  id: n.id, userId: n.userId, title: n.title, body: n.body, at: n.at.toISOString(), read: n.read, link: n.link ?? undefined,
});

export const sBanner = (b: Banner) => ({ id: b.id, title: b.title, subtitle: b.subtitle, image: b.image, cta: b.cta, link: b.link, active: b.active });

export const sTicket = (t: SupportTicket) => ({ id: t.id, from: t.from, subject: t.subject, message: t.message, status: t.status as 'open' | 'closed', at: t.at.toISOString() });

export const sLedger = (e: LedgerEntry) => ({
  id: e.id, type: e.type, amount: toEuro(e.amountCents), commissionRate: bpsToRate(e.commissionBps), commission: toEuro(e.commissionCents),
  net: toEuro(e.amountCents - e.commissionCents), sourceType: e.sourceType, sourceId: e.sourceId, description: e.description,
  status: e.status, availableAt: iso(e.availableAt), withdrawalId: e.withdrawalId ?? undefined, createdAt: e.createdAt.toISOString(),
});

export const sWithdrawal = (w: Withdrawal) => ({
  id: w.id, salonId: w.salonId, gross: toEuro(w.grossCents), commission: toEuro(w.commissionCents), net: toEuro(w.netCents),
  status: w.status, auto: w.auto, stripeTransferId: w.stripeTransferId ?? undefined, failureReason: w.failureReason ?? undefined,
  requestedAt: w.requestedAt.toISOString(), decidedAt: iso(w.decidedAt), paidAt: iso(w.paidAt),
});

export const sPayment = (p: Payment) => ({
  id: p.id, provider: p.provider, providerPaymentId: p.providerPaymentId, kind: p.kind, bookingId: p.bookingId ?? undefined,
  orderId: p.orderId ?? undefined, amount: toEuro(p.amountCents), refunded: toEuro(p.refundedCents), status: p.status, createdAt: p.createdAt.toISOString(),
});
