/**
 * Server-side Italian / English.
 *  - Each request runs with a language (Accept-Language / X-Lang header sent by the apps).
 *  - Error messages are written in Italian in the code; `tr()` translates them for English requests
 *    (exact dictionary + patterns for messages with values). Unknown messages fall back to Italian.
 *  - Zod's own validation messages follow the request language.
 *  - Notifications/emails use the RECIPIENT's saved language (User.lang), see notify.ts.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { z, type ZodErrorMap } from 'zod';

export type Lang = 'it' | 'en';
/** bilingual message: [italian, english] */
export type Msg = string | readonly [string, string];
export const m = (it: string, en: string) => [it, en] as const;
export const pick = (msg: Msg, lang: Lang) => (typeof msg === 'string' ? msg : lang === 'en' ? msg[1] : msg[0]);

const als = new AsyncLocalStorage<{ lang: Lang }>();
export const currentLang = (): Lang => als.getStore()?.lang ?? 'it';

export function langMiddleware(req: Request, _res: Response, next: NextFunction) {
  const raw = String(req.headers['x-lang'] ?? req.headers['accept-language'] ?? 'it').toLowerCase();
  const lang: Lang = raw.startsWith('en') ? 'en' : 'it';
  als.run({ lang }, next);
}

const EN: Record<string, string> = {
  'Accesso richiesto': 'Please sign in',
  'Non hai i permessi per questa azione': 'You are not allowed to do this',
  'Account sospeso. Contatta il supporto.': 'Account suspended. Please contact support.',
  'Alcuni prodotti non sono più disponibili': 'Some products are no longer available',
  'Appuntamento già passato': 'This appointment is in the past',
  'Appuntamento non ancora avvenuto': 'This appointment has not happened yet',
  'Candidatura in revisione': 'Application under review',
  'Candidatura in revisione: non modificabile': 'Application under review: it can’t be edited',
  'Carrello vuoto': 'Your cart is empty',
  'Completa la candidatura prima di inviarla': 'Complete the application before sending it',
  'Completa la checklist di verifica prima di approvare': 'Complete the verification checklist before approving',
  'Completa prima la verifica Stripe (documento e IBAN) per ricevere i prelievi': 'First complete the Stripe verification (ID and IBAN) to receive withdrawals',
  'Disponibile solo in modalità mock': 'Only available in mock mode',
  'Email o password non corretti': 'Wrong email or password',
  'Esiste già un account con questa email': 'An account with this email already exists',
  'Formato non supportato (PDF, JPG, PNG)': 'Unsupported format (PDF, JPG, PNG)',
  'Già rimborsato': 'Already refunded',
  'Hai già 3 prenotazioni in attesa di pagamento': 'You already have 3 bookings awaiting payment',
  'Hai già recensito questo appuntamento': 'You already reviewed this appointment',
  'Hai già recensito questo prodotto': 'You already reviewed this product',
  'Hai già un prelievo in lavorazione': 'You already have a withdrawal in progress',
  'Il salone deve essere approvato': 'The salon must be approved',
  'Il salone non ha completato la verifica Stripe: il prelievo resta approvato e verrà pagato dopo la verifica.': 'The salon hasn’t completed Stripe verification: the withdrawal stays approved and will be paid after verification.',
  'Il salone non è ancora approvato': 'The salon is not approved yet',
  'Il tuo salone deve essere approvato prima di questa azione': 'Your salon must be approved first',
  'Indirizzo di spedizione obbligatorio': 'Shipping address required',
  'Indirizzo non trovato': 'Address not found',
  'Link scaduto o già usato': 'Link expired or already used',
  'Link scaduto o non valido': 'Link expired or invalid',
  'Motivo obbligatorio': 'Reason required',
  'Nessun file ricevuto (campo "file")': 'No file received (field "file")',
  'Nessun file ricevuto (campo "files")': 'No file received (field "files")',
  'Nessun pagamento rimborsabile': 'No refundable payment',
  'Nessun saldo disponibile da prelevare': 'No balance available to withdraw',
  'Nessun salone associato a questo account': 'No salon linked to this account',
  'Nessuna richiesta di reso': 'No return request',
  'Nome del salone obbligatorio': 'Salon name required',
  'Non puoi bloccare te stesso': 'You can’t block yourself',
  'Numero di tracking obbligatorio': 'Tracking number required',
  'Orario non disponibile': 'Time not available',
  'Orario occupato (usa force per sovrapporre)': 'Time already taken (use force to overlap)',
  'Ordine con ritiro in salone': 'This order is for salon pickup',
  'Ordine da spedire': 'This order must be shipped',
  'Ordine già pagato o annullato': 'Order already paid or cancelled',
  'Pagamento non rimborsabile': 'Payment not refundable',
  'Password attuale errata': 'Current password is wrong',
  'Per cambiare IBAN o P.IVA contatta il supporto': 'To change IBAN or VAT number please contact support',
  'Puoi chiedere il reso solo dopo la consegna': 'You can request a return only after delivery',
  'Puoi recensire solo dopo l’appuntamento': 'You can review only after the appointment',
  'Puoi recensire solo prodotti acquistati e consegnati': 'You can review only products you bought and received',
  'Questa prenotazione non può essere annullata': 'This booking can’t be cancelled',
  'Questa prenotazione non può essere spostata': 'This booking can’t be moved',
  'Questa prenotazione non richiede pagamento': 'This booking doesn’t need a payment',
  'Questo orario non è più disponibile, scegline un altro': 'This time is no longer available, please pick another',
  'Reso già richiesto': 'Return already requested',
  'Salone sospeso': 'Salon suspended',
  'Sconto massimo 90%': 'Maximum discount 90%',
  'Servizio non valido': 'Invalid service',
  'Sessione non valida, accedi di nuovo': 'Session not valid, please sign in again',
  'Sessione scaduta': 'Session expired',
  'Solo i prelievi in attesa possono essere rifiutati': 'Only pending withdrawals can be rejected',
  'Solo per account salone': 'Salon accounts only',
  'Tempo per il pagamento scaduto, prenota di nuovo': 'Payment time expired, please book again',
  'Totale zero non supportato': 'A zero total is not supported',
  'Uno o più servizi non disponibili': 'One or more services are unavailable',
  'Dati non validi': 'Invalid data',
  'Devi accettare i termini': 'You must accept the terms',
  'Devi accettare le condizioni per i venditori': 'You must accept the seller terms',
  'Elemento non trovato': 'Item not found',
  'Esiste già un elemento con questi dati': 'An item with these details already exists',
  'File non trovato': 'File not found',
  'JSON non valido': 'Invalid JSON',
  'Troppi tentativi, riprova tra qualche minuto': 'Too many attempts, try again in a few minutes',
  'Errore interno': 'Internal error',
  'File troppo grande (max 10 MB)': 'File too large (max 10 MB)',
  'Almeno una foto': 'At least one photo',
  'CAP non valido': 'Invalid postcode',
  'Data non valida (AAAA-MM-GG)': 'Invalid date (YYYY-MM-DD)',
  'Data non valida': 'Invalid date',
  'Email non valida': 'Invalid email',
  'Minimo 8 caratteri': 'At least 8 characters',
  'Orario non valido': 'Invalid time',
  'Scrivi almeno 10 caratteri': 'Write at least 10 characters',
  'Solo lettere, numeri, - e _ (3–20)': 'Letters, numbers, - and _ only (3–20)',
  'Partita IVA non valida (11 cifre)': 'Invalid VAT number (11 digits)',
  'IBAN italiano non valido': 'Invalid Italian IBAN',
  'Indica una prenotazione oppure un prodotto': 'Give either a booking or a product',
  'Codice non valido': 'Invalid code',
  'Codice scaduto': 'Code expired',
  'Codice esaurito': 'Code fully used',
  'Codice valido solo per i prodotti di un altro salone': 'Code valid only for another salon’s products',
  'Mock transfer failure (destination contains "fail")': 'Mock transfer failure (destination contains "fail")',
  // checklist items (missingForSubmit)
  'Indirizzo e città del salone': 'Salon address and city',
  'Telefono del salone': 'Salon phone',
  'Almeno 3 foto del salone': 'At least 3 salon photos',
  'Descrizione (min 40 caratteri)': 'Description (min 40 characters)',
  'Ragione sociale': 'Company name',
  'Partita IVA': 'VAT number',
  IBAN: 'IBAN',
  'Codice SDI o PEC per la fatturazione': 'SDI code or PEC for invoices',
  'Visura camerale': 'Chamber of commerce extract',
  'Documento d’identità del titolare': 'Owner’s ID document',
};

