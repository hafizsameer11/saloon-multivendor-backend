/**
 * THE availability engine — used by the API (authoritative, at booking time) AND by web/mobile (display).
 * One implementation so the apps never offer a time the server would refuse.
 *
 *  - grid of SLOT_STEP minutes from opening time; the whole service must end before closing
 *  - occupied time = Σ duration + Σ buffer of the chosen services
 *  - a slot is free if at least one ELIGIBLE staff member has no overlapping booking
 *    eligible = active, works that weekday (0=Mon…6=Sun), can do every chosen service (empty list = all)
 *  - bookings without staff (walk-ins) take one person of capacity; salons without staff = one chair
 *  - cancelled / no-show bookings and EXPIRED unpaid holds don't block
 *  - today: nothing earlier than now + MIN_LEAD_MIN (Italian time)
 *  - TIME WINDOWS (salon-made blocks with N places, see windowCheck below):
 *      bookings made inside a window never use normal capacity (they carry windowId);
 *      a window given to a staff member blocks that person for the whole window, booked or not.
 */
export const SLOT_STEP = 30;
export const MIN_LEAD_MIN = 30;
export const MAX_DAYS_AHEAD = 90;

export interface SlotSalon { hours: { day: number; open: string | null; close: string | null }[] }
export interface SlotService { id: string; durationMin: number; bufferMin?: number }
export interface SlotStaff { id: string; active: boolean; workingDays: number[]; serviceIds?: string[] }
export interface SlotBooking {
  staffId: string | null;
  date: string;
  /** "HH:mm" (apps) or startMin (API rows) */
  time?: string;
  startMin?: number;
  durationMin: number;
  status: string;
  holdExpiresAt?: string | Date | null;
  /** booked inside a salon time window → never uses normal capacity */
  windowId?: string | null;
}
/** What the engine needs from a time window: when, and who it ties up (staffId null = extra capacity). */
export interface SlotWindowBlock { staffId: string | null; date: string; start: string; end: string }
export interface Slot { time: string; free: boolean; staffIds: string[] }

const p2 = (n: number) => String(n).padStart(2, '0');
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const toHHMM = (m: number) => `${p2(Math.floor(m / 60))}:${p2(m % 60)}`;
const dayIndex = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};
/** Monday = 0 … Sunday = 6, from an ISO date (timezone-proof) */
export const isoWeekday = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
};

/** Current wall-clock time in Italy, whatever the device timezone is. */
export function romeNow(now = new Date()): { date: string; minutes: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const g = (t: string) => parts.find((x) => x.type === t)?.value ?? '00';
    return { date: `${g('year')}-${g('month')}-${g('day')}`, minutes: Number(g('hour')) * 60 + Number(g('minute')) };
  } catch {
    return { date: `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`, minutes: now.getHours() * 60 + now.getMinutes() };
  }
}

export function eligibleStaff<S extends SlotStaff>(staff: S[], date: string, serviceIds: string[]): S[] {
  const wd = isoWeekday(date);
  return staff.filter((s) => s.active && (s.workingDays ?? []).includes(wd) && (!s.serviceIds?.length || serviceIds.every((id) => s.serviceIds!.includes(id))));
}

