/** Customer bookings: create (with slot lock), view, cancel, reschedule. */
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { ah, badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { sBooking, sSalonPublic, sService, sStaff } from '../../lib/serialize';
import { body } from '../../middleware/validate';
import { requireAuth, requireRole } from '../../middleware/auth';
import { humanCode } from '../../lib/ids';
import { addMinutes, bookingStart, isISODate, toHHMM, toMin } from '../../lib/time';
import { windowCheck, type WindowProblem } from '../../../../../packages/shared/src/slots';
import { placesTaken } from './windows';
import { getSettings } from '../../lib/settings';
import { notify } from '../../lib/notify';
import { computeSlots } from './availability';
import { createIntentForBooking, refundPayment } from '../payments/service';
import { scheduleRelease } from '../wallet/ledger';
import { gateway } from '../payments/gateway';
import { m } from '../../lib/i18n';

export const bookingsRouter = Router();

const createSchema = z.object({
  salonId: z.string().min(1),
  serviceIds: z.array(z.string()).min(1).max(6),
  staffId: z.string().nullish(),
  /** book a place in a salon time window instead of a normal slot (date/time then come from the window) */
  windowId: z.string().nullish(),
  date: z.string().refine(isISODate, 'Data non valida').optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/, 'Orario non valido').optional(),
  paymentMode: z.enum(['in_salon', 'deposit', 'card']).default('in_salon'),
  notes: z.string().max(500).optional(),
  pickupProductIds: z.array(z.string()).max(10).optional(),
}).refine((b) => !!b.windowId || (!!b.date && !!b.time), { message: 'Scegli data e orario', path: ['time'] });

const WINDOW_ERR: Record<WindowProblem, [string, string]> = {
  closed: ['Questa fascia non accetta più prenotazioni', 'window_closed'],
  full: ['Fascia al completo: i posti sono finiti', 'window_full'],
  past: ['Questa fascia è già iniziata', 'window_past'],
  service: ['Servizio non incluso in questa fascia', 'window_service'],
  too_long: ['I servizi scelti non entrano nella durata della fascia', 'window_too_long'],
};

/**
 * Locks the salon row, re-checks availability and inserts. Two customers racing for the same slot:
 * the second one waits for the lock, then sees the slot taken and gets 409 slot_taken.
 */
