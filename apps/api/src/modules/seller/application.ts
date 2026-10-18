/** Seller onboarding: storefront + business data + documents → submit for admin review. */
import { Router } from 'express';
import { z } from 'zod';
import type { Salon } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, badRequest, conflict, notFound } from '../../lib/errors';
import { sApplication, sSalon } from '../../lib/serialize';
import { body } from '../../middleware/validate';
import { requireSalon } from '../../middleware/auth';
import { notify, notifyAdmins } from '../../lib/notify';
import { signedUrl } from '../../lib/storage';
import { m } from '../../lib/i18n';

export const applicationRouter = Router();

const hours = z.array(z.object({ day: z.number().int().min(0).max(6), open: z.string().regex(/^\d{2}:\d{2}$/).nullable(), close: z.string().regex(/^\d{2}:\d{2}$/).nullable() })).length(7);
const policies = z.object({ cancellation: z.string().max(500), noShow: z.string().max(500), shippingZones: z.string().max(200), shippingFee: z.number().min(0).max(100), freeShippingOver: z.number().min(0).max(10000) });

export const salonPatch = z.object({
  name: z.string().trim().min(2).max(80),
  tagline: z.string().trim().max(120),
  description: z.string().trim().max(3000),
  category: z.enum(['parrucchiere', 'barber', 'unghie', 'estetica', 'spa']),
  city: z.string().trim().max(60),
  address: z.string().trim().max(160),
  zip: z.string().trim().max(10),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  phone: z.string().trim().max(30),
  email: z.string().trim().email(),
  cover: z.string().max(2000),
  logo: z.string().max(2000).nullable(),
  gallery: z.array(z.string().max(2000)).max(20),
  hours,
  amenities: z.array(z.string().max(40)).max(20),
  policies,
  priceLevel: z.number().int().min(1).max(3),
}).partial();

const businessPatch = z.object({
  ragioneSociale: z.string().trim().max(160),
  pIva: z.string().trim().regex(/^(IT)?\d{11}$/, 'Partita IVA non valida (11 cifre)').or(z.literal('')),
  codiceFiscale: z.string().trim().toUpperCase().max(16),
  sdi: z.string().trim().toUpperCase().max(7),
  pec: z.string().trim().max(120),
  legalAddress: z.string().trim().max(200),
  iban: z.string().transform((v) => v.replace(/\s/g, '').toUpperCase()).refine((v) => v === '' || /^IT\d{2}[A-Z]\d{10}[0-9A-Z]{12}$/.test(v), 'IBAN italiano non valido').optional(),
  accountHolder: z.string().trim().max(120),
}).partial();

const EDITABLE = ['draft', 'needs_info', 'rejected'];

applicationRouter.get(
  '/application',
  requireSalon(),
  ah(async (_req, res) => {
    const salon = res.locals.salon as Salon;
    const app = await prisma.sellerApplication.findUnique({ where: { salonId: salon.id }, include: { documents: true } });
    if (!app) throw notFound('Candidatura');
    const [services, products] = await Promise.all([prisma.service.count({ where: { salonId: salon.id, deletedAt: null } }), prisma.product.count({ where: { salonId: salon.id, deletedAt: null } })]);
    res.json({ application: sApplication(app), salon: sSalon(salon), counts: { services, products } });
  }),
);

applicationRouter.put(
  '/application',
  requireSalon(),
  body(z.object({ salon: salonPatch.optional(), business: businessPatch.optional() })),
  ah(async (req, res) => {
    const salon = res.locals.salon as Salon;
    const app = await prisma.sellerApplication.findUniqueOrThrow({ where: { salonId: salon.id } });
    if (req.body.business && !EDITABLE.includes(app.status) && app.status !== 'approved') throw conflict('Candidatura in revisione: non modificabile', 'application_locked');
    if (req.body.business && app.status === 'approved' && (req.body.business.iban || req.body.business.pIva)) throw conflict('Per cambiare IBAN o P.IVA contatta il supporto', 'needs_support');
    const [s, a] = await prisma.$transaction([
      prisma.salon.update({ where: { id: salon.id }, data: req.body.salon ?? {} }),
      prisma.sellerApplication.update({ where: { id: app.id }, data: req.body.business ?? {}, include: { documents: true } }),
    ]);
    res.json({ application: sApplication(a), salon: sSalon(s) });
  }),
);

