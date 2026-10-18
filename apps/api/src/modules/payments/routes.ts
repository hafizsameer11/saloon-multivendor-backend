/**
 * Payments
 *  POST /webhooks/stripe                (mounted in app.ts with raw body)
 *  GET  /payments/config                → publishable key + mode for the apps
 *  GET  /payments/:id                   → status (apps poll this after confirming the card)
 *  POST /payments/:id/mock-confirm      → MOCK MODE ONLY: simulates a successful card payment
 *  GET  /payments/mock/onboard          → MOCK MODE ONLY: simulates finishing Stripe Express onboarding
 */
import { Router, type Request, type Response } from 'express';
import { prisma } from '../../lib/prisma';
import { ah, badRequest, notFound } from '../../lib/errors';
import { sPayment } from '../../lib/serialize';
import { requireAuth } from '../../middleware/auth';
import { env, stripeMode } from '../../config';
import { notifyAdmins } from '../../lib/notify';
import { gateway } from './gateway';
import { onPaymentFailed, onPaymentSucceeded } from './service';
import { executeWithdrawal } from '../wallet/withdrawals';
import { m } from '../../lib/i18n';

export const paymentsRouter = Router();

paymentsRouter.get('/config', (_req, res) => res.json({ mode: stripeMode, publishableKey: env.STRIPE_PUBLISHABLE_KEY || null, currency: 'eur', country: 'IT' }));

paymentsRouter.get(
  '/mock/onboard',
  ah(async (req, res) => {
    if (stripeMode !== 'mock') throw notFound();
    const account = String(req.query.account ?? '');
    const salon = await prisma.salon.findFirst({ where: { stripeAccountId: account } });
    if (!salon) throw notFound('Account');
    await prisma.salon.update({ where: { id: salon.id }, data: { stripePayoutsReady: true } });
    await payApprovedWithdrawals(salon.id);
    const ret = String(req.query.return ?? env.WEB_PUBLIC_URL);
    res.redirect(ret);
  }),
);

paymentsRouter.get(
  '/:id',
  requireAuth,
  ah(async (req, res) => {
    const p = await prisma.payment.findUnique({ where: { id: req.params.id } });
    if (!p || (p.customerId !== req.user!.sub && req.user!.role !== 'admin')) throw notFound('Pagamento');
    res.json(sPayment(p));
  }),
);

paymentsRouter.post(
  '/:id/mock-confirm',
  requireAuth,
  ah(async (req, res) => {
    if (stripeMode !== 'mock') throw badRequest('Disponibile solo in modalità mock', 'not_mock');
    const p = await prisma.payment.findUnique({ where: { id: req.params.id } });
    if (!p || p.customerId !== req.user!.sub) throw notFound('Pagamento');
    const outcome = (req.body?.outcome as string) ?? 'succeeded';
    if (outcome === 'failed') await onPaymentFailed(p.providerPaymentId);
    else await onPaymentSucceeded(p.providerPaymentId);
    res.json(sPayment(await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })));
  }),
);

async function payApprovedWithdrawals(salonId: string) {
  const waiting = await prisma.withdrawal.findMany({ where: { salonId, status: 'approved' } });
  for (const w of waiting) await executeWithdrawal(w.id).catch(() => undefined);
}

/** Stripe webhook. Idempotent: each event id is processed once (StripeEvent table). */
export async function webhookHandler(req: Request, res: Response) {
  let event;
  try {
    event = gateway.parseWebhook(req.body as Buffer, req.headers['stripe-signature'] as string | undefined);
  } catch (e) {
    return res.status(400).json({ error: { code: 'bad_signature', message: (e as Error).message } });
  }
  try {
    await prisma.stripeEvent.create({ data: { id: event.id, type: event.type } });
  } catch {
    return res.json({ received: true, duplicate: true });
  }
  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        await onPaymentSucceeded(event.data.object.id);
        break;
      case 'payment_intent.payment_failed':
      case 'payment_intent.canceled':
        await onPaymentFailed(event.data.object.id);
        break;
      case 'account.updated': {
        const a = event.data.object;
        const salon = await prisma.salon.findFirst({ where: { stripeAccountId: a.id } });
        if (salon) {
          await prisma.salon.update({ where: { id: salon.id }, data: { stripePayoutsReady: !!a.payouts_enabled } });
          if (a.payouts_enabled) await payApprovedWithdrawals(salon.id);
        }
        break;
      }
      case 'charge.dispute.created':
        await notifyAdmins(m('Contestazione di pagamento', 'Payment dispute'), m(`Stripe ha aperto una contestazione (${event.data.object.id}). Rispondi dalla dashboard Stripe entro la scadenza.`, `Stripe opened a dispute (${event.data.object.id}). Respond from the Stripe dashboard before the deadline.`));
        break;
      default:
        break;
    }
    res.json({ received: true });
  } catch (e) {
    // let Stripe retry: remove the dedupe row
    await prisma.stripeEvent.delete({ where: { id: event.id } }).catch(() => undefined);
    console.error('[webhook] failed', event.type, e);
    res.status(500).json({ error: { code: 'webhook_failed' } });
  }
}
