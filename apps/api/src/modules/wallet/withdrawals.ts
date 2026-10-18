/**
 * Withdrawal flow
 *   seller requests → (admin approves | auto-approve) → Stripe Transfer of NET amount to the seller's Express account
 *   → status "paid", ledger lines "withdrawn". Stripe then pays the seller's bank on its normal schedule.
 * Commission is cut here: transfer = gross − commission. The commission simply stays in the platform's Stripe balance.
 */
import { prisma } from '../../lib/prisma';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { getSettings } from '../../lib/settings';
import { notify, notifyAdmins, audit } from '../../lib/notify';
import { toCents, toEuro } from '../../lib/money';
import { gateway } from '../payments/gateway';
import { m } from '../../lib/i18n';

const OPEN = ['requested', 'approved'] as const;
const eur = (c: number) => `€${(c / 100).toFixed(2).replace('.', ',')}`;

export async function requestWithdrawal(salonId: string, opts: { auto?: boolean; actorId?: string } = {}) {
  const settings = await getSettings();
  const w = await prisma.$transaction(async (tx) => {
    // serialize withdrawals per salon (row lock)
    await tx.$queryRaw`SELECT id FROM Salon WHERE id = ${salonId} FOR UPDATE`;
    const salon = await tx.salon.findUniqueOrThrow({ where: { id: salonId } });
    if (salon.status !== 'approved') throw forbidden('Il salone deve essere approvato', 'salon_not_approved');
    if (!opts.auto && (!salon.stripeAccountId || !salon.stripePayoutsReady))
      throw forbidden('Completa prima la verifica Stripe (documento e IBAN) per ricevere i prelievi', 'stripe_not_ready');
    const open = await tx.withdrawal.findFirst({ where: { salonId, status: { in: [...OPEN] } } });
    if (open) throw conflict('Hai già un prelievo in lavorazione', 'withdrawal_open');
    const lines = await tx.ledgerEntry.findMany({ where: { salonId, status: 'available', withdrawalId: null } });
    const gross = lines.reduce((a, e) => a + e.amountCents, 0);
    const commission = lines.reduce((a, e) => a + e.commissionCents, 0);
    const net = gross - commission;
    if (net <= 0) throw badRequest('Nessun saldo disponibile da prelevare', 'nothing_to_withdraw');
    if (!opts.auto && net < toCents(settings.minWithdrawal)) throw badRequest(`Il prelievo minimo è €${settings.minWithdrawal}`, 'below_minimum', { minimum: settings.minWithdrawal, available: toEuro(net) });
    const created = await tx.withdrawal.create({ data: { salonId, grossCents: gross, commissionCents: commission, netCents: net, auto: !!opts.auto } });
    await tx.ledgerEntry.updateMany({ where: { id: { in: lines.map((l) => l.id) } }, data: { withdrawalId: created.id } });
    return created;
  });
  await audit(opts.actorId, 'withdrawal.request', 'withdrawal', w.id, { net: w.netCents, auto: w.auto });

  if (opts.auto || settings.withdrawalAutoApprove) return executeWithdrawal(w.id, opts.actorId);
  await notifyAdmins(m('Nuova richiesta di prelievo', 'New withdrawal request'), m(`Un salone ha richiesto ${eur(w.netCents)} (lordo ${eur(w.grossCents)}, commissione ${eur(w.commissionCents)}).`, `A salon requested ${eur(w.netCents)} (gross ${eur(w.grossCents)}, commission ${eur(w.commissionCents)}).`), '/admin/pagamenti');
  return w;
}

