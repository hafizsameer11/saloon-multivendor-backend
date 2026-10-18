/**
 * Salon time windows (seller side).
 *  GET    /seller/windows?from&to         list with places taken
 *  POST   /seller/windows                 create one window per matching day in a date range (bulk)
 *  PATCH  /seller/windows/:id             places / services / note / open-closed
 *  DELETE /seller/windows/:id             only while nobody booked it
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Salon } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, badRequest, conflict, notFound } from '../../lib/errors';
import { sWindow } from '../../lib/serialize';
import { body, query, q } from '../../middleware/validate';
import { requireSalon } from '../../middleware/auth';
import { addDays, isISODate, parseISODate, toISODate, toMin, weekdayIdx } from '../../lib/time';
import { placesTaken } from '../bookings/windows';

export const sellerWindowsRouter = Router();

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Orario non valido');
const MAX_AHEAD = 90;
const MAX_PER_REQUEST = 120;

const listQ = z.object({ from: z.string().refine(isISODate).optional(), to: z.string().refine(isISODate).optional() });
sellerWindowsRouter.get(
  '/windows',
  requireSalon(),
  query(listQ),
  ah(async (_req, res) => {
    const salon = res.locals.salon as Salon;
    const f = q(res, listQ);
    const from = f.from ?? toISODate(new Date());
    const to = f.to ?? toISODate(addDays(new Date(), MAX_AHEAD));
    const rows = await prisma.timeWindow.findMany({ where: { salonId: salon.id, date: { gte: from, lte: to } }, orderBy: [{ date: 'asc' }, { startMin: 'asc' }] });
    const taken = await placesTaken(prisma, rows.map((w) => w.id));
    res.json(rows.map((w) => sWindow(w, taken.get(w.id) ?? 0)));
  }),
);

async function checkServices(salonId: string, ids: string[], lengthMin: number) {
  const svc = await prisma.service.findMany({ where: { id: { in: ids }, salonId, deletedAt: null } });
  if (svc.length !== new Set(ids).size) throw badRequest('Uno o più servizi non validi', 'service_unavailable');
  const tooLong = svc.filter((s) => s.durationMin > lengthMin);
  if (tooLong.length) throw badRequest(`Durano più della fascia: ${tooLong.map((s) => s.name).join(', ')}`, 'window_too_short');
}

const createSchema = z
  .object({
    from: z.string().refine(isISODate, 'Data non valida'),
    to: z.string().refine(isISODate, 'Data non valida').optional(),
    /** 0 = Monday … 6 = Sunday; empty/missing = every day in the range */
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    start: HHMM,
    end: HHMM,
    serviceIds: z.array(z.string()).min(1, 'Scegli almeno un servizio').max(30),
    capacity: z.number().int().min(1, 'Almeno 1 posto').max(50),
    staffId: z.string().nullish(),
    note: z.string().trim().max(120).optional(),
  })
  .refine((b) => toMin(b.end) - toMin(b.start) >= 15, { message: 'La fascia deve durare almeno 15 minuti', path: ['end'] });

