/**
 * End-to-end API suite (real MySQL test DB, mock Stripe).
 * Covers: auth, catalog, seller onboarding + approval, booking + payment + double-booking race,
 * shop checkout split, wallet ledger, withdrawal with commission cut, refunds, jobs, permissions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';
import { outbox } from '../src/lib/mailer';
import { releaseDue } from '../src/modules/wallet/ledger';
import { autoWithdrawOld } from '../src/modules/wallet/withdrawals';
import { expireHolds } from '../src/jobs';
import { clearSettingsCache } from '../src/lib/settings';

const app = createApp();
const api = () => request(app);
const V = '/api/v1';
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PDF = Buffer.from('%PDF-1.4\n%test document\n');
const tokens: Record<string, string> = {};
const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

async function login(email: string, key: string, password = 'demo1234') {
  const r = await api().post(`${V}/auth/login`).send({ email, password });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  tokens[key] = r.body.accessToken;
  return r.body;
}

/** next date (≥ minDays ahead) on which the salon is open */
async function openDate(salonId: string, minDays = 3) {
  const s = await prisma.salon.findUniqueOrThrow({ where: { id: salonId } });
  const hours = s.hours as { day: number; open: string | null }[];
  for (let i = minDays; i < minDays + 14; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const wd = (d.getDay() + 6) % 7;
    if (hours.find((h) => h.day === wd)?.open) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  throw new Error('no open day');
}

beforeAll(async () => {
  await login('giulia@demo.it', 'giulia');
  await login('marco@barberiaelite.it', 'marco');
  await login('admin@mybeauty.it', 'admin');
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('health & auth', () => {
  it('health reports db ok and mock payments', async () => {
    const r = await api().get(`${V}/health`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ok', db: 'ok', payments: 'mock' });
  });

  it('rejects a wrong password with a generic message', async () => {
    const r = await api().post(`${V}/auth/login`).send({ email: 'giulia@demo.it', password: 'nope' });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('invalid_credentials');
  });

  it('validates registration input', async () => {
    const r = await api().post(`${V}/auth/register`).send({ name: 'X', email: 'bad', password: '1', acceptTerms: false });
    expect(r.status).toBe(422);
    expect(Object.keys(r.body.error.fields)).toEqual(expect.arrayContaining(['name', 'email', 'password', 'acceptTerms']));
  });

  it('rotates refresh tokens and kills all sessions on reuse', async () => {
    const s = await login('giulia@demo.it', 'giulia2');
    const r1 = await api().post(`${V}/auth/refresh`).send({ refreshToken: s.refreshToken });
    expect(r1.status).toBe(200);
    const reuse = await api().post(`${V}/auth/refresh`).send({ refreshToken: s.refreshToken });
    expect(reuse.status).toBe(401);
    const r2 = await api().post(`${V}/auth/refresh`).send({ refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(401); // revoked by the reuse detection
  });

  it('password reset via emailed link', async () => {
    await api().post(`${V}/auth/register`).send({ name: 'Reset Test', email: 'reset@test.it', password: 'password1', acceptTerms: true }).expect(201);
    await api().post(`${V}/auth/forgot`).send({ email: 'reset@test.it' }).expect(200);
    const mail = outbox.find((m) => m.to === 'reset@test.it' && m.subject.includes('password'))!;
    const token = /token=([\w-]+)/.exec(mail.text)![1];
    await api().post(`${V}/auth/reset`).send({ token, password: 'newpassword9' }).expect(200);
    await api().post(`${V}/auth/reset`).send({ token, password: 'again12345' }).expect(400);
    await api().post(`${V}/auth/login`).send({ email: 'reset@test.it', password: 'newpassword9' }).expect(200);
  });

  it('enforces roles', async () => {
    expect((await api().get(`${V}/admin/stats`).set(auth('giulia'))).status).toBe(403);
    expect((await api().get(`${V}/seller/wallet`).set(auth('giulia'))).status).toBe(403);
    expect((await api().get(`${V}/me/bookings`)).status).toBe(401);
    expect((await api().get(`${V}/admin/stats`).set(auth('admin'))).status).toBe(200);
  });
});

describe('catalog (guest)', () => {
  it('lists only approved salons with filters', async () => {
    const r = await api().get(`${V}/salons?city=Catanzaro&sort=rating`);
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(r.body.items.every((s: { city: string; status: string }) => s.city === 'Catanzaro' && s.status === 'approved')).toBe(true);
    expect(r.body.items[0]).not.toHaveProperty('commissionRate');
  });

  it('hides pending salons', async () => {
    expect((await api().get(`${V}/salons/luna-nails`)).status).toBe(404);
  });

  it('salon page + availability', async () => {
    const r = await api().get(`${V}/salons/barberia-elite`);
    expect(r.status).toBe(200);
    expect(r.body.services.length).toBeGreaterThan(0);
    const date = await openDate('s1');
    const a = await api().get(`${V}/salons/s1/availability?date=${date}&serviceIds=${r.body.services[0].id}`);
    expect(a.status).toBe(200);
    expect(a.body.slots.some((s: { free: boolean }) => s.free)).toBe(true);
  });

  it('products search + quote with two salons', async () => {
    const r = await api().get(`${V}/products?pageSize=100&inStock=true`);
    const bySalon = new Map<string, string>();
    for (const p of r.body.items) if (!bySalon.has(p.salonId) && p.variants.length === 0) bySalon.set(p.salonId, p.id);
    const [a, b] = [...bySalon.values()];
    const q = await api().post(`${V}/cart/quote`).send({ lines: [{ productId: a, qty: 1 }, { productId: b, qty: 2 }] });
    expect(q.status).toBe(200);
    expect(q.body.groups).toHaveLength(2);
    expect(q.body.total).toBeCloseTo(q.body.subtotal + q.body.shipping - q.body.discount, 2);
  });
});

describe('seller onboarding → admin approval', () => {
  let appId = '';
  it('seller registers, fills application, uploads docs + photos, adds a service and submits', async () => {
    const reg = await api().post(`${V}/auth/register`).send({ role: 'seller', name: 'Anna Test', email: 'anna@salonetest.it', password: 'password1', salonName: 'Salone Test Anna', salonCategory: 'unghie', city: 'Cosenza', acceptTerms: true });
    expect(reg.status).toBe(201);
    expect(reg.body.salon.status).toBe('draft');
    tokens.anna = reg.body.accessToken;

    // locked before approval
    expect((await api().get(`${V}/seller/agenda?from=2026-01-01`).set(auth('anna'))).body.error.code).toBe('salon_not_approved');

    const sub0 = await api().post(`${V}/seller/application/submit`).set(auth('anna')).send({ acceptSellerTerms: true });
    expect(sub0.status).toBe(400);
    expect(sub0.body.error.details.missing.length).toBeGreaterThan(5);
    expect(sub0.body.error.details.missing).not.toContain('Almeno un servizio');

    const up = await api().post(`${V}/uploads`).set(auth('anna')).attach('files', JPG, 'a.jpg').attach('files', JPG, 'b.jpg').attach('files', JPG, 'c.jpg');
    expect(up.status).toBe(201);
    const urls = up.body.files.map((f: { url: string }) => f.url);
    const bad = await api().post(`${V}/uploads`).set(auth('anna')).attach('files', Buffer.from('not an image at all'), 'x.jpg');
    expect(bad.body.error.code).toBe('bad_type');

    const put = await api().put(`${V}/seller/application`).set(auth('anna')).send({
      salon: { address: 'Via Roma 1', city: 'Cosenza', phone: '+39 0984 111111', cover: urls[0], gallery: urls.slice(1), description: 'Nail art, gel e semipermanente in un ambiente curato nel centro di Cosenza.' },
      business: { ragioneSociale: 'Salone Test di Anna', pIva: '01234567890', iban: 'IT60 X054 2811 1010 0000 0123 456', sdi: 'M5UXCR1', legalAddress: 'Via Roma 1, Cosenza' },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    for (const type of ['visura', 'id']) {
      const doc = await api().post(`${V}/uploads/private`).set(auth('anna')).attach('file', PDF, `${type}.pdf`);
      expect(doc.status).toBe(201);
      await api().post(`${V}/seller/application/documents`).set(auth('anna')).send({ type, name: `${type}.pdf`, key: doc.body.key }).expect(201);
    }
    const svc = await api().post(`${V}/seller/services`).set(auth('anna')).send({ category: 'Unghie', name: 'Semipermanente mani', images: urls, durationMin: 45, price: 30, depositPct: 30 });
    expect(svc.status).toBe(201);
    expect(svc.body.images).toHaveLength(3);
    const prod = await api().post(`${V}/seller/products`).set(auth('anna')).send({ brand: 'TestBrand', category: 'unghie', name: 'Gel Rosso Test', images: [urls[0]], price: 12.5, stock: 5 });
    expect(prod.body.status).toBe('draft');

    const sub = await api().post(`${V}/seller/application/submit`).set(auth('anna')).send({ acceptSellerTerms: true });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    const app2 = await api().get(`${V}/seller/application`).set(auth('anna'));
    expect(app2.body.application.status).toBe('pending');
    appId = app2.body.application.id;
    // locked while pending
    expect((await api().put(`${V}/seller/application`).set(auth('anna')).send({ business: { sdi: 'XXXXXXX' } })).status).toBe(409);
  });

  it('admin sees signed document links, must complete checklist, then approves', async () => {
    const d = await api().get(`${V}/admin/applications/${appId}`).set(auth('admin'));
    expect(d.status).toBe(200);
    const url: string = d.body.application.documents[0].url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    expect((await api().get(path)).status).toBe(200);
    expect((await api().get(path.replace(/sig=[^&]+/, 'sig=forged'))).status).toBe(403);

    const early = await api().post(`${V}/admin/applications/${appId}/approve`).set(auth('admin')).send({});
    expect(early.body.error.code).toBe('checklist_incomplete');
    await api().patch(`${V}/admin/applications/${appId}/checklist`).set(auth('admin')).send({ docs: true, vat: true, iban: true, photos: true }).expect(200);
    await api().post(`${V}/admin/applications/${appId}/approve`).set(auth('admin')).send({ commissionRate: 0.1 }).expect(200);

    const me = await api().get(`${V}/auth/me`).set(auth('anna'));
    expect(me.body.salon.status).toBe('approved');
    expect(me.body.salon.commissionRate).toBe(0.1);
  });

  it('product moderation: product was sent to review on submit, admin publishes', async () => {
    const list = await api().get(`${V}/admin/products?status=review`).set(auth('admin'));
    const p = list.body.find((x: { name: string }) => x.name === 'Gel Rosso Test');
    expect(p).toBeTruthy();
    await api().post(`${V}/admin/products/${p.id}/moderate`).set(auth('admin')).send({ decision: 'publish' }).expect(200);
    expect((await api().get(`${V}/products/${p.id}`)).status).toBe(200);
  });

  it('seller cannot touch another salon’s service', async () => {
    const other = await prisma.service.findFirstOrThrow({ where: { salonId: 's1' } });
    const r = await api().put(`${V}/seller/services/${other.id}`).set(auth('anna')).send({ price: 1 });
    expect(r.status).toBe(404);
  });
});

describe('bookings + payments', () => {
  let bookingId = '';
  let paymentId = '';
  it('deposit booking → awaiting payment → paid (mock) → booked, ledger pending', async () => {
    const salon = await api().get(`${V}/salons/salone-test-anna`);
    const svc = salon.body.services[0];
    const date = await openDate(salon.body.salon.id);
    const avail = await api().get(`${V}/salons/${salon.body.salon.id}/availability?date=${date}&serviceIds=${svc.id}`);
    const slot = avail.body.slots.find((s: { free: boolean }) => s.free).time;
    const r = await api().post(`${V}/bookings`).set(auth('giulia')).send({ salonId: salon.body.salon.id, serviceIds: [svc.id], date, time: slot, paymentMode: 'deposit' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.booking.status).toBe('awaiting_payment');
    expect(r.body.payment.amount).toBe(9); // 30% of €30
    bookingId = r.body.booking.id;
    paymentId = r.body.payment.paymentId;

    const paid = await api().post(`${V}/payments/${paymentId}/mock-confirm`).set(auth('giulia')).send({});
    expect(paid.body.status).toBe('succeeded');
    const b = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(b.status).toBe('booked');
    expect(b.paidCents).toBe(900);
    const line = await prisma.ledgerEntry.findFirstOrThrow({ where: { sourceId: bookingId } });
    expect(line).toMatchObject({ amountCents: 900, commissionBps: 1000, commissionCents: 90, status: 'pending', availableAt: null });
    // confirming twice does nothing
    await api().post(`${V}/payments/${paymentId}/mock-confirm`).set(auth('giulia')).send({});
    expect(await prisma.ledgerEntry.count({ where: { sourceId: bookingId } })).toBe(1);
  });

  it('two customers racing for the same staff + slot: exactly one wins', async () => {
    const s1 = await api().get(`${V}/salons/barberia-elite`);
    const svc = s1.body.services[0];
    const staff = s1.body.staff[0];
    const date = await openDate('s1', 5);
    const avail = await api().get(`${V}/salons/s1/availability?date=${date}&serviceIds=${svc.id}&staffId=${staff.id}`);
    const time = avail.body.slots.find((s: { free: boolean }) => s.free).time;
    const reg = await api().post(`${V}/auth/register`).send({ name: 'Racer Two', email: 'racer@test.it', password: 'password1', acceptTerms: true });
    tokens.racer = reg.body.accessToken;
    const body = { salonId: 's1', serviceIds: [svc.id], staffId: staff.id, date, time, paymentMode: 'in_salon' };
    const [a, b] = await Promise.all([api().post(`${V}/bookings`).set(auth('giulia')).send(body), api().post(`${V}/bookings`).set(auth('racer')).send(body)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a.body, b.body].find((x) => x.error)?.error.code).toBe('slot_taken');
  });

  it('seller completes the booking → cash commission + release after 48h', async () => {
    // move the booking to today (an appointment must have happened before it can be completed)
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await prisma.booking.update({ where: { id: bookingId }, data: { date: iso, startMin: 0 } });
    const r = await api().patch(`${V}/seller/bookings/${bookingId}`).set(auth('anna')).send({ status: 'completed' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const lines = await prisma.ledgerEntry.findMany({ where: { sourceId: bookingId }, orderBy: { createdAt: 'asc' } });
    expect(lines.map((l) => l.type)).toEqual(['sale', 'cash_commission']);
    expect(lines[1].commissionCents).toBe(210); // 10% of the €21 paid in cash
    expect(lines.every((l) => l.availableAt && l.availableAt > new Date())).toBe(true);
    expect(await releaseDue(new Date(Date.now() + 49 * 3600_000))).toBeGreaterThanOrEqual(2);
  });

  it('customer cancels a paid booking in time → full refund, ledger nets to zero', async () => {
    const salon = await api().get(`${V}/salons/salone-test-anna`);
    const svc = salon.body.services[0];
    const date = await openDate(salon.body.salon.id, 4);
    const avail = await api().get(`${V}/salons/${salon.body.salon.id}/availability?date=${date}&serviceIds=${svc.id}`);
    const time = avail.body.slots.find((s: { free: boolean }) => s.free).time;
    const r = await api().post(`${V}/bookings`).set(auth('giulia')).send({ salonId: salon.body.salon.id, serviceIds: [svc.id], date, time, paymentMode: 'card' });
    await api().post(`${V}/payments/${r.body.payment.paymentId}/mock-confirm`).set(auth('giulia')).send({}).expect(200);
    const c = await api().post(`${V}/bookings/${r.body.booking.id}/cancel`).set(auth('giulia')).send({});
    expect(c.body).toMatchObject({ ok: true, refunded: 30 });
    const lines = await prisma.ledgerEntry.findMany({ where: { sourceId: r.body.booking.id } });
    expect(lines.reduce((a, l) => a + l.amountCents, 0)).toBe(0);
    expect(lines.reduce((a, l) => a + l.commissionCents, 0)).toBe(0);
  });

  it('unpaid holds expire', async () => {
    const salon = await api().get(`${V}/salons/salone-test-anna`);
    const svc = salon.body.services[0];
    const date = await openDate(salon.body.salon.id, 6);
    const avail = await api().get(`${V}/salons/${salon.body.salon.id}/availability?date=${date}&serviceIds=${svc.id}`);
    const time = avail.body.slots.find((s: { free: boolean }) => s.free).time;
    const r = await api().post(`${V}/bookings`).set(auth('giulia')).send({ salonId: salon.body.salon.id, serviceIds: [svc.id], date, time, paymentMode: 'deposit' });
    const res = await expireHolds(new Date(Date.now() + 16 * 60_000));
    expect(res.bookings).toBeGreaterThanOrEqual(1);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: r.body.booking.id } })).status).toBe('cancelled');
  });
});

describe('shop: checkout split per salon', () => {
  let orderId = '';
  it('checkout reserves stock, payment confirms, one sub-order per salon', async () => {
    const anna = await prisma.product.findFirstOrThrow({ where: { name: 'Gel Rosso Test' } });
    const other = await prisma.product.findFirstOrThrow({ where: { salonId: 's1', status: 'published', stock: { gt: 3 }, variants: { none: {} } } });
    const before = other.stock;
    const r = await api().post(`${V}/checkout`).set(auth('giulia')).send({
      lines: [{ productId: anna.id, qty: 2 }, { productId: other.id, qty: 1 }],
      shipping: { [anna.salonId]: 'standard', s1: 'pickup' },
      addressId: 'u-giulia-a1',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    orderId = r.body.order.id;
    expect(r.body.order.subOrders).toHaveLength(2);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: other.id } })).stock).toBe(before - 1);
    await api().post(`${V}/payments/${r.body.payment.paymentId}/mock-confirm`).set(auth('giulia')).send({}).expect(200);
    const subs = await prisma.subOrder.findMany({ where: { orderId } });
    expect(subs.every((s) => s.status === 'received')).toBe(true);
    const annaSub = subs.find((s) => s.salonId === anna.salonId)!;
    const line = await prisma.ledgerEntry.findFirstOrThrow({ where: { sourceId: annaSub.id } });
    expect(line.amountCents).toBe(2500 + annaSub.shippingFeeCents);
  });

  it('cannot oversell', async () => {
    const anna = await prisma.product.findFirstOrThrow({ where: { name: 'Gel Rosso Test' } });
    const r = await api().post(`${V}/checkout`).set(auth('giulia')).send({ lines: [{ productId: anna.id, qty: 10 }], addressId: 'u-giulia-a1' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('cart_changed');
  });

  it('seller ships with tracking, delivers → funds release after the 14-day return window', async () => {
    const sub = (await prisma.subOrder.findMany({ where: { orderId } })).find((s) => s.shippingMethod === 'standard')!;
    expect((await api().patch(`${V}/seller/sub-orders/${sub.id}`).set(auth('anna')).send({ status: 'shipped' })).body.error.code).toBe('bad_transition');
    await api().patch(`${V}/seller/sub-orders/${sub.id}`).set(auth('anna')).send({ status: 'preparing' }).expect(200);
    expect((await api().patch(`${V}/seller/sub-orders/${sub.id}`).set(auth('anna')).send({ status: 'shipped' })).body.error.code).toBe('tracking_required');
    await api().patch(`${V}/seller/sub-orders/${sub.id}`).set(auth('anna')).send({ status: 'shipped', trackingNo: 'BRT123' }).expect(200);
    await api().patch(`${V}/seller/sub-orders/${sub.id}`).set(auth('anna')).send({ status: 'delivered' }).expect(200);
    const line = await prisma.ledgerEntry.findFirstOrThrow({ where: { sourceId: sub.id } });
    expect(line.availableAt!.getTime() - Date.now()).toBeGreaterThan(13 * 86400_000);
    await releaseDue(new Date(Date.now() + 15 * 86400_000));
    expect((await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: line.id } })).status).toBe('available');
  });
});

describe('wallet + withdrawals (commission cut on withdrawal)', () => {
  it('new seller must finish Stripe onboarding before withdrawing', async () => {
    const w = await api().get(`${V}/seller/wallet`).set(auth('anna'));
    expect(w.status).toBe(200);
    expect(w.body.available.net).toBeGreaterThan(20);
    const r = await api().post(`${V}/seller/withdrawals`).set(auth('anna'));
    expect(r.body.error.code).toBe('stripe_not_ready');
    const ob = await api().post(`${V}/seller/stripe/onboarding`).set(auth('anna')).send({ returnUrl: 'http://localhost:5173/' });
    expect(ob.body.url).toContain('/payments/mock/onboard');
    await api().get(new URL(ob.body.url).pathname + new URL(ob.body.url).search).expect(302);
    expect((await api().get(`${V}/seller/stripe/status`).set(auth('anna'))).body.payoutsReady).toBe(true);
  });

  it('withdrawal: gross − commission = transfer, lines withdrawn, admin approves', async () => {
    const before = await api().get(`${V}/seller/wallet`).set(auth('anna'));
    const avail = before.body.available;
    expect(avail.net).toBeCloseTo(avail.gross - avail.commission, 2);
    const r = await api().post(`${V}/seller/withdrawals`).set(auth('anna'));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ status: 'requested', gross: avail.gross, commission: avail.commission, net: avail.net });
    expect((await api().post(`${V}/seller/withdrawals`).set(auth('anna'))).body.error.code).toBe('withdrawal_open');

    const ap = await api().post(`${V}/admin/withdrawals/${r.body.id}/approve`).set(auth('admin'));
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect(ap.body.status).toBe('paid');
    expect(ap.body.stripeTransferId).toMatch(/^tr_mock_/);
    const after = await api().get(`${V}/seller/wallet`).set(auth('anna'));
    expect(after.body.available.net).toBe(0);
    expect(after.body.withdrawn.net).toBeCloseTo(avail.net, 2);
  });

  it('refund after withdrawal leaves a negative balance netted next time', async () => {
    const order = await prisma.order.findFirstOrThrow({ where: { customerId: 'u-giulia', subOrders: { some: { salon: { slug: 'salone-test-anna' } } } }, include: { subOrders: true } });
    const sub = order.subOrders.find((s) => s.status === 'delivered')!;
    await api().post(`${V}/orders/${order.id}/return`).set(auth('giulia')).send({ subOrderId: sub.id, reason: 'Colore diverso dalla foto' }).expect(200);
    await api().patch(`${V}/seller/sub-orders/${sub.id}`).set(auth('anna')).send({ status: 'refunded' }).expect(200);
    const w = await api().get(`${V}/seller/wallet`).set(auth('anna'));
    expect(w.body.available.net).toBeLessThan(0);
    expect(w.body.canWithdraw).toBe(false);
  });

  it('minimum withdrawal and admin rejection', async () => {
    await prisma.platformSetting.upsert({ where: { key: 'minWithdrawal' }, create: { key: 'minWithdrawal', value: 100000 }, update: { value: 100000 } });
    clearSettingsCache();
    const r = await api().post(`${V}/seller/withdrawals`).set(auth('marco'));
    expect(r.body.error.code).toBe('below_minimum');
    await prisma.platformSetting.delete({ where: { key: 'minWithdrawal' } });
    clearSettingsCache();
    const ok = await api().post(`${V}/seller/withdrawals`).set(auth('marco'));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    await api().post(`${V}/admin/withdrawals/${ok.body.id}/reject`).set(auth('admin')).send({ reason: 'Verifica in corso' }).expect(200);
    const w = await api().get(`${V}/seller/wallet`).set(auth('marco'));
    expect(w.body.available.net).toBeCloseTo(ok.body.net, 2); // money is back in the wallet
  });

  it('auto-withdraw job sends money older than 75 days (Stripe 90-day limit)', async () => {
    const line = await prisma.ledgerEntry.findFirstOrThrow({ where: { salonId: 's1', status: 'available', withdrawalId: null } });
    await prisma.ledgerEntry.update({ where: { id: line.id }, data: { createdAt: new Date(Date.now() - 80 * 86400_000) } });
    const r = await autoWithdrawOld();
    expect(r.find((x) => x.salonId === 's1')?.ok).toBe(true);
    const w = await prisma.withdrawal.findFirstOrThrow({ where: { salonId: 's1', auto: true } });
    expect(w.status).toBe('paid');
  });

  it('changing the commission rate does not change money already earned', async () => {
    const lineBefore = await prisma.ledgerEntry.findFirstOrThrow({ where: { salon: { slug: 'salone-test-anna' }, type: 'sale' } });
    const salon = await prisma.salon.findUniqueOrThrow({ where: { slug: 'salone-test-anna' } });
    await api().patch(`${V}/admin/salons/${salon.id}`).set(auth('admin')).send({ commissionRate: 0.2 }).expect(200);
    const lineAfter = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: lineBefore.id } });
    expect(lineAfter.commissionBps).toBe(1000);
  });
});