export function computeSlots(o: {
  salon: SlotSalon; date: string; services: SlotService[]; staff: SlotStaff[]; bookings: SlotBooking[];
  staffId?: string | null; now?: Date; ignorePast?: boolean; windows?: SlotWindowBlock[];
}): Slot[] {
  const { salon, date, services, staff, bookings, staffId } = o;
  const now = o.now ?? new Date();
  const rome = romeNow(now);
  const diff = dayIndex(date) - dayIndex(rome.date);
  if (!o.ignorePast && (diff < 0 || diff > MAX_DAYS_AHEAD)) return [];
  const h = salon.hours.find((x) => x.day === isoWeekday(date));
  if (!h?.open || !h.close) return [];
  const open = toMin(h.open), close = toMin(h.close);
  const duration = services.reduce((a, s) => a + s.durationMin, 0);
  const occupied = duration + services.reduce((a, s) => a + (s.bufferMin ?? 0), 0);
  if (duration <= 0) return [];

  const ids = services.map((s) => s.id).filter((id) => id !== '_any');
  let people = eligibleStaff(staff, date, ids);
  if (staffId) people = people.filter((p) => p.id === staffId);
  const noStaffSalon = !staff.some((s) => s.active);
  if (staffId && !people.length) return [];

  const nowMs = now.getTime();
  const blocks: SlotBooking[] = (o.windows ?? [])
    .filter((w) => w.staffId && w.date === date)
    .map((w) => ({ staffId: w.staffId, date, startMin: toMin(w.start), durationMin: toMin(w.end) - toMin(w.start), status: 'booked' }));
  const live = [...bookings, ...blocks].filter((b) => {
    if (b.windowId) return false;
    if (b.date !== date || b.status === 'cancelled' || b.status === 'no_show') return false;
    if (b.status === 'awaiting_payment' && b.holdExpiresAt && new Date(b.holdExpiresAt).getTime() < nowMs) return false;
    return true;
  });
  const start = (b: SlotBooking) => b.startMin ?? toMin(b.time ?? '00:00');
  const out: Slot[] = [];
  for (let m = open; m + duration <= close; m += SLOT_STEP) {
    const end = m + occupied;
    const overlaps = (b: SlotBooking) => m < start(b) + b.durationMin && start(b) < end;
    const freeStaff = people.filter((p) => !live.some((b) => b.staffId === p.id && overlaps(b)));
    const anonymous = live.filter((b) => !b.staffId && overlaps(b)).length;
    let free = noStaffSalon ? anonymous === 0 : freeStaff.length - (staffId ? 0 : anonymous) > 0;
    if (!o.ignorePast && diff === 0 && m < rome.minutes + MIN_LEAD_MIN) free = false;
    out.push({ time: toHHMM(m), free, staffIds: free ? freeStaff.map((s) => s.id) : [] });
  }
  return out;
}

// ─────────────────────────── time windows ───────────────────────────
/**
 * A block of time the salon opens on purpose (e.g. Sat 13:00–14:00, 4 places, services A/B/C/D).
 * Each booking takes one place; the services booked must fit inside the window.
 */
export interface WindowLike {
  date: string; start: string; end: string; serviceIds: string[]; capacity: number; booked: number; open: boolean;
}
export type WindowProblem = 'closed' | 'full' | 'past' | 'service' | 'too_long';

/** Can these services be booked in this window right now? null = yes. Same rules on server and apps. */
export function windowCheck(w: WindowLike, services: SlotService[], now = new Date()): WindowProblem | null {
  if (!w.open) return 'closed';
  if (w.booked >= w.capacity) return 'full';
  const rome = romeNow(now);
  const diff = dayIndex(w.date) - dayIndex(rome.date);
  if (diff < 0 || (diff === 0 && toMin(w.start) < rome.minutes + MIN_LEAD_MIN)) return 'past';
  if (!services.length || services.some((s) => !w.serviceIds.includes(s.id))) return 'service';
  const need = services.reduce((a, s) => a + s.durationMin, 0);
  if (need > toMin(w.end) - toMin(w.start)) return 'too_long';
  return null;
}
export const windowPlacesLeft = (w: Pick<WindowLike, 'capacity' | 'booked'>) => Math.max(0, w.capacity - w.booked);
/** Bookings that hold a place in a window: not cancelled / no-show / expired unpaid hold. */
export function holdsPlace(b: { status: string; holdExpiresAt?: string | Date | null }, now = new Date()) {
  if (b.status === 'cancelled' || b.status === 'no_show') return false;
  if (b.status === 'awaiting_payment' && b.holdExpiresAt && new Date(b.holdExpiresAt).getTime() < now.getTime()) return false;
  return true;
}