/** Approve + pay. Safe to retry: the Stripe idempotency key is the withdrawal id. */
export async function executeWithdrawal(withdrawalId: string, adminId?: string) {
  const w = await prisma.withdrawal.findUnique({ where: { id: withdrawalId }, include: { salon: true } });
  if (!w) throw notFound('Prelievo');
  if (!['requested', 'approved', 'failed'].includes(w.status)) throw conflict(`Prelievo già ${w.status}`);
  const salon = w.salon;
  if (!salon.stripeAccountId || !salon.stripePayoutsReady) {
    await prisma.withdrawal.update({ where: { id: w.id }, data: { status: 'approved', decidedAt: new Date(), decidedById: adminId } });
    await notify(salon.ownerId, m('Completa la verifica Stripe', 'Complete your Stripe verification'), m('Il tuo prelievo è approvato ma devi completare la verifica Stripe (documento e IBAN) per ricevere i fondi.', 'Your withdrawal is approved, but you must complete the Stripe verification (ID and IBAN) to receive the money.'), { link: '/seller/pagamenti', email: true });
    throw badRequest('Il salone non ha completato la verifica Stripe: il prelievo resta approvato e verrà pagato dopo la verifica.', 'stripe_not_ready');
  }
  await prisma.withdrawal.update({ where: { id: w.id }, data: { status: 'approved', decidedAt: w.decidedAt ?? new Date(), decidedById: adminId ?? w.decidedById } });
  try {
    const t = await gateway.transfer({
      amountCents: w.netCents,
      destination: salon.stripeAccountId,
      description: `MyBeauty+ prelievo ${w.id}`,
      metadata: { withdrawalId: w.id, salonId: salon.id, gross: String(w.grossCents), commission: String(w.commissionCents) },
      idempotencyKey: `withdrawal-${w.id}`,
    });
    const paid = await prisma.$transaction(async (tx) => {
      await tx.ledgerEntry.updateMany({ where: { withdrawalId: w.id }, data: { status: 'withdrawn' } });
      return tx.withdrawal.update({ where: { id: w.id }, data: { status: 'paid', stripeTransferId: t.id, paidAt: new Date(), failureReason: null } });
    });
    await notify(salon.ownerId, m('Prelievo inviato', 'Withdrawal sent'), m(`Abbiamo inviato ${eur(w.netCents)} al tuo conto Stripe (lordo ${eur(w.grossCents)} − commissione ${eur(w.commissionCents)}). Arriverà sul tuo IBAN secondo il calendario Stripe.`, `We sent ${eur(w.netCents)} to your Stripe account (gross ${eur(w.grossCents)} − commission ${eur(w.commissionCents)}). It will reach your IBAN on Stripe’s payout schedule.`), { link: '/seller/pagamenti', email: true });
    await audit(adminId, 'withdrawal.paid', 'withdrawal', w.id, { transfer: t.id });
    return paid;
  } catch (e) {
    const reason = (e as Error).message;
    // release the lines so the seller can try again later
    await prisma.$transaction([
      prisma.ledgerEntry.updateMany({ where: { withdrawalId: w.id }, data: { withdrawalId: null } }),
      prisma.withdrawal.update({ where: { id: w.id }, data: { status: 'failed', failureReason: reason } }),
    ]);
    await notifyAdmins(m('Prelievo fallito', 'Withdrawal failed'), m(`Trasferimento Stripe fallito per ${salon.name}: ${reason}`, `Stripe transfer failed for ${salon.name}: ${reason}`), '/admin/pagamenti');
    await audit(adminId, 'withdrawal.failed', 'withdrawal', w.id, { reason });
    throw badRequest(`Trasferimento Stripe fallito: ${reason}`, 'transfer_failed');
  }
}

export async function rejectWithdrawal(withdrawalId: string, reason: string, adminId: string) {
  const w = await prisma.withdrawal.findUnique({ where: { id: withdrawalId }, include: { salon: true } });
  if (!w) throw notFound('Prelievo');
  if (!OPEN.includes(w.status as (typeof OPEN)[number])) throw conflict('Solo i prelievi in attesa possono essere rifiutati');
  await prisma.$transaction([
    prisma.ledgerEntry.updateMany({ where: { withdrawalId: w.id }, data: { withdrawalId: null } }),
    prisma.withdrawal.update({ where: { id: w.id }, data: { status: 'rejected', failureReason: reason, decidedAt: new Date(), decidedById: adminId } }),
  ]);
  await notify(w.salon.ownerId, m('Prelievo non approvato', 'Withdrawal not approved'), m(`Motivo: ${reason}. Il saldo resta disponibile nel tuo portafoglio.`, `Reason: ${reason}. The balance stays available in your wallet.`), { link: '/seller/pagamenti', email: true });
  await audit(adminId, 'withdrawal.reject', 'withdrawal', w.id, { reason });
}

/**
 * Job: Stripe lets a non-US platform hold funds for at most 90 days. Any available money older than
 * `autoWithdrawAfterDays` is sent automatically. Salons without Stripe set up are reported to admins.
 */
export async function autoWithdrawOld(now = new Date()) {
  const s = await getSettings();
  const limit = new Date(now.getTime() - s.autoWithdrawAfterDays * 86400_000);
  const salons = await prisma.ledgerEntry.groupBy({ by: ['salonId'], where: { status: 'available', withdrawalId: null, createdAt: { lte: limit } } });
  const results: { salonId: string; ok: boolean; reason?: string }[] = [];
  for (const { salonId } of salons) {
    try {
      await requestWithdrawal(salonId, { auto: true });
      results.push({ salonId, ok: true });
    } catch (e) {
      results.push({ salonId, ok: false, reason: (e as Error).message });
    }
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) await notifyAdmins(m('Prelievi automatici non riusciti', 'Automatic withdrawals failed'), m(`${failed.length} saloni hanno fondi vicini al limite di 90 giorni ma il prelievo automatico non è riuscito. Controlla la verifica Stripe.`, `${failed.length} salons have funds close to the 90-day limit but the automatic withdrawal failed. Check their Stripe verification.`), '/admin/pagamenti');
  return results;
}
