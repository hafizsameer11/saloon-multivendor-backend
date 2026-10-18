/**
 * Scheduled jobs (node-cron, Europe/Rome). Run them on ONE instance only (RUN_JOBS=true).
 * Each job is also exported so it can be run from tests or by hand.
 */
import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { getSettings } from '../lib/settings';
import { notify } from '../lib/notify';
import { addDays, toHHMM, toISODate } from '../lib/time';
import { gateway } from '../modules/payments/gateway';
import { releaseDue, scheduleRelease } from '../modules/wallet/ledger';
import { autoWithdrawOld } from '../modules/wallet/withdrawals';
import { m } from '../lib/i18n';

/** Unpaid booking holds / orders past their deadline are cancelled; order stock is put back. */
export async function expireHolds(now = new Date()) {
  const bookings = await prisma.booking.findMany({ where: { status: 'awaiting_payment', holdExpiresAt: { lt: now } } });
  for (const b of bookings) {
    await prisma.booking.update({ where: { id: b.id }, data: { status: 'cancelled', cancelledAt: now } });
    const p = await prisma.payment.findFirst({ where: { bookingId: b.id, status: 'requires_payment' } });
    if (p) {
      await gateway.cancelPaymentIntent(p.providerPaymentId);
      await prisma.payment.update({ where: { id: p.id }, data: { status: 'cancelled' } });
    }
  }
  const orders = await prisma.order.findMany({ where: { status: 'pending_payment', holdExpiresAt: { lt: now } }, include: { subOrders: true } });
  for (const o of orders) {
    await prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: o.id }, data: { status: 'cancelled' } });
      await tx.subOrder.updateMany({ where: { orderId: o.id }, data: { status: 'cancelled' } });
      for (const s of o.subOrders)
        for (const it of s.items as { productId: string; variantId?: string; qty: number }[]) {
          await tx.product.update({ where: { id: it.productId }, data: { stock: { increment: it.qty }, sold: { decrement: it.qty } } });
          if (it.variantId) await tx.productVariant.updateMany({ where: { id: it.variantId }, data: { stock: { increment: it.qty } } });
        }
    });
    const p = await prisma.payment.findFirst({ where: { orderId: o.id, status: 'requires_payment' } });
    if (p) {
      await gateway.cancelPaymentIntent(p.providerPaymentId);
      await prisma.payment.update({ where: { id: p.id }, data: { status: 'cancelled' } });
    }
  }
  return { bookings: bookings.length, orders: orders.length };
}

/** Shipped parcels the seller never marked as delivered are considered delivered after N days. */
export async function autoDeliver(now = new Date()) {
  const s = await getSettings();
  const limit = addDays(now, -s.autoDeliverAfterDays);
  const subs = await prisma.subOrder.findMany({ where: { status: 'shipped', shippedAt: { lt: limit } } });
  for (const so of subs) {
    await prisma.subOrder.update({ where: { id: so.id }, data: { status: 'delivered', deliveredAt: now, timeline: [...(so.timeline as object[]), { status: 'delivered', at: now.toISOString() }] } });
    await scheduleRelease(prisma, 'sub_order', so.id, addDays(now, s.returnWindowDays));
  }
  return subs.length;
}

/** Evening reminder for tomorrow's appointments. */
export async function sendReminders(now = new Date()) {
  const tomorrow = toISODate(addDays(now, 1));
  const rows = await prisma.booking.findMany({ where: { date: tomorrow, status: { in: ['booked', 'confirmed'] }, customerId: { not: null } }, include: { salon: true } });
  for (const b of rows) await notify(b.customerId!, m('Promemoria appuntamento', 'Appointment reminder'), m(`Domani alle ${toHHMM(b.startMin)} da ${b.salon.name}, ${b.salon.address}.`, `Tomorrow at ${toHHMM(b.startMin)} at ${b.salon.name}, ${b.salon.address}.`), { link: '/account/prenotazioni', email: true });
  return rows.length;
}

const safe = (name: string, fn: () => Promise<unknown>) => async () => {
  try {
    const r = await fn();
    if (r && (typeof r === 'number' ? r > 0 : true)) console.log(`[job] ${name}`, typeof r === 'object' ? JSON.stringify(r) : r);
  } catch (e) {
    console.error(`[job] ${name} failed`, e);
  }
};

export function startJobs() {
  const tz = 'Europe/Rome';
  cron.schedule('* * * * *', safe('expireHolds', () => expireHolds()), { timezone: tz });
  cron.schedule('*/10 * * * *', safe('releaseDue', () => releaseDue()), { timezone: tz });
  cron.schedule('5 * * * *', safe('autoDeliver', () => autoDeliver()), { timezone: tz });
  cron.schedule('15 3 * * *', safe('autoWithdrawOld', () => autoWithdrawOld()), { timezone: tz });
  cron.schedule('0 18 * * *', safe('sendReminders', () => sendReminders()), { timezone: tz });
  console.log('⏱  jobs scheduled: expireHolds(1m) releaseDue(10m) autoDeliver(1h) autoWithdraw(03:15) reminders(18:00)');
}