describe('reviews', () => {
  it('only verified customers can review; ratings recomputed', async () => {
    const done = await prisma.booking.findFirstOrThrow({ where: { customerId: 'u-giulia', status: 'completed', reviewed: false } });
    const r = await api().post(`${V}/reviews`).set(auth('giulia')).send({ bookingId: done.id, rating: 5, text: 'Esperienza bellissima, consigliato!' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await api().post(`${V}/reviews`).set(auth('giulia')).send({ bookingId: done.id, rating: 5, text: 'Di nuovo recensione doppia' })).status).toBe(409);
    const fut = await prisma.booking.findFirstOrThrow({ where: { customerId: 'u-giulia', status: { in: ['booked', 'confirmed'] } } });
    expect((await api().post(`${V}/reviews`).set(auth('giulia')).send({ bookingId: fut.id, rating: 1, text: 'Non è ancora avvenuto' })).body.error.code).toBe('not_completed');
  });
});

describe('B9: apps support', () => {
  it('catalog snapshot: approved salons with services only, anonymous busy blocks', async () => {
    const r = await api().get(`${V}/catalog`);
    expect(r.status).toBe(200);
    const ids = new Set(r.body.salons.map((s: { id: string }) => s.id));
    expect(r.body.salons.every((s: { status: string }) => s.status === 'approved')).toBe(true);
    expect(r.body.services.every((s: { salonId: string }) => ids.has(s.salonId))).toBe(true);
    expect(r.body.busy.length).toBeGreaterThan(0);
    expect(Object.keys(r.body.busy[0]).sort()).toEqual(['date', 'durationMin', 'id', 'salonId', 'staffId', 'status', 'time']); // no customer data
  });

  it('availability uses the shared 30-minute grid', async () => {
    const svc = await prisma.service.findFirstOrThrow({ where: { salonId: 's1', active: true } });
    const date = await openDate('s1', 8);
    const a = await api().get(`${V}/salons/s1/availability?date=${date}&serviceIds=${svc.id}`);
    expect(a.body.slots.every((s: { time: string }) => ['00', '30'].includes(s.time.slice(3)))).toBe(true);
  });

  it('staff serviceIds are cleaned of unknown ids', async () => {
    const r = await api().post(`${V}/seller/staff`).set(auth('anna')).send({ name: 'Test Staff', serviceIds: ['sv-temp-123', 'nope'] });
    expect(r.status).toBe(201);
    expect(r.body.serviceIds).toEqual([]);
  });

  it('approved salon without services is hidden from the public catalog', async () => {
    await prisma.service.updateMany({ where: { salon: { slug: 'salone-test-anna' } }, data: { active: false } });
    const r = await api().get(`${V}/catalog`);
    expect(r.body.salons.some((s: { slug: string }) => s.slug === 'salone-test-anna')).toBe(false);
    await prisma.service.updateMany({ where: { salon: { slug: 'salone-test-anna' } }, data: { active: true } });
  });
});

