/**
 * Salon time windows — planning rules + texts shared by web and mobile.
 * The API applies the same rules in apps/api/src/modules/seller/windows.ts (authoritative).
 */
import type { Booking, Service, TimeWindow } from './types';
import type { WindowProblem } from './slots';

export interface WindowInput {
  from: string; to?: string; weekdays?: number[]; // 0 = Mon … 6 = Sun; empty = every day
  start: string; end: string; serviceIds: string[]; capacity: number; staffId?: string | null; note?: string;
}
export type WindowSkip = 'duplicate' | 'staff_window' | 'staff_booked' | 'past';
export type WindowPlanError = 'in_past' | 'bad_range' | 'too_far' | 'too_short' | 'no_services' | 'window_too_short' | 'no_days' | 'too_many' | 'bad_capacity';

const p2 = (n: number) => String(n).padStart(2, '0');
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const iso = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const parse = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const overlaps = (aS: number, aE: number, bS: number, bE: number) => aS < bE && bS < aE;

export function planWindows(
  input: WindowInput,
  ctx: { services: Pick<Service, 'id' | 'name' | 'durationMin'>[]; existing: TimeWindow[]; bookings: Booking[]; now?: Date },
): { error: WindowPlanError; detail?: string } | { dates: string[]; skipped: { date: string; reason: WindowSkip }[] } {
  const now = ctx.now ?? new Date();
  const today = iso(now);
  const last = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 90));
  const to = input.to || input.from;
  const s = toMin(input.start), e = toMin(input.end);
  if (input.from < today) return { error: 'in_past' };
  if (to < input.from) return { error: 'bad_range' };
  if (to > last) return { error: 'too_far' };
  if (e - s < 15) return { error: 'too_short' };
  if (!input.serviceIds.length) return { error: 'no_services' };
  if (!(input.capacity >= 1 && input.capacity <= 50)) return { error: 'bad_capacity' };
  const long = ctx.services.filter((x) => input.serviceIds.includes(x.id) && x.durationMin > e - s);
  if (long.length) return { error: 'window_too_short', detail: long.map((x) => x.name).join(', ') };
  const days: string[] = [];
  for (let d = parse(input.from); iso(d) <= to; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    if (!input.weekdays?.length || input.weekdays.includes((d.getDay() + 6) % 7)) days.push(iso(d));
  }
  if (!days.length) return { error: 'no_days' };
  if (days.length > 120) return { error: 'too_many' };
  const staffId = input.staffId ?? null;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const dates: string[] = [];
  const skipped: { date: string; reason: WindowSkip }[] = [];
  for (const date of days) {
    const same = ctx.existing.filter((w) => w.date === date);
    if (date === today && s <= nowMin) skipped.push({ date, reason: 'past' });
    else if (same.some((w) => toMin(w.start) === s && toMin(w.end) === e && w.staffId === staffId)) skipped.push({ date, reason: 'duplicate' });
    else if (staffId && same.some((w) => w.staffId === staffId && overlaps(s, e, toMin(w.start), toMin(w.end)))) skipped.push({ date, reason: 'staff_window' });
    else if (staffId && ctx.bookings.some((b) => b.staffId === staffId && b.date === date && !b.windowId && b.status !== 'cancelled' && b.status !== 'no_show' && overlaps(s, e, toMin(b.time), toMin(b.time) + b.durationMin))) skipped.push({ date, reason: 'staff_booked' });
    else dates.push(date);
  }
  return { dates, skipped };
}

type Txt = Record<string, [string, string]>;
/** [it, en] */
export const WINDOW_TEXT: Txt = {
  // planning errors
  in_past: ['La data di inizio è già passata', 'The start date has already passed'],
  bad_range: ['La data di fine è prima di quella di inizio', 'The end date is before the start date'],
  too_far: ['Puoi creare fasce fino a 90 giorni da oggi', 'You can create windows up to 90 days ahead'],
  too_short: ['La fascia deve durare almeno 15 minuti', 'A window must last at least 15 minutes'],
  no_services: ['Scegli almeno un servizio', 'Choose at least one service'],
  bad_capacity: ['I posti vanno da 1 a 50', 'Places must be between 1 and 50'],
  window_too_short: ['Questi servizi durano più della fascia', 'These services last longer than the window'],
  no_days: ['Nessun giorno corrisponde ai giorni della settimana scelti', 'No day matches the chosen weekdays'],
  too_many: ['Massimo 120 fasce alla volta', 'At most 120 windows at a time'],
  // skipped days
  duplicate: ['esiste già', 'already exists'],
  staff_window: ['l’operatore ha già una fascia', 'the stylist already has a window'],
  staff_booked: ['l’operatore ha già appuntamenti', 'the stylist already has bookings'],
  past: ['orario già passato', 'time already passed'],
  // booking problems (WindowProblem)
  closed: ['Fascia chiusa', 'Window closed'],
  full: ['Al completo', 'Full'],
  service: ['Servizio non incluso', 'Service not included'],
  too_long: ['I servizi scelti non entrano nella fascia', 'The chosen services don’t fit in the window'],
};
export const windowText = (code: WindowPlanError | WindowSkip | WindowProblem | string, lang: 'it' | 'en') => (WINDOW_TEXT[code]?.[lang === 'it' ? 0 : 1] ?? code);

export const WEEKDAY_LONG: Record<'it' | 'en', string[]> = {
  it: ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica'],
  en: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
};
