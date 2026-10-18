/**
 * Translations for VALUES stored in data (picked from fixed lists in the apps) + locale helpers.
 * Free text written by sellers (descriptions, service names, policies) is shown as written.
 */
export type Lang = 'it' | 'en';

const DATA_EN: Record<string, string> = {
  // address labels
  Casa: 'Home', Ufficio: 'Work', Altro: 'Other',
  // amenities
  'Aria condizionata': 'Air conditioning', 'Pagamento con carta': 'Card payments', Accessibile: 'Wheelchair accessible',
  Parcheggio: 'Parking', 'Caffè offerto': 'Complimentary coffee', 'Prodotti vegan': 'Vegan products',
  // shipping zones
  Italia: 'Italy', 'Solo Calabria': 'Calabria only', 'Solo ritiro in salone': 'Salon pickup only',
};

/** Show a stored list value in the user's language (unknown values are shown unchanged). */
export const dataLabel = (value: string, lang: Lang) => (lang === 'en' ? DATA_EN[value] ?? value : value);

export const WEEKDAYS_SHORT: Record<Lang, string[]> = {
  it: ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'],
  en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
};

export const localeOf = (lang: Lang) => (lang === 'it' ? 'it-IT' : 'en-GB');
/** "13 ott 2026, 14:05" / "13 Oct 2026, 14:05" */
export const fmtDateTime = (iso: string, lang: Lang) => new Date(iso).toLocaleString(localeOf(lang), { dateStyle: 'medium', timeStyle: 'short' });
export const fmtDayMonth = (iso: string, lang: Lang) => new Date(iso).toLocaleDateString(localeOf(lang), { day: 'numeric', month: 'short' });