applicationRouter.post(
  '/application/documents',
  requireSalon(),
  body(z.object({ type: z.enum(['visura', 'id', 'license', 'other']), name: z.string().min(1).max(160), key: z.string().startsWith('private/') })),
  ah(async (req, res) => {
    const salon = res.locals.salon as Salon;
    const app = await prisma.sellerApplication.findUniqueOrThrow({ where: { salonId: salon.id } });
    if (!EDITABLE.includes(app.status)) throw conflict('Candidatura in revisione', 'application_locked');
    const d = await prisma.applicationDocument.create({ data: { applicationId: app.id, type: req.body.type, name: req.body.name, fileKey: req.body.key } });
    res.status(201).json({ id: d.id, type: d.type, name: d.name, uploadedAt: d.uploadedAt.toISOString() });
  }),
);

applicationRouter.delete(
  '/application/documents/:id',
  requireSalon(),
  ah(async (req, res) => {
    const salon = res.locals.salon as Salon;
    const app = await prisma.sellerApplication.findUniqueOrThrow({ where: { salonId: salon.id } });
    if (!EDITABLE.includes(app.status)) throw conflict('Candidatura in revisione', 'application_locked');
    const r = await prisma.applicationDocument.deleteMany({ where: { id: req.params.id, applicationId: app.id } });
    if (!r.count) throw notFound('Documento');
    res.json({ ok: true });
  }),
);

applicationRouter.get(
  '/application/documents/:id/url',
  requireSalon(),
  ah(async (req, res) => {
    const salon = res.locals.salon as Salon;
    const d = await prisma.applicationDocument.findFirst({ where: { id: req.params.id, application: { salonId: salon.id } } });
    if (!d) throw notFound('Documento');
    res.json({ url: await signedUrl(d.fileKey) });
  }),
);

/** What is still missing before the application can be submitted (shown as a checklist in the apps). */
export async function missingForSubmit(salonId: string) {
  const [salon, app, services] = await Promise.all([
    prisma.salon.findUniqueOrThrow({ where: { id: salonId } }),
    prisma.sellerApplication.findUniqueOrThrow({ where: { salonId }, include: { documents: true } }),
    prisma.service.count({ where: { salonId, deletedAt: null } }),
  ]);
  const missing: string[] = [];
  if (!salon.name || !salon.address || !salon.city) missing.push('Indirizzo e città del salone');
  if (!salon.phone) missing.push('Telefono del salone');
  if (!salon.cover || (salon.gallery as string[]).length < 2) missing.push('Almeno 3 foto del salone');
  if (!salon.description || salon.description.length < 40) missing.push('Descrizione (min 40 caratteri)');
  if (!app.ragioneSociale) missing.push('Ragione sociale');
  if (!app.pIva) missing.push('Partita IVA');
  if (!app.iban) missing.push('IBAN');
  if (!app.sdi && !app.pec) missing.push('Codice SDI o PEC per la fatturazione');
  if (!app.documents.some((d) => d.type === 'visura')) missing.push('Visura camerale');
  if (!app.documents.some((d) => d.type === 'id')) missing.push('Documento d’identità del titolare');
  void services; // services are not required to apply; a salon is listed publicly only once it has one
  return missing;
}

applicationRouter.get('/application/checklist', requireSalon(), ah(async (_req, res) => res.json({ missing: await missingForSubmit((res.locals.salon as Salon).id) })));

applicationRouter.post(
  '/application/submit',
  requireSalon(),
  body(z.object({ acceptSellerTerms: z.literal(true, { errorMap: () => ({ message: 'Devi accettare le condizioni per i venditori' }) }) })),
  ah(async (req, res) => {
    const salon = res.locals.salon as Salon;
    const app = await prisma.sellerApplication.findUniqueOrThrow({ where: { salonId: salon.id } });
    if (!EDITABLE.includes(app.status)) throw conflict(app.status === 'approved' ? 'Salone già approvato' : 'Candidatura già inviata', 'already_submitted');
    const missing = await missingForSubmit(salon.id);
    if (missing.length) throw badRequest('Completa la candidatura prima di inviarla', 'incomplete', { missing });
    await prisma.$transaction([
      prisma.sellerApplication.update({ where: { id: app.id }, data: { status: 'pending', submittedAt: new Date(), rejectionReason: null } }),
      prisma.salon.update({ where: { id: salon.id }, data: { status: 'pending' } }),
      prisma.product.updateMany({ where: { salonId: salon.id, status: 'draft', deletedAt: null }, data: { status: 'review' } }),
    ]);
    await notify(salon.ownerId, m('Candidatura inviata', 'Application sent'), m('La verifica richiede di solito 1–2 giorni lavorativi. Ti avviseremo via email.', 'Review usually takes 1–2 working days. We’ll let you know by email.'), { link: '/seller', email: true });
    await notifyAdmins(m('Nuova candidatura da verificare', 'New application to review'), m(`${salon.name} (${salon.city}) ha inviato la candidatura.`, `${salon.name} (${salon.city}) sent their application.`), `/admin/richieste/${salon.id}`);
    res.json({ ok: true, status: 'pending' });
  }),
);