bookingsRouter.post(
  '/bookings',
  requireAuth,
  requireRole('customer'),
  body(createSchema),
  ah(async (req, res) => {
    const b = req.body as z.infer<typeof createSchema>;
    const settings = await getSettings();
    const customer = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.sub } });
    const holds = await prisma.booking.count({ where: { customerId: customer.id, status: 'awaiting_payment', holdExpiresAt: { gt: new Date() } } });
    if (holds >= 3) throw badRequest('Hai già 3 prenotazioni in attesa di pagamento', 'too_many_holds');

    const booking = await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM Salon WHERE id = ${b.salonId} FOR UPDATE`;
        const salon = await tx.salon.findUnique({ where: { id: b.salonId } });
        if (!salon || salon.status !== 'approved') throw notFound('Salone');
        const services = await tx.service.findMany({ where: { id: { in: b.serviceIds }, salonId: salon.id, active: true, deletedAt: null } });
        if (services.length !== new Set(b.serviceIds).size) throw badRequest('Uno o più servizi non disponibili', 'service_unavailable');

        let date: string, startMin: number, staffId: string | null, windowId: string | null = null;
        if (b.windowId) {
          // places are counted under the salon lock above, so two customers can't take the last place together
          const w = await tx.timeWindow.findUnique({ where: { id: b.windowId } });
          if (!w || w.salonId !== salon.id) throw notFound('Fascia');
          const taken = (await placesTaken(tx, [w.id])).get(w.id) ?? 0;
          const problem = windowCheck({ date: w.date, start: toHHMM(w.startMin), end: toHHMM(w.endMin), serviceIds: w.serviceIds as string[], capacity: w.capacity, booked: taken, open: w.open }, services);
          if (problem) { const [msg, code] = WINDOW_ERR[problem]; throw problem === 'full' ? conflict(msg, code) : badRequest(msg, code); }
          const mine = await tx.booking.count({ where: { windowId: w.id, customerId: customer.id, status: { notIn: ['cancelled', 'no_show'] } } });
          if (mine) throw conflict('Hai già un posto in questa fascia', 'window_already_booked');
          date = w.date; startMin = w.startMin; staffId = w.staffId; windowId = w.id;
        } else {
          date = b.date!;
          const [staff, dayBookings, windows] = await Promise.all([
            tx.staff.findMany({ where: { salonId: salon.id } }),
            tx.booking.findMany({ where: { salonId: salon.id, date } }),
            tx.timeWindow.findMany({ where: { salonId: salon.id, date } }),
          ]);
          const slot = computeSlots({ salon, date, services, staff, bookings: dayBookings, windows, staffId: b.staffId ?? null }).find((s) => s.time === b.time);
          if (!slot || !slot.free) throw conflict('Questo orario non è più disponibile, scegline un altro', 'slot_taken');
          staffId = b.staffId ?? slot.staffIds[0] ?? null;
          startMin = toMin(b.time!);
        }

        const total = services.reduce((a, s) => a + s.priceCents, 0);
        const depositCents = services.reduce((a, s) => a + Math.round((s.priceCents * s.depositPct) / 100), 0);
        let mode = b.paymentMode;
        if (mode === 'deposit' && depositCents === 0) mode = 'in_salon';
        const payable = mode === 'card' ? total : mode === 'deposit' ? depositCents : 0;
        const duration = services.reduce((a, s) => a + s.durationMin, 0) + services.reduce((a, s) => a + s.bufferMin, 0);

        return tx.booking.create({
          data: {
            code: humanCode('MB'), customerId: customer.id, customerName: customer.name, customerPhone: customer.phone, salonId: salon.id,
            staffId, windowId, serviceIds: services.map((s) => s.id), date, startMin, durationMin: duration, totalCents: total,
            depositCents: mode === 'deposit' ? depositCents : mode === 'card' ? total : 0, paymentMode: mode,
            status: payable > 0 ? 'awaiting_payment' : 'booked', notes: b.notes, pickupProductIds: b.pickupProductIds,
            holdExpiresAt: payable > 0 ? addMinutes(new Date(), settings.paymentHoldMinutes) : null,
          },
          include: { salon: true },
        });
      },
      { isolationLevel: 'ReadCommitted', timeout: 15_000 },
    );

    let payment: { clientSecret: string; amount: number; provider: string; paymentId: string } | null = null;
    if (booking.status === 'awaiting_payment') {
      const r = await createIntentForBooking(booking.id, customer.id);
      payment = { clientSecret: r.clientSecret, amount: r.payment.amountCents / 100, provider: gateway.mode, paymentId: r.payment.id };
    } else {
      const at = toHHMM(booking.startMin);
      await notify(customer.id, m('Prenotazione confermata', 'Booking confirmed'), m(`${booking.salon.name} · ${booking.date} alle ${at}. Codice ${booking.code}.`, `${booking.salon.name} · ${booking.date} at ${at}. Code ${booking.code}.`), { link: '/account/prenotazioni', email: true });
      await notify(booking.salon.ownerId, m('Nuova prenotazione', 'New booking'), m(`${customer.name} · ${booking.date} alle ${at}${booking.windowId ? ' (fascia)' : ''}`, `${customer.name} · ${booking.date} at ${at}${booking.windowId ? ' (time window)' : ''}`), { link: '/seller/agenda' });
    }
    res.status(201).json({ booking: sBooking(booking), payment });
  }),
);

bookingsRouter.get(
  '/bookings/:id',
  requireAuth,
  ah(async (req, res) => {
    const b = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { salon: true } });
    if (!b) throw notFound('Prenotazione');
    const isOwner = b.customerId === req.user!.sub || b.salon.ownerId === req.user!.sub || req.user!.role === 'admin';
    if (!isOwner) throw notFound('Prenotazione');
    const [services, staff] = await Promise.all([
      prisma.service.findMany({ where: { id: { in: b.serviceIds as string[] } } }),
      b.staffId ? prisma.staff.findUnique({ where: { id: b.staffId } }) : null,
    ]);
    res.json({ booking: sBooking(b), salon: sSalonPublic(b.salon), services: services.map(sService), staff: staff ? sStaff(staff) : null });
  }),
);

/** Payment for a booking still awaiting payment (e.g. app closed during checkout). */
bookingsRouter.post(
  '/bookings/:id/pay',
  requireAuth,
  ah(async (req, res) => {
    const b = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!b || b.customerId !== req.user!.sub) throw notFound('Prenotazione');
    if (b.holdExpiresAt && b.holdExpiresAt < new Date()) throw badRequest('Tempo per il pagamento scaduto, prenota di nuovo', 'hold_expired');
    const r = await createIntentForBooking(b.id, req.user!.sub);
    res.json({ clientSecret: r.clientSecret, amount: r.payment.amountCents / 100, provider: gateway.mode, paymentId: r.payment.id });
  }),
);

bookingsRouter.post(
  '/bookings/:id/cancel',
  requireAuth,
  body(z.object({ reason: z.string().max(300).optional() })),
  ah(async (req, res) => {
    const settings = await getSettings();
    const b = await prisma.booking.findUnique({ where: { id: req.params.id }, include: { salon: true } });
    if (!b || b.customerId !== req.user!.sub) throw notFound('Prenotazione');
    if (!['awaiting_payment', 'booked', 'confirmed'].includes(b.status)) throw badRequest('Questa prenotazione non può essere annullata', 'not_cancellable');
    const hoursLeft = (bookingStart(b.date, b.startMin).getTime() - Date.now()) / 3600_000;
    if (hoursLeft < 0) throw badRequest('Appuntamento già passato', 'in_past');
    const free = hoursLeft >= settings.freeCancellationHours;

    await prisma.booking.update({ where: { id: b.id }, data: { status: 'cancelled', cancelledAt: new Date(), holdExpiresAt: null } });
    const payment = await prisma.payment.findFirst({ where: { bookingId: b.id, status: { in: ['succeeded', 'partially_refunded'] } } });
    let refunded = 0;
    if (payment && free) {
      refunded = (await refundPayment(payment.id, payment.amountCents - payment.refundedCents, 'Cancellazione cliente nei termini')).refundedCents;
    }
    // late cancellation: deposit is kept by the salon → becomes withdrawable now. Refunded: sale and refund net out.
    await scheduleRelease(prisma, 'booking', b.id, new Date());
    const pending = await prisma.payment.findFirst({ where: { bookingId: b.id, status: 'requires_payment' } });
    if (pending) {
      await gateway.cancelPaymentIntent(pending.providerPaymentId);
      await prisma.payment.update({ where: { id: pending.id }, data: { status: 'cancelled' } });
    }
    await notify(b.salon.ownerId, m('Prenotazione annullata', 'Booking cancelled'), m(`${b.customerName} ha annullato ${b.date} (${b.code}).${req.body.reason ? ' Motivo: ' + req.body.reason : ''}`, `${b.customerName} cancelled ${b.date} (${b.code}).${req.body.reason ? ' Reason: ' + req.body.reason : ''}`), { link: '/seller/agenda' });
    res.json({ ok: true, refunded: refunded / 100, lateCancellation: !free && b.paidCents > 0 });
  }),
);

bookingsRouter.post(
  '/bookings/:id/reschedule',
  requireAuth,
  body(z.object({ date: z.string().refine(isISODate), time: z.string().regex(/^\d{2}:\d{2}$/), staffId: z.string().nullish() })),
  ah(async (req, res) => {
    const settings = await getSettings();
    const existing = await prisma.booking.findUnique({ where: { id: req.params.id } });
    if (!existing || existing.customerId !== req.user!.sub) throw notFound('Prenotazione');
    if (!['booked', 'confirmed'].includes(existing.status)) throw badRequest('Questa prenotazione non può essere spostata', 'not_reschedulable');
    if (existing.windowId) throw badRequest('Le prenotazioni in una fascia non si spostano: annulla e prenota di nuovo', 'window_booking');
    const hoursLeft = (bookingStart(existing.date, existing.startMin).getTime() - Date.now()) / 3600_000;
    if (hoursLeft < settings.freeCancellationHours) throw forbidden(`Puoi spostare l’appuntamento fino a ${settings.freeCancellationHours} ore prima`, 'too_late');

    const updated = await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM Salon WHERE id = ${existing.salonId} FOR UPDATE`;
        const salon = await tx.salon.findUniqueOrThrow({ where: { id: existing.salonId } });
        const [services, staff, dayBookings, windows] = await Promise.all([
          tx.service.findMany({ where: { id: { in: existing.serviceIds as string[] } } }),
          tx.staff.findMany({ where: { salonId: salon.id } }),
          tx.booking.findMany({ where: { salonId: salon.id, date: req.body.date, id: { not: existing.id } } }),
          tx.timeWindow.findMany({ where: { salonId: salon.id, date: req.body.date } }),
        ]);
        const staffId = req.body.staffId === undefined ? existing.staffId : req.body.staffId;
        const slot = computeSlots({ salon, date: req.body.date, services, staff, bookings: dayBookings, windows, staffId }).find((s) => s.time === req.body.time);
        if (!slot?.free) throw conflict('Orario non disponibile', 'slot_taken');
        return tx.booking.update({ where: { id: existing.id }, data: { date: req.body.date, startMin: toMin(req.body.time), staffId: staffId ?? slot.staffIds[0] ?? null }, include: { salon: true } });
      },
      { isolationLevel: 'ReadCommitted', timeout: 15_000 },
    );
    await notify(updated.salon.ownerId, m('Prenotazione spostata', 'Booking moved'), m(`${updated.customerName} → ${updated.date} alle ${req.body.time} (${updated.code})`, `${updated.customerName} → ${updated.date} at ${req.body.time} (${updated.code})`), { link: '/seller/agenda' });
    res.json(sBooking(updated));
  }),
);
