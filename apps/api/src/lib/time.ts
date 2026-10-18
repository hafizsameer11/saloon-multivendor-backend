/** Date helpers. Server runs with TZ=Europe/Rome (set in config.ts), so local time = salon time. */
export const pad2 = (n: number) => String(n).padStart(2, '0');
export const toISODate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const parseISODate = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
export const addMinutes = (d: Date, n: number) => new Date(d.getTime() + n * 60_000);
export const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
export const toHHMM = (min: number) => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
/** 0 = Monday … 6 = Sunday (matches OpeningHours.day and Staff.workingDays) */
export const weekdayIdx = (d: Date) => (d.getDay() + 6) % 7;
/** JS Date for a booking's start in local (Rome) time */
export const bookingStart = (date: string, startMin: number) => {
  const d = parseISODate(date);
  d.setMinutes(startMin);
  return d;
};
export const isISODate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parseISODate(s).getTime());
