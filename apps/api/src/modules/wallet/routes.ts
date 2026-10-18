/**
 * Seller wallet (mounted under /seller)
 *  GET  /wallet                 balances + recent ledger lines + withdrawals + Stripe status
 *  GET  /wallet/ledger          paginated ledger
 *  POST /stripe/onboarding      creates the Stripe Express account (once) and returns the onboarding URL
 *  GET  /stripe/status          refreshes payouts status from Stripe
 *  POST /withdrawals            request withdrawal of the full available balance
 *  GET  /withdrawals            history
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Salon } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah } from '../../lib/errors';
import { sLedger, sWithdrawal } from '../../lib/serialize';
import { requireAuth, requireRole, requireSalon } from '../../middleware/auth';
import { query, q } from '../../middleware/validate';
import { env } from '../../config';
import { getSettings } from '../../lib/settings';
import { bpsToRate } from '../../lib/money';
import { gateway } from '../payments/gateway';
import { centsSummaryToEuro, walletSummary } from './ledger';
import { requestWithdrawal } from './withdrawals';

export const walletRouter = Router();
walletRouter.use(requireAuth, requireRole('seller'));

walletRouter.get(
  '/wallet',
  requireSalon(),
  ah(async (_req, res) => {
    const salon = res.locals.salon as Salon;
    const settings = await getSettings();
    const [sum, lines, withdrawals] = await Promise.all([
      walletSummary(salon.id),
      prisma.ledgerEntry.findMany({ where: { salonId: salon.id }, orderBy: { createdAt: 'desc' }, take: 30 }),
      prisma.withdrawal.findMany({ where: { salonId: salon.id }, orderBy: { requestedAt: 'desc' }, take: 24 }),
    ]);
    const open = withdrawals.find((w) => ['requested', 'approved'].includes(w.status));
    res.json({
      commissionRate: bpsToRate(salon.commissionBps),
      minWithdrawal: settings.minWithdrawal,
      pending: centsSummaryToEuro(sum.pending),
      available: centsSummaryToEuro(sum.available),
      inProgress: centsSummaryToEuro(sum.inProgress),
      withdrawn: centsSummaryToEuro(sum.withdrawn),
      nextReleaseAt: sum.nextReleaseAt?.toISOString() ?? null,
      canWithdraw: !open && salon.status === 'approved' && sum.available.net >= settings.minWithdrawal * 100,
      openWithdrawal: open ? sWithdrawal(open) : null,
      stripe: { accountId: salon.stripeAccountId, payoutsReady: salon.stripePayoutsReady, mode: gateway.mode },
      ledger: lines.map(sLedger),
      withdrawals: withdrawals.map(sWithdrawal),
    });
  }),
);

const ledgerQ = z.object({ status: z.enum(['pending', 'available', 'withdrawn']).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) });
walletRouter.get(
  '/wallet/ledger',
  requireSalon(),
  query(ledgerQ),
  ah(async (_req, res) => {
    const salon = res.locals.salon as Salon;
    const f = q(res, ledgerQ);
    const where = { salonId: salon.id, ...(f.status ? { status: f.status } : {}) };
    const [total, rows] = await Promise.all([prisma.ledgerEntry.count({ where }), prisma.ledgerEntry.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (f.page - 1) * f.pageSize, take: f.pageSize })]);
    res.json({ total, items: rows.map(sLedger) });
  }),
);

walletRouter.post(
  '/stripe/onboarding',
  requireSalon({ approved: true }),
  ah(async (req, res) => {
    let salon = res.locals.salon as Salon;
    if (!salon.stripeAccountId) {
      const owner = await prisma.user.findUniqueOrThrow({ where: { id: salon.ownerId } });
      const app = await prisma.sellerApplication.findUnique({ where: { salonId: salon.id } });
      const { accountId } = await gateway.createConnectedAccount({ email: owner.email, businessName: app?.ragioneSociale || salon.name, salonId: salon.id });
      salon = await prisma.salon.update({ where: { id: salon.id }, data: { stripeAccountId: accountId } });
    }
    const back = (req.body?.returnUrl as string) || `${env.WEB_PUBLIC_URL}/#/venditore/pagamenti`;
    const url = await gateway.onboardingLink({ accountId: salon.stripeAccountId!, returnUrl: back, refreshUrl: back });
    res.json({ url, accountId: salon.stripeAccountId });
  }),
);

walletRouter.get(
  '/stripe/status',
  requireSalon(),
  ah(async (_req, res) => {
    const salon = res.locals.salon as Salon;
    if (!salon.stripeAccountId) return res.json({ connected: false, payoutsReady: false, requirements: [] });
    if (gateway.mode === 'mock') return res.json({ connected: true, payoutsReady: salon.stripePayoutsReady, requirements: salon.stripePayoutsReady ? [] : ['verifica identità', 'IBAN'] });
    const st = await gateway.accountStatus(salon.stripeAccountId);
    if (st.payoutsEnabled !== salon.stripePayoutsReady) await prisma.salon.update({ where: { id: salon.id }, data: { stripePayoutsReady: st.payoutsEnabled } });
    res.json({ connected: true, payoutsReady: st.payoutsEnabled, requirements: st.requirements, dashboardUrl: await gateway.dashboardLink(salon.stripeAccountId) });
  }),
);

walletRouter.post(
  '/withdrawals',
  requireSalon({ approved: true }),
  ah(async (req, res) => {
    const salon = res.locals.salon as Salon;
    const w = await requestWithdrawal(salon.id, { actorId: req.user!.sub });
    res.status(201).json(sWithdrawal(w));
  }),
);

walletRouter.get(
  '/withdrawals',
  requireSalon(),
  ah(async (_req, res) => {
    const salon = res.locals.salon as Salon;
    res.json((await prisma.withdrawal.findMany({ where: { salonId: salon.id }, orderBy: { requestedAt: 'desc' } })).map(sWithdrawal));
  }),
);
