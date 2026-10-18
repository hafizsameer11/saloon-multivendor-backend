/**
 * Payment gateway abstraction.
 *  - "stripe": real Stripe API (test or live keys). Model: Connect "separate charges and transfers".
 *      customer pays the PLATFORM → seller withdrawal = Transfer to the seller's Express account → Stripe pays their bank.
 *  - "mock":   no network, no money. Used when STRIPE_SECRET_KEY is empty (local dev, tests, demos).
 */
import Stripe from 'stripe';
import crypto from 'node:crypto';
import { env, stripeMode } from '../../config';

export interface Gateway {
  mode: 'stripe' | 'mock';
  createPaymentIntent(a: { amountCents: number; description: string; metadata: Record<string, string>; email?: string; idempotencyKey: string; transferGroup?: string }): Promise<{ id: string; clientSecret: string }>;
  cancelPaymentIntent(id: string): Promise<void>;
  clientSecret(id: string): Promise<string>;
  refund(a: { paymentIntentId: string; amountCents: number; idempotencyKey: string; reason?: string }): Promise<{ id: string }>;
  createConnectedAccount(a: { email: string; businessName: string; salonId: string }): Promise<{ accountId: string }>;
  onboardingLink(a: { accountId: string; returnUrl: string; refreshUrl: string }): Promise<string>;
  dashboardLink(accountId: string): Promise<string | null>;
  accountStatus(accountId: string): Promise<{ payoutsEnabled: boolean; detailsSubmitted: boolean; requirements: string[] }>;
  transfer(a: { amountCents: number; destination: string; description: string; metadata: Record<string, string>; idempotencyKey: string }): Promise<{ id: string }>;
  reverseTransfer(transferId: string, amountCents?: number): Promise<void>;
  parseWebhook(raw: Buffer, signature: string | undefined): Stripe.Event;
}

// ────────────────────────────── real Stripe ──────────────────────────────
function stripeGateway(): Gateway {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { maxNetworkRetries: 2, appInfo: { name: 'MyBeauty+' } });
  return {
    mode: 'stripe',
    async createPaymentIntent(a) {
      const pi = await stripe.paymentIntents.create(
        {
          amount: a.amountCents,
          currency: 'eur',
          description: a.description,
          metadata: a.metadata,
          receipt_email: a.email,
          transfer_group: a.transferGroup,
          automatic_payment_methods: { enabled: true },
        },
        { idempotencyKey: a.idempotencyKey },
      );
      return { id: pi.id, clientSecret: pi.client_secret! };
    },
    async clientSecret(id) {
      const pi = await stripe.paymentIntents.retrieve(id);
      return pi.client_secret!;
    },
    async cancelPaymentIntent(id) {
      try {
        await stripe.paymentIntents.cancel(id);
      } catch {
        /* already succeeded/cancelled */
      }
    },
    async refund(a) {
      const r = await stripe.refunds.create(
        { payment_intent: a.paymentIntentId, amount: a.amountCents, metadata: { reason: a.reason ?? '' } },
        { idempotencyKey: a.idempotencyKey },
      );
      return { id: r.id };
    },
    async createConnectedAccount(a) {
      const acct = await stripe.accounts.create({
        type: 'express',
        country: 'IT',
        email: a.email,
        business_profile: { name: a.businessName, mcc: '7230', product_description: 'Servizi di bellezza e prodotti cosmetici' }, // 7230 = beauty/barber shops
        capabilities: { transfers: { requested: true } },
        metadata: { salonId: a.salonId },
      });
      return { accountId: acct.id };
    },
    async onboardingLink(a) {
      const link = await stripe.accountLinks.create({ account: a.accountId, type: 'account_onboarding', return_url: a.returnUrl, refresh_url: a.refreshUrl });
      return link.url;
    },
    async dashboardLink(accountId) {
      try {
        const l = await stripe.accounts.createLoginLink(accountId);
        return l.url;
      } catch {
        return null;
      }
    },
    async accountStatus(accountId) {
      const a = await stripe.accounts.retrieve(accountId);
      return { payoutsEnabled: !!a.payouts_enabled, detailsSubmitted: !!a.details_submitted, requirements: a.requirements?.currently_due ?? [] };
    },
    async transfer(a) {
      const t = await stripe.transfers.create(
        { amount: a.amountCents, currency: 'eur', destination: a.destination, description: a.description, metadata: a.metadata },
        { idempotencyKey: a.idempotencyKey },
      );
      return { id: t.id };
    },
    async reverseTransfer(transferId, amountCents) {
      await stripe.transfers.createReversal(transferId, amountCents ? { amount: amountCents } : {});
    },
    parseWebhook(raw, signature) {
      if (!env.STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET not set');
      return stripe.webhooks.constructEvent(raw, signature ?? '', env.STRIPE_WEBHOOK_SECRET);
    },
  };
}

// ────────────────────────────── mock ──────────────────────────────
function mockGateway(): Gateway {
  const id = (p: string) => `${p}_mock_${crypto.randomBytes(8).toString('hex')}`;
  const mockAccounts = new Map<string, boolean>(); // accountId → onboarded
  return {
    mode: 'mock',
    async createPaymentIntent() {
      const pi = id('pi');
      return { id: pi, clientSecret: `${pi}_secret_mock` };
    },
    async cancelPaymentIntent() {},
    async clientSecret(id) {
      return `${id}_secret_mock`;
    },
    async refund() {
      return { id: id('re') };
    },
    async createConnectedAccount() {
      const a = id('acct');
      mockAccounts.set(a, false);
      return { accountId: a };
    },
    async onboardingLink(a) {
      const u = new URL(`${env.API_PUBLIC_URL}/api/v1/payments/mock/onboard`);
      u.searchParams.set('account', a.accountId);
      u.searchParams.set('return', a.returnUrl);
      return u.toString();
    },
    async dashboardLink() {
      return null;
    },
    async accountStatus(accountId) {
      const ready = accountId.startsWith('acct_mock_s') || mockAccounts.get(accountId) === true;
      return { payoutsEnabled: ready, detailsSubmitted: ready, requirements: ready ? [] : ['individual.verification.document', 'external_account'] };
    },
    async transfer(a) {
      if (a.destination.includes('fail')) throw new Error('Mock transfer failure (destination contains "fail")');
      return { id: id('tr') };
    },
    async reverseTransfer() {},
    parseWebhook() {
      throw new Error('Webhooks are not used in mock mode — use POST /payments/:id/mock-confirm');
    },
    // test helper
    ...{ _markOnboarded: (acct: string) => mockAccounts.set(acct, true) },
  } as Gateway;
}

export const gateway: Gateway = stripeMode === 'stripe' ? stripeGateway() : mockGateway();
export const markMockOnboarded = (acct: string) => (gateway as unknown as { _markOnboarded?: (a: string) => void })._markOnboarded?.(acct);
