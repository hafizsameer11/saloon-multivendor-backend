import { computeSlots, holdsPlace } from './slots';
import type { Booking, Salon, Service, Staff, TimeWindow, SubOrderStatus, BookingStatus, SalonStatus, ProductStatus } from './types';

export const eur = (n: number, lang: 'it' | 'en' = 'it') =>
  new Intl.NumberFormat(lang === 'it' ? 'it-IT' : 'en-IE', { style: 'currency', currency: 'EUR', minimumFractionDigits: n % 1 === 0 ? 0 : 2 }).format(n);

export const pad2 = (n: number) => String(n).padStart(2, '0');
export const toISO = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const parseISO = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const minutes = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
export const hhmm = (m: number) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;

const DAYS_IT = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
const DAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_IT = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dayShort = (d: Date, lang: 'it' | 'en') => (lang === 'it' ? DAYS_IT : DAYS_EN)[d.getDay()];
export const monthShort = (d: Date, lang: 'it' | 'en') => (lang === 'it' ? MONTHS_IT : MONTHS_EN)[d.getMonth()];
export const fmtDate = (iso: string, lang: 'it' | 'en' = 'it') => {
  const d = iso.length === 10 ? parseISO(iso) : new Date(iso);
  return `${dayShort(d, lang)} ${d.getDate()} ${monthShort(d, lang)} ${d.getFullYear()}`;
};
export const fmtDateShort = (iso: string, lang: 'it' | 'en' = 'it') => {
  const d = iso.length === 10 ? parseISO(iso) : new Date(iso);
  return `${d.getDate()} ${monthShort(d, lang)}`;
};

/** Monday-based weekday index used in OpeningHours (0=Mon..6=Sun) */
export const weekdayIdx = (d: Date) => (d.getDay() + 6) % 7;

/**
 * Availability for the apps — thin wrapper over the shared engine in slots.ts (same code the API uses).
 * Pass `services` when known so buffers and staff skills are respected exactly like on the server.
 */
export function availableSlots(opts: {
  salon: Salon; date: string; durationMin: number; staffId: string | null; staff: Staff[]; bookings: Booking[]; now?: Date; step?: number;
  services?: Pick<Service, 'id' | 'durationMin' | 'bufferMin'>[];
  /** salon time windows (demo mode). In API mode the server already folds them into the busy list. */
  windows?: TimeWindow[];
}): { time: string; free: boolean; staffIds: string[] }[] {
  const { salon, date, durationMin, staffId, staff, bookings, now, services, windows } = opts;
  const ignorePast = !!now && now.getTime() === 0;
  return computeSlots({
    salon, date, staffId,
    services: services?.length ? services : [{ id: '_any', durationMin }],
    staff: staff.filter((s) => s.salonId === salon.id),
    bookings: bookings.filter((b) => b.salonId === salon.id),
    windows: windows?.filter((w) => w.salonId === salon.id),
    now: ignorePast ? undefined : now,
    ignorePast,
  });
}

export const bookingTotal = (services: Service[]) => ({
  price: services.reduce((a, s) => a + s.price, 0),
  duration: services.reduce((a, s) => a + s.durationMin, 0),
  deposit: Math.round(services.reduce((a, s) => a + (s.price * s.depositPct) / 100, 0) * 100) / 100,
});

export const BOOKING_STATUS: Record<BookingStatus, { it: string; en: string; tone: 'gold' | 'ok' | 'red' | 'mute' | 'warn' }> = {
  awaiting_payment: { it: 'In attesa di pagamento', en: 'Awaiting payment', tone: 'warn' },
  booked: { it: 'Prenotato', en: 'Booked', tone: 'gold' },
  confirmed: { it: 'Confermato', en: 'Confirmed', tone: 'ok' },
  in_progress: { it: 'In corso', en: 'In progress', tone: 'warn' },
  completed: { it: 'Completato', en: 'Completed', tone: 'mute' },
  no_show: { it: 'Non presentato', en: 'No-show', tone: 'red' },
  cancelled: { it: 'Annullato', en: 'Cancelled', tone: 'red' },
};

export const ORDER_STATUS: Record<SubOrderStatus, { it: string; en: string; tone: 'gold' | 'ok' | 'red' | 'mute' | 'warn' }> = {
  awaiting_payment: { it: 'In attesa di pagamento', en: 'Awaiting payment', tone: 'warn' },
  received: { it: 'Ricevuto', en: 'Received', tone: 'gold' },
  preparing: { it: 'In preparazione', en: 'Preparing', tone: 'warn' },
  shipped: { it: 'Spedito', en: 'Shipped', tone: 'ok' },
  ready_pickup: { it: 'Pronto al ritiro', en: 'Ready for pickup', tone: 'ok' },
  delivered: { it: 'Consegnato', en: 'Delivered', tone: 'mute' },
  cancelled: { it: 'Annullato', en: 'Cancelled', tone: 'red' },
  refunded: { it: 'Rimborsato', en: 'Refunded', tone: 'red' },
};

export const SALON_STATUS: Record<SalonStatus, { it: string; en: string; tone: 'gold' | 'ok' | 'red' | 'mute' | 'warn' }> = {
  draft: { it: 'Bozza', en: 'Draft', tone: 'mute' },
  pending: { it: 'In revisione', en: 'Under review', tone: 'gold' },
  needs_info: { it: 'Info richieste', en: 'Info requested', tone: 'warn' },
  approved: { it: 'Approvato', en: 'Approved', tone: 'ok' },
  rejected: { it: 'Rifiutato', en: 'Rejected', tone: 'red' },
  suspended: { it: 'Sospeso', en: 'Suspended', tone: 'red' },
};

export const PRODUCT_STATUS: Record<ProductStatus, { it: string; en: string; tone: 'gold' | 'ok' | 'red' | 'mute' | 'warn' }> = {
  draft: { it: 'Bozza', en: 'Draft', tone: 'mute' },
  review: { it: 'In revisione', en: 'In review', tone: 'gold' },
  published: { it: 'Pubblicato', en: 'Published', tone: 'ok' },
  rejected: { it: 'Rifiutato', en: 'Rejected', tone: 'red' },
};

export const uid = (p = 'id') => `${p}-${Math.random().toString(36).slice(2, 9)}`;
export const code = (p = 'MB') => `${p}-${Math.floor(10000 + Math.random() * 89999)}`;

/** Demo mode: fill TimeWindow.booked from the local bookings (the server does this in API mode). */
export const countWindowPlaces = (windows: TimeWindow[], bookings: Booking[], now = new Date()): TimeWindow[] =>
  windows.map((w) => ({ ...w, booked: bookings.filter((b) => b.windowId === w.id && holdsPlace(b, now)).length }));
