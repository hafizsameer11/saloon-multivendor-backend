/**
 * Seller wallet = sum of LedgerEntry rows.
 *
 *   gross       = Σ amountCents        (what customers paid for this salon)
 *   commission  = Σ commissionCents    (platform share, rate frozen per line at sale time)
 *   net         = gross − commission   (what the seller receives on withdrawal)
 *
 * Lines start "pending" and become "available" at availableAt (service done + 48h, or delivery + return window).
 * A withdrawal takes ALL available lines, and the commission is cut at that moment.
 */
import type { LedgerEntry, Prisma } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma';
import { commissionOf } from '../../lib/money';

type Src = { salonId: string; sourceType: 'booking' | 'sub_order' | 'admin'; sourceId: string; description: string };

async function salonBps(tx: Tx, salonId: string) {
  const s = await tx.salon.findUniqueOrThrow({ where: { id: salonId }, select: { commissionBps: true } });
  return s.commissionBps;
}

/** Money the customer paid online for this salon. availableAt=null → waits for an event (service done / delivered). */
export async function recordSale(tx: Tx, src: Src & { amountCents: number; availableAt?: Date | null }) {
  if (src.amountCents <= 0) return null;
  const bps = await salonBps(tx, src.salonId);
  return tx.ledgerEntry.create({
    data: {
      salonId: src.salonId, type: 'sale', amountCents: src.amountCents, commissionBps: bps, commissionCents: commissionOf(src.amountCents, bps),
      sourceType: src.sourceType, sourceId: src.sourceId, description: src.description, status: 'pending', availableAt: src.availableAt ?? null,
    },
  });
}

/** Commission owed on money paid in cash at the salon (platform never touched it, so it is taken from the wallet). */
export async function recordCashCommission(tx: Tx, src: Src & { cashCents: number; availableAt: Date }) {
  if (src.cashCents <= 0) return null;
  const bps = await salonBps(tx, src.salonId);
  return tx.ledgerEntry.create({
    data: {
      salonId: src.salonId, type: 'cash_commission', amountCents: 0, commissionBps: bps, commissionCents: commissionOf(src.cashCents, bps),
      sourceType: src.sourceType, sourceId: src.sourceId, description: src.description, status: 'pending', availableAt: src.availableAt,
    },
  });
}

/**
 * A refund to the customer. Negative line using the SAME commission rate as the original sale(s),
 * so the platform also gives back its commission share. Immediately "available" so it is netted in the next withdrawal.
 */
export async function recordRefund(tx: Tx, src: Src & { amountCents: number }) {
  if (src.amountCents <= 0) return null;
  const sale = await tx.ledgerEntry.findFirst({ where: { sourceType: src.sourceType, sourceId: src.sourceId, type: 'sale' }, orderBy: { createdAt: 'asc' } });
  const bps = sale?.commissionBps ?? (await salonBps(tx, src.salonId));
  return tx.ledgerEntry.create({
    data: {
      salonId: src.salonId, type: 'refund', amountCents: -src.amountCents, commissionBps: bps, commissionCents: commissionOf(-src.amountCents, bps),
      sourceType: src.sourceType, sourceId: src.sourceId, description: src.description, status: 'available', availableAt: new Date(),
    },
  });
}

/** Admin correction (positive = credit to the seller, negative = debit). No commission. */
export async function recordAdjustment(tx: Tx, salonId: string, amountCents: number, description: string, adminId: string) {
  return tx.ledgerEntry.create({
    data: { salonId, type: 'adjustment', amountCents, commissionBps: 0, commissionCents: 0, sourceType: 'admin', sourceId: adminId, description, status: 'available', availableAt: new Date() },
  });
}

/** Set when pending lines of a booking / sub-order become withdrawable. */
export async function scheduleRelease(tx: Tx, sourceType: string, sourceId: string, availableAt: Date) {
  await tx.ledgerEntry.updateMany({ where: { sourceType, sourceId, status: 'pending' }, data: { availableAt } });
}

/** Cancel not-yet-released lines of a source (e.g. order cancelled before delivery, refund handled separately). */
export async function voidPending(tx: Tx, sourceType: string, sourceId: string) {
  await tx.ledgerEntry.deleteMany({ where: { sourceType, sourceId, status: 'pending', type: { in: ['sale', 'cash_commission'] } } });
}

/** Job: pending → available when their time has come. */
export async function releaseDue(now = new Date()) {
  const r = await prisma.ledgerEntry.updateMany({ where: { status: 'pending', availableAt: { lte: now } }, data: { status: 'available' } });
  return r.count;
}

const sum = (rows: Pick<LedgerEntry, 'amountCents' | 'commissionCents'>[]) => {
  const gross = rows.reduce((a, e) => a + e.amountCents, 0);
  const commission = rows.reduce((a, e) => a + e.commissionCents, 0);
  return { gross, commission, net: gross - commission };
};

export async function walletSummary(salonId: string, db: Tx | typeof prisma = prisma) {
  const rows = await db.ledgerEntry.findMany({ where: { salonId }, select: { amountCents: true, commissionCents: true, status: true, withdrawalId: true, availableAt: true } });
  const pending = sum(rows.filter((e) => e.status === 'pending'));
  const available = sum(rows.filter((e) => e.status === 'available' && !e.withdrawalId));
  const inProgress = sum(rows.filter((e) => e.status === 'available' && e.withdrawalId));
  const withdrawn = sum(rows.filter((e) => e.status === 'withdrawn'));
  const nextRelease = rows
    .filter((e) => e.status === 'pending' && e.availableAt)
    .map((e) => e.availableAt!)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  return { pending, available, inProgress, withdrawn, nextReleaseAt: nextRelease ?? null };
}

export const centsSummaryToEuro = (s: { gross: number; commission: number; net: number }) => ({ gross: s.gross / 100, commission: s.commission / 100, net: s.net / 100 });

export type LedgerWhere = Prisma.LedgerEntryWhereInput;