const NOUN_EN: Record<string, string> = {
  Risorsa: 'Resource', Salone: 'Salon', Prodotto: 'Product', Ordine: 'Order', Prenotazione: 'Booking', Pagamento: 'Payment', Prelievo: 'Withdrawal',
  Documento: 'Document', Candidatura: 'Application', Recensione: 'Review', Indirizzo: 'Address', Codice: 'Code', Servizio: 'Service', Collaboratore: 'Staff member', Account: 'Account',
};

const PATTERNS: [RegExp, (x: RegExpMatchArray) => string][] = [
  [/^(.+) non trovat[oa]$/, (x) => `${NOUN_EN[x[1]] ?? x[1]} not found`],
  [/^"(.+)" è appena andato esaurito$/, (x) => `"${x[1]}" just sold out`],
  [/^(.+): formato non supportato \(JPG, PNG, WEBP, HEIC\)$/, (x) => `${x[1]}: unsupported format (JPG, PNG, WEBP, HEIC)`],
  [/^Candidatura in stato (.+)$/, (x) => `Application is ${x[1]}`],
  [/^Ha (\d+) appuntamenti futuri: spostali o disattiva il collaboratore$/, (x) => `They have ${x[1]} upcoming appointments: move them or deactivate the staff member`],
  [/^Il prelievo minimo è €(.+)$/, (x) => `The minimum withdrawal is €${x[1]}`],
  [/^Il reso è possibile entro (\d+) giorni dalla consegna$/, (x) => `Returns are possible within ${x[1]} days of delivery`],
  [/^Non puoi passare da (\S+) a (\S+)$/, (x) => `You can’t go from ${x[1]} to ${x[2]}`],
  [/^Prelievo già (.+)$/, (x) => `Withdrawal already ${x[1]}`],
  [/^Puoi spostare l’appuntamento fino a (\d+) ore prima$/, (x) => `You can move the appointment up to ${x[1]} hours before`],
  [/^Trasferimento Stripe fallito: (.+)$/, (x) => `Stripe transfer failed: ${x[1]}`],
  [/^Spesa minima €(.+)$/, (x) => `Minimum spend €${x[1]}`],
  [/^Nessuna rotta (\S+) (.+)$/, (x) => `No route ${x[1]} ${x[2]}`],
  [/^Minimo (\d+) caratteri$/, (x) => `At least ${x[1]} characters`],
];