describe('salon time windows (places + services)', () => {
  const iso = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const wd = (date: string) => { const [y, m, d] = date.split('-').map(Number); return (new Date(y, m - 1, d).getDay() + 6) % 7; };
  let svc: { id: string; durationMin: number }[] = [];
  let winId = '';
  let giuliaBooking = '';

  it('seller creates windows for many days at once; duplicates are skipped', async () => {
    svc = await prisma.service.findMany({ where: { salonId: 's1', active: true, deletedAt: null, durationMin: { lte: 60 } }, take: 3, orderBy: { durationMin: 'asc' } });
    const from = iso(30), to = iso(43);
    const body = { from, to, weekdays: [wd(from)], start: '13:00', end: '14:00', serviceIds: [svc[0].id, svc[1].id], capacity: 2, note: 'Pranzo' };
    const r = await api().post(`${V}/seller/windows`).set(auth('marco')).send(body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.created.map((w: { date: string }) => w.date)).toEqual([from, iso(37)]);
    expect(r.body.created[0]).toMatchObject({ start: '13:00', end: '14:00', capacity: 2, booked: 0, open: true, staffId: null });
    winId = r.body.created[0].id;
    const again = await api().post(`${V}/seller/windows`).set(auth('marco')).send(body);
    expect(again.body.created).toHaveLength(0);
    expect(again.body.skipped.map((x: { reason: string }) => x.reason)).toEqual(['duplicate', 'duplicate']);
  });

  it('rejects services longer than the window and windows in the past', async () => {
    const long = await api().post(`${V}/seller/windows`).set(auth('marco')).send({ from: iso(31), start: '13:00', end: '13:15', serviceIds: [svc[1].id], capacity: 1 });
    expect(long.status).toBe(400);
    expect(long.body.error.code).toBe('window_too_short');
    const past = await api().post(`${V}/seller/windows`).set(auth('marco')).send({ from: iso(-1), start: '13:00', end: '14:00', serviceIds: [svc[0].id], capacity: 1 });
    expect(past.body.error.code).toBe('in_past');
  });

  it('customers see the window, each booking takes one place, the last place cannot be taken twice', async () => {
    const snap = await api().get(`${V}/catalog`);
    expect(snap.body.windows.find((w: { id: string }) => w.id === winId)).toMatchObject({ capacity: 2, booked: 0 });
    const notIn = await prisma.service.findFirstOrThrow({ where: { salonId: 's1', active: true, id: { notIn: [svc[0].id, svc[1].id] } } });
    const wrong = await api().post(`${V}/bookings`).set(auth('giulia')).send({ salonId: 's1', windowId: winId, serviceIds: [notIn.id] });
    expect(wrong.body.error.code).toBe('window_service');

    const g = await api().post(`${V}/bookings`).set(auth('giulia')).send({ salonId: 's1', windowId: winId, serviceIds: [svc[0].id] });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    expect(g.body.booking).toMatchObject({ date: iso(30), time: '13:00', windowId: winId, status: 'booked' });
    giuliaBooking = g.body.booking.id;
    const twice = await api().post(`${V}/bookings`).set(auth('giulia')).send({ salonId: 's1', windowId: winId, serviceIds: [svc[1].id] });
    expect(twice.body.error.code).toBe('window_already_booked');

    const reg = await api().post(`${V}/auth/register`).send({ name: 'Terza Cliente', email: 'terza@test.it', password: 'password1', acceptTerms: true });
    tokens.terza = reg.body.accessToken;
    const body = { salonId: 's1', windowId: winId, serviceIds: [svc[1].id] };
    const [a, b] = await Promise.all([api().post(`${V}/bookings`).set(auth('racer')).send(body), api().post(`${V}/bookings`).set(auth('terza')).send(body)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a.body, b.body].find((x) => x.error)?.error.code).toBe('window_full');
    const after = await api().get(`${V}/catalog`);
    expect(after.body.windows.find((w: { id: string }) => w.id === winId)).toBeUndefined(); // full → hidden
  });

  it('window bookings never use normal capacity; a staffed window blocks that person', async () => {
    const date = iso(30);
    const staff = await prisma.staff.findFirstOrThrow({ where: { salonId: 's1', active: true } });
    const hours = ((await prisma.salon.findUniqueOrThrow({ where: { id: 's1' } })).hours as { day: number; open: string | null }[]).find((h) => h.day === wd(date));
    if (hours?.open) {
      // unstaffed window bookings at 13:00 must not make 13:00 busy for normal bookings
      const a = await api().get(`${V}/salons/s1/availability?date=${date}&serviceIds=${svc[0].id}&staffId=${staff.id}`);
      expect(a.body.slots.find((x: { time: string }) => x.time === '13:00')?.free).toBe(true);
    }
    const day = iso(33);
    const s = await api().post(`${V}/seller/windows`).set(auth('marco')).send({ from: day, start: '10:00', end: '11:00', serviceIds: [svc[0].id], capacity: 3, staffId: staff.id });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    const open = ((await prisma.salon.findUniqueOrThrow({ where: { id: 's1' } })).hours as { day: number; open: string | null }[]).find((h) => h.day === wd(day))?.open;
    if (open) {
      const a = await api().get(`${V}/salons/s1/availability?date=${day}&serviceIds=${svc[0].id}&staffId=${staff.id}`);
      expect(a.body.slots.filter((x: { time: string; free: boolean }) => ['10:00', '10:30'].includes(x.time)).every((x: { free: boolean }) => !x.free)).toBe(true);
    }
    const snap = await api().get(`${V}/catalog`);
    expect(snap.body.busy.some((b: { id: string; staffId: string; date: string }) => b.id === `win-${s.body.created[0].id}` && b.staffId === staff.id && b.date === day)).toBe(true);
  });

  it('seller rules: places never below booked, no delete with bookings, close hides it; no reschedule', async () => {
    const low = await api().patch(`${V}/seller/windows/${winId}`).set(auth('marco')).send({ capacity: 1 });
    expect(low.body.error.code).toBe('capacity_below_booked');
    const del = await api().delete(`${V}/seller/windows/${winId}`).set(auth('marco'));
    expect(del.body.error.code).toBe('window_has_bookings');
    const move = await api().post(`${V}/bookings/${giuliaBooking}/reschedule`).set(auth('giulia')).send({ date: iso(31), time: '10:00' });
    expect(move.body.error.code).toBe('window_booking');
    // customer cancels → place comes back → window visible again; closing it hides it
    await api().post(`${V}/bookings/${giuliaBooking}/cancel`).set(auth('giulia')).send({});
    let snap = await api().get(`${V}/catalog`);
    expect(snap.body.windows.find((w: { id: string }) => w.id === winId)).toMatchObject({ booked: 1 });
    await api().patch(`${V}/seller/windows/${winId}`).set(auth('marco')).send({ open: false });
    snap = await api().get(`${V}/catalog`);
    expect(snap.body.windows.find((w: { id: string }) => w.id === winId)).toBeUndefined();
    const list = await api().get(`${V}/seller/windows`).set(auth('marco'));
    expect(list.body.find((w: { id: string }) => w.id === winId)).toMatchObject({ open: false, booked: 1 });
    // another salon's window is invisible to this seller
    const other = await prisma.timeWindow.create({ data: { salonId: 's2', date: iso(40), startMin: 600, endMin: 660, serviceIds: [], capacity: 1 } });
    expect((await api().patch(`${V}/seller/windows/${other.id}`).set(auth('marco')).send({ open: false })).status).toBe(404);
  });
});

