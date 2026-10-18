/** Salon time windows: helpers shared by the booking, catalog and seller routes. */
import type { TimeWindow } from '@prisma/client';
import type { Tx } from '../../lib/prisma';
import { toHHMM } from '../../lib/time';
import type { SlotWindowBlock } from '../../../../../packages/shared/src/slots';

/** Windows tied to a staff member block that person's normal slots for the whole window. */
export const windowBlocks = (rows: TimeWindow[]): SlotWindowBlock[] =>
  rows.map((w) => ({ staffId: w.staffId, date: w.date, start: toHHMM(w.startMin), end: toHHMM(w.endMin) }));

/** Places taken per window: bookings not cancelled / no-show and not an expired unpaid hold. */
export async function placesTaken(db: Tx, windowIds: string[], now = new Date()): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!windowIds.length) return out;
  const rows = await db.booking.groupBy({
    by: ['windowId'],
    where: {
      windowId: { in: windowIds },
      status: { notIn: ['cancelled', 'no_show'] },
      OR: [{ status: { not: 'awaiting_payment' } }, { holdExpiresAt: null }, { holdExpiresAt: { gte: now } }],
    },
    _count: { _all: true },
  });
  for (const r of rows) if (r.windowId) out.set(r.windowId, r._count._all);
  return out;
}
