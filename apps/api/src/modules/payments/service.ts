/**
 * Customer payments (PaymentIntents) for bookings and shop orders, plus refunds.
 * Payment success arrives via the Stripe webhook (or /mock-confirm in mock mode) and is handled idempotently.
 */
import { prisma } from '../../lib/prisma';
import { badRequest, notFound } from '../../lib/errors';
import { notify } from '../../lib/notify';
import { getSettings } from '../../lib/settings';
import { gateway } from './gateway';
import { recordRefund, recordSale } from '../wallet/ledger';
import { m } from '../../lib/i18n';

export async function createIntentForBooking(bookingId: string, customerId: string) {
  const b = await prisma.booking.findUnique({ where: { id: bookingId }, include: { customer: true, salon: true } });
  if (!b || b.customerId !== customerId) throw notFound('Prenotazione');
  if (b.status !== 'awaiting_payment') throw badRequest('Questa prenotazione non richiede pagamento', 'not_payable');
  const amount = b.paymentMode === 'card' ? b.totalCents : b.depositCents;
  const existing = await prisma.payment.findFirst({ where: { bookingId, status: 'requires_payment' } });
  if (existing) return { payment: existing, clientSecret: await clientSecretFor(existing.providerPaymentId) };
  const pi = await gateway.createPaymentIntent({
    amountCents: amount,
    description: `${b.salon.name} · prenotazione ${b.code}`,
    metadata: { kind: 'booking', bookingId: b.id, salonId: b.salonId },
    email: b.customer?.email,
    idempotencyKey: `booking-${b.id}`,
    transferGroup: `booking_${b.id}`,
  });
  secrets.set(pi.id, pi.clientSecret);
  const payment = await prisma.payment.create({
    data: { provider: gateway.mode, providerPaymentId: pi.id, kind: 'booking', bookingId: b.id, customerId, amountCents: amount },
  });
  return { payment, clientSecret: pi.clientSecret };
}

export async function createIntentForOrder(orderId: string, customerId: string) {
  const o = await prisma.order.findUnique({ where: { id: orderId }, include: { customer: true } });
  if (!o || o.customerId !== customerId) throw notFound('Ordine');
  if (o.status !== 'pending_payment') throw badRequest('Ordine già pagato o annullato', 'not_payable');
  const existing = await prisma.payment.findFirst({ where: { orderId, status: 'requires_payment' } });
  if (existing) return { payment: existing, clientSecret: await clientSecretFor(existing.providerPaymentId) };
  const pi = await gateway.createPaymentIntent({
    amountCents: o.totalCents,
    description: `MyBeauty+ ordine ${o.code}`,
    metadata: { kind: 'order', orderId: o.id },
    email: o.customer.email,
    idempotencyKey: `order-${o.id}`,
    transferGroup: `order_${o.id}`,
  });
  secrets.set(pi.id, pi.clientSecret);
  const payment = await prisma.payment.create({
    data: { provider: gateway.mode, providerPaymentId: pi.id, kind: 'order', orderId: o.id, customerId, amountCents: o.totalCents },
  });
  return { payment, clientSecret: pi.clientSecret };
}

// client secrets are not stored in the DB; re-created idempotently by Stripe if the process restarted
const secrets = new Map<string, string>();
async function clientSecretFor(piId: string) {
  return secrets.get(piId) ?? gateway.clientSecret(piId);
}

