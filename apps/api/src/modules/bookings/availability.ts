/**
 * Server availability = the SHARED engine in packages/shared/src/slots.ts (same code the apps run),
 * fed with DB rows. The API re-runs it inside the booking transaction, so it stays authoritative.
 */
import type { Booking, Salon, Service, Staff, TimeWindow } from '@prisma/client';
import { windowBlocks } from './windows';
import { computeSlots as sharedSlots, SLOT_STEP, MAX_DAYS_AHEAD, MIN_LEAD_MIN } from '../../../../../packages/shared/src/slots';
import type { Tx } from '../../lib/prisma';

export { SLOT_STEP, MAX_DAYS_AHEAD, MIN_LEAD_MIN };

type Hours = { day: number; open: string | null; close: string | null }[];

export function computeSlots(opts: { salon: Salon; date: string; services: Service[]; staff: Staff[]; bookings: Booking[]; windows: TimeWindow[]; staffId?: string | null; now?: Date }) {
  const { salon, date, services, staff, bookings, windows, staffId, now } = opts;
  // a seller walk-in passes now = epoch 0 to allow times already passed today
  const ignorePast = !!now && now.getTime() === 0;
  return sharedSlots({
    salon: { hours: salon.hours as Hours },
    date,
    staffId,
    ignorePast,
    now: ignorePast ? undefined : now,
    services: services.map((s) => ({ id: s.id, durationMin: s.durationMin, bufferMin: s.bufferMin })),
    staff: staff.map((s) => ({ id: s.id, active: s.active, workingDays: (s.workingDays as number[]) ?? [], serviceIds: (s.serviceIds as string[]) ?? [] })),
    bookings: bookings.map((b) => ({ staffId: b.staffId, date: b.date, startMin: b.startMin, durationMin: b.durationMin, status: b.status, holdExpiresAt: b.holdExpiresAt, windowId: b.windowId })),
    windows: windowBlocks(windows),
  });
}

export async function loadAvailability(db: Tx, salonId: string, date: string, serviceIds: string[], staffId?: string | null, now = new Date()) {
  const [salon, services, staff, bookings, windows] = await Promise.all([
    db.salon.findUniqueOrThrow({ where: { id: salonId } }),
    db.service.findMany({ where: { id: { in: serviceIds }, salonId, active: true, deletedAt: null } }),
    db.staff.findMany({ where: { salonId } }),
    db.booking.findMany({ where: { salonId, date } }),
    db.timeWindow.findMany({ where: { salonId, date } }),
  ]);
  return { salon, services, staff, bookings, slots: computeSlots({ salon, date, services, staff, bookings, windows, staffId, now }) };
}
