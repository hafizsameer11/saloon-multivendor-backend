/** Money helpers. The DB stores integer cents; the apps speak euros (numbers with 2 decimals). */
export const toCents = (euro: number) => Math.round(euro * 100);
export const toEuro = (cents: number) => Math.round(cents) / 100;

/** Commission in cents for a signed amount at a rate in basis points (1500 = 15%). Rounded half away from zero. */
export const commissionOf = (amountCents: number, bps: number) => {
  const raw = (Math.abs(amountCents) * bps) / 10000;
  const c = Math.round(raw);
  return amountCents < 0 ? -c : c;
};

export const bpsToRate = (bps: number) => bps / 10000;
export const rateToBps = (rate: number) => Math.round(rate * 10000);