/** payment_intent.succeeded */
export async function onPaymentSucceeded(providerPaymentId: string) {
  const settings = await getSettings();
  const p = await prisma.payment.findUnique({ where: { providerPaymentId } });
  if (!p) return { ignored: 'unknown payment' };
  if (p.status === 'succeeded') return { ignored: 'already processed' };

  if (p.kind === 'booking' && p.bookingId) {
    const b = await prisma.booking.findUniqueOrThrow({ where: { id: p.bookingId }, include: { salon: true } });
    if (b.status === 'cancelled') {
      // hold expired before payment completed → refund automatically
      await prisma.payment.update({ where: { id: p.id }, data: { status: 'succeeded' } });
      await refundPayment(p.id, p.amountCents, 'Prenotazione scaduta prima del pagamento');
      return { refunded: true };
    }
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({ where: { id: p.id }, data: { status: 'succeeded' } });
      await tx.booking.update({ where: { id: b.id }, data: { status: 'booked', paidCents: p.amountCents, holdExpiresAt: null } });
      await recordSale(tx, { salonId: b.salonId, amountCents: p.amountCents, sourceType: 'booking', sourceId: b.id, description: `Prenotazione ${b.code} (online)`, availableAt: null });
    });
    await notify(b.customerId!, m('Prenotazione confermata', 'Booking confirmed'), m(`${b.salon.name} · ${b.date}. Codice ${b.code}.`, `${b.salon.name} · ${b.date}. Code ${b.code}.`), { link: `/account/prenotazioni`, email: true });
    await notify(b.salon.ownerId, m('Nuova prenotazione pagata', 'New paid booking'), m(`${b.customerName} · ${b.date} · codice ${b.code}`, `${b.customerName} · ${b.date} · code ${b.code}`), { link: '/seller/agenda' });
    return { ok: true };
  }

  if (p.kind === 'order' && p.orderId) {
    const o = await prisma.order.findUniqueOrThrow({ where: { id: p.orderId }, include: { subOrders: { include: { salon: true } } } });
    if (o.status === 'cancelled') {
      await prisma.payment.update({ where: { id: p.id }, data: { status: 'succeeded' } });
      await refundPayment(p.id, p.amountCents, 'Ordine scaduto prima del pagamento');
      return { refunded: true };
    }
    const at = new Date().toISOString();
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({ where: { id: p.id }, data: { status: 'succeeded' } });
      await tx.order.update({ where: { id: o.id }, data: { status: 'paid', holdExpiresAt: null } });
      for (const s of o.subOrders) {
        await tx.subOrder.update({ where: { id: s.id }, data: { status: 'received', timeline: [{ status: 'received', at }] } });
        // seller earns items + shipping − their own coupon share (platform coupons are paid by the platform)
        const gross = s.subtotalCents + s.shippingFeeCents - s.salonDiscountCents;
        await recordSale(tx, { salonId: s.salonId, amountCents: gross, sourceType: 'sub_order', sourceId: s.id, description: `Ordine ${s.code}`, availableAt: null });
      }
      if (o.couponCode) await tx.coupon.updateMany({ where: { code: o.couponCode }, data: { uses: { increment: 1 } } });
      await tx.user.update({ where: { id: o.customerId }, data: { loyaltyPoints: { increment: Math.floor(o.totalCents / 100) } } });
    });
    await notify(o.customerId, m('Ordine confermato', 'Order confirmed'), m(`Ordine ${o.code}: pagamento ricevuto.`, `Order ${o.code}: payment received.`), { link: `/account/ordini/${o.id}`, email: true });
    for (const s of o.subOrders) await notify(s.salon.ownerId, m('Nuovo ordine', 'New order'), m(`Ordine ${s.code} da preparare.`, `Order ${s.code} to prepare.`), { link: '/seller/ordini' });
    void settings;
    return { ok: true };
  }
  return { ignored: 'unknown kind' };
}

/** payment_intent.payment_failed / canceled */
export async function onPaymentFailed(providerPaymentId: string) {
  await prisma.payment.updateMany({ where: { providerPaymentId, status: 'requires_payment' }, data: { status: 'failed' } });
}

/**
 * Refund (full or partial) to the customer's card + negative ledger line(s).
 * For orders, pass subOrderId so the right salon is debited.
 */
export async function refundPayment(paymentId: string, amountCents: number, reason: string, opts: { subOrderId?: string; ledgerAmountCents?: number } = {}) {
  const p = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!p) throw notFound('Pagamento');
  if (!['succeeded', 'partially_refunded'].includes(p.status)) throw badRequest('Pagamento non rimborsabile', 'not_refundable');
  const left = p.amountCents - p.refundedCents;
  const amount = Math.min(amountCents, left);
  if (amount <= 0) throw badRequest('Già rimborsato', 'already_refunded');
  await gateway.refund({ paymentIntentId: p.providerPaymentId, amountCents: amount, reason, idempotencyKey: `refund-${p.id}-${p.refundedCents}-${amount}` });
  await prisma.$transaction(async (tx) => {
    const refunded = p.refundedCents + amount;
    await tx.payment.update({ where: { id: p.id }, data: { refundedCents: refunded, status: refunded >= p.amountCents ? 'refunded' : 'partially_refunded' } });
    if (p.kind === 'booking' && p.bookingId) {
      const b = await tx.booking.findUniqueOrThrow({ where: { id: p.bookingId } });
      const hasSale = await tx.ledgerEntry.count({ where: { sourceType: 'booking', sourceId: b.id, type: 'sale' } });
      if (hasSale) await recordRefund(tx, { salonId: b.salonId, amountCents: amount, sourceType: 'booking', sourceId: b.id, description: `Rimborso prenotazione ${b.code}` });
      await tx.booking.update({ where: { id: b.id }, data: { paidCents: Math.max(0, b.paidCents - amount) } });
    }
    if (p.kind === 'order' && opts.subOrderId) {
      const s = await tx.subOrder.findUniqueOrThrow({ where: { id: opts.subOrderId } });
      const hasSale = await tx.ledgerEntry.count({ where: { sourceType: 'sub_order', sourceId: s.id, type: 'sale' } });
      if (hasSale) await recordRefund(tx, { salonId: s.salonId, amountCents: opts.ledgerAmountCents ?? amount, sourceType: 'sub_order', sourceId: s.id, description: `Rimborso ordine ${s.code}` });
    }
  });
  return { refundedCents: amount };
}
