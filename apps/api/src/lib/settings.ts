import { prisma } from './prisma';

/** Platform settings editable by admin. Stored as key/value JSON rows; defaults below. */
export const DEFAULT_SETTINGS = {
  defaultCommissionRate: 0.15,
  minWithdrawal: 20, // €
  withdrawalAutoApprove: false,
  autoWithdrawAfterDays: 75, // Stripe allows holding funds max 90 days (non-US platforms)
  bookingReleaseHours: 48, // after a completed booking, funds become withdrawable
  returnWindowDays: 14, // EU distance-selling withdrawal right
  autoDeliverAfterDays: 21, // shipped sub-orders are considered delivered after this
  paymentHoldMinutes: 15, // unpaid booking/order hold
  commissionOnCash: true, // commission on money paid at the salon is deducted from the wallet
  freeCancellationHours: 24,
  supportEmail: 'supporto@mybeauty.it',
};
export type Settings = typeof DEFAULT_SETTINGS;

let cache: { at: number; value: Settings } | null = null;

export async function getSettings(): Promise<Settings> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const rows = await prisma.platformSetting.findMany();
  const value = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) value[r.key] = r.value;
  cache = { at: Date.now(), value: value as Settings };
  return cache.value;
}

export async function updateSettings(patch: Partial<Settings>) {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS) || value === undefined) continue;
    await prisma.platformSetting.upsert({ where: { key }, create: { key, value: value as never }, update: { value: value as never } });
  }
  cache = null;
  return getSettings();
}

export const clearSettingsCache = () => {
  cache = null;
};