describe('language (IT/EN)', () => {
  it('errors follow the request language', async () => {
    const it = await api().post(`${V}/auth/login`).set('X-Lang', 'it').send({ email: 'giulia@demo.it', password: 'nope' });
    expect(it.body.error.message).toBe('Email o password non corretti');
    const en = await api().post(`${V}/auth/login`).set('X-Lang', 'en').send({ email: 'giulia@demo.it', password: 'nope' });
    expect(en.body.error.message).toBe('Wrong email or password');
    const v = await api().post(`${V}/auth/register`).set('X-Lang', 'en').send({ name: 'X', email: 'bad', password: '1', acceptTerms: true });
    expect(v.body.error.message).toBe('Invalid data');
    expect(v.body.error.fields.password[0]).toBe('At least 8 characters');
    const nf = await api().get(`${V}/salons/does-not-exist`).set('X-Lang', 'en');
    expect(nf.body.error.message).toBe('Salon not found');
    const nfIt = await api().get(`${V}/salons/does-not-exist`);
    expect(nfIt.body.error.message).toBe('Salone non trovato');
  });

  it('notifications use the recipient’s saved language', async () => {
    await api().patch(`${V}/me`).set(auth('marco')).send({ lang: 'en' });
    const svc = await prisma.service.findFirstOrThrow({ where: { salonId: 's1', active: true } });
    const date = await openDate('s1', 9);
    const a = await api().get(`${V}/salons/s1/availability?date=${date}&serviceIds=${svc.id}`);
    const time = a.body.slots.find((s: { free: boolean }) => s.free).time;
    await api().post(`${V}/bookings`).set(auth('giulia')).send({ salonId: 's1', serviceIds: [svc.id], date, time, paymentMode: 'in_salon' }).expect(201);
    const n = await prisma.notification.findFirstOrThrow({ where: { userId: 'u-marco' }, orderBy: { at: 'desc' } });
    expect(n.title).toBe('New booking');
    const g = await prisma.notification.findFirstOrThrow({ where: { userId: 'u-giulia' }, orderBy: { at: 'desc' } });
    expect(g.title).toBe('Prenotazione confermata');
    await api().patch(`${V}/me`).set(auth('marco')).send({ lang: 'it' });
  });
});