/** Translate an Italian server message into the request language. */
export function tr(msg: string, lang: Lang = currentLang()): string {
  if (lang === 'it' || !msg) return msg;
  if (EN[msg]) return EN[msg];
  for (const [re, f] of PATTERNS) {
    const x = msg.match(re);
    if (x) return f(x);
  }
  return msg;
}

/** Zod's built-in messages in the request language (custom messages are translated by tr()). */
const errorMap: ZodErrorMap = (issue, ctx) => {
  const en = currentLang() === 'en';
  switch (issue.code) {
    case 'invalid_type':
      if (issue.received === 'undefined' || issue.received === 'null') return { message: en ? 'Required' : 'Obbligatorio' };
      return { message: en ? 'Invalid value' : 'Valore non valido' };
    case 'too_small':
      if (issue.type === 'string') return { message: en ? `At least ${issue.minimum} characters` : `Minimo ${issue.minimum} caratteri` };
      if (issue.type === 'array') return { message: en ? `At least ${issue.minimum} items` : `Almeno ${issue.minimum} elementi` };
      return { message: en ? `Must be at least ${issue.minimum}` : `Deve essere almeno ${issue.minimum}` };
    case 'too_big':
      if (issue.type === 'string') return { message: en ? `At most ${issue.maximum} characters` : `Massimo ${issue.maximum} caratteri` };
      if (issue.type === 'array') return { message: en ? `At most ${issue.maximum} items` : `Massimo ${issue.maximum} elementi` };
      return { message: en ? `Must be at most ${issue.maximum}` : `Deve essere al massimo ${issue.maximum}` };
    case 'invalid_string':
      if (issue.validation === 'email') return { message: en ? 'Invalid email' : 'Email non valida' };
      if (issue.validation === 'url') return { message: en ? 'Invalid link' : 'Link non valido' };
      return { message: en ? 'Invalid format' : 'Formato non valido' };
    case 'invalid_enum_value':
      return { message: en ? 'Invalid choice' : 'Scelta non valida' };
    case 'invalid_literal':
      return { message: en ? 'Required' : 'Obbligatorio' };
    default:
      return { message: en ? ctx.defaultError : 'Valore non valido' };
  }
};
z.setErrorMap(errorMap);