sellerWindowsRouter.post(
  '/windows',
  requireSalon(),
  body(createSchema),
  ah(async (req, res) => {
    const salon = res.locals.salon as Salon;
    const b = req.body as z.infer<typeof createSchema>;
    const today = toISODate(new Date());
    const last = toISODate(addDays(new Date(), MAX_AHEAD));
    const to = b.to ?? b.from;
    if (b.from < today) throw badRequest('La data di inizio è già passata', 'in_past');
    if (to < b.from) throw badRequest('La data di fine è prima di quella di inizio', 'bad_range');
    if (to > last) throw badRequest(`Puoi creare fasce fino a ${MAX_AHEAD} giorni da oggi`, 'too_far');
    const startMin = toMin(b.start), endMin = toMin(b.end);
    await checkServices(salon.id, b.serviceIds, endMin - startMin);
    if (b.staffId) {
      const st = await prisma.staff.findFirst({ where: { id: b.staffId, salonId: salon.id, active: true } });
      if (!st) throw badRequest('Operatore non valido', 'bad_staff');
    }

    const days: string[] = [];
    for (let d = parseISODate(b.from); toISODate(d) <= to; d = addDays(d, 1)) {
      if (!b.weekdays?.length || b.weekdays.includes(weekdayIdx(d))) days.push(toISODate(d));
    }
    if (!days.length) throw badRequest('Nessun giorno corrisponde ai giorni della settimana scelti', 'no_days');
    if (days.length > MAX_PER_REQUEST) throw badRequest(`Massimo ${MAX_PER_REQUEST} fasce alla volta`, 'too_many');

    // per day: skip exact duplicates, and (staff windows) clashes with that person's other windows or bookings
    const overlaps = (aS: number, aE: number, bS: number, bE: number) => aS < bE && bS < aE;
    const [existing, staffBookings] = await Promise.all([
      prisma.timeWindow.findMany({ where: { salonId: salon.id, date: { in: days } } }),
      b.staffId
        ? prisma.booking.findMany({ where: { salonId: salon.id, staffId: b.staffId, date: { in: days }, windowId: null, status: { notIn: ['cancelled', 'no_show'] } } })
        : Promise.resolve([]),
    ]);
    const skipped: { date: string; reason: string }[] = [];
    const toCreate: string[] = [];
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    for (const date of days) {
      if (date === today && startMin <= nowMin) { skipped.push({ date, reason: 'past' }); continue; }
      const same = existing.filter((w) => w.date === date);
      if (same.some((w) => w.startMin === startMin && w.endMin === endMin && w.staffId === (b.staffId ?? null))) { skipped.push({ date, reason: 'duplicate' }); continue; }
      if (b.staffId && same.some((w) => w.staffId === b.staffId && overlaps(startMin, endMin, w.startMin, w.endMin))) { skipped.push({ date, reason: 'staff_window' }); continue; }
      if (b.staffId && staffBookings.some((x) => x.date === date && overlaps(startMin, endMin, x.startMin, x.startMin + x.durationMin))) { skipped.push({ date, reason: 'staff_booked' }); continue; }
      toCreate.push(date);
    }
    if (toCreate.length) {
      await prisma.timeWindow.createMany({
        data: toCreate.map((date) => ({ salonId: salon.id, date, startMin, endMin, serviceIds: b.serviceIds, capacity: b.capacity, staffId: b.staffId ?? null, note: b.note ?? '' })),
      });
    }
    const created = await prisma.timeWindow.findMany({ where: { salonId: salon.id, date: { in: toCreate }, startMin, endMin, staffId: b.staffId ?? null }, orderBy: { date: 'asc' } });
    res.status(201).json({ created: created.map((w) => sWindow(w, 0)), skipped });
  }),
);

const patchSchema = z.object({
  capacity: z.number().int().min(1).max(50).optional(),
  serviceIds: z.array(z.string()).min(1).max(30).optional(),
  note: z.string().trim().max(120).optional(),
  open: z.boolean().optional(),
});
sellerWindowsRouter.patch(
  '/windows/:id',
  requireSalon(),
  body(patchSchema),
  ah(async (req, res) => {
    const salon = res.locals.salon as Salon;
    const p = req.body as z.infer<typeof patchSchema>;
    const w = await prisma.timeWindow.findUnique({ where: { id: req.params.id } });
    if (!w || w.salonId !== salon.id) throw notFound('Fascia');
    const taken = (await placesTaken(prisma, [w.id])).get(w.id) ?? 0;
    if (p.capacity !== undefined && p.capacity < taken) throw badRequest(`Ci sono già ${taken} prenotazioni: i posti non possono essere meno di ${taken}`, 'capacity_below_booked');
    if (p.serviceIds) await checkServices(salon.id, p.serviceIds, w.endMin - w.startMin);
    const updated = await prisma.timeWindow.update({ where: { id: w.id }, data: p });
    res.json(sWindow(updated, taken));
  }),
);

sellerWindowsRouter.delete(
  '/windows/:id',
  requireSalon(),
  ah(async (req, res) => {
    const salon = res.locals.salon as Salon;
    const w = await prisma.timeWindow.findUnique({ where: { id: req.params.id } });
    if (!w || w.salonId !== salon.id) throw notFound('Fascia');
    const active = await prisma.booking.count({ where: { windowId: w.id, status: { not: 'cancelled' } } });
    if (active) throw conflict('Ci sono prenotazioni in questa fascia: chiudila invece di eliminarla', 'window_has_bookings');
    await prisma.timeWindow.delete({ where: { id: w.id } });
    res.json({ ok: true });
  }),
);
