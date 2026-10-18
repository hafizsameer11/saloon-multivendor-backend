/**
 * Cart pricing. One cart → one sub-order per salon.
 *  - shipping per salon: pickup = 0; standard = salon fee unless the salon subtotal ≥ its free-shipping threshold
 *  - platform coupon: discount on the whole cart, PAID BY THE PLATFORM (seller still earns full price)
 *  - salon coupon: discount only on that salon's items, PAID BY THE SALON (reduces the seller's earnings)
 */
import type { Coupon, Product, ProductVariant, Salon } from '@prisma/client';
import { prisma, type Tx } from '../../lib/prisma';
import { toISODate } from '../../lib/time';

export interface CartLineIn {
  productId: string;
  variantId?: string | null;
  qty: number;
}

export interface QuoteGroup {
  salonId: string;
  salonName: string;
  shippingMethod: 'standard' | 'pickup';
  items: { productId: string; variantId?: string; name: string; image: string; price: number; priceCents: number; qty: number; lineCents: number; stock: number }[];
  subtotalCents: number;
  shippingFeeCents: number;
  salonDiscountCents: number;
  platformDiscountCents: number;
}

export interface Quote {
  groups: QuoteGroup[];
  subtotalCents: number;
  shippingCents: number;
  discountCents: number;
  totalCents: number;
  coupon: { code: string; scope: string; error?: string } | null;
  problems: { productId: string; variantId?: string; code: 'unavailable' | 'out_of_stock' | 'not_enough_stock'; available?: number }[];
}

type P = Product & { variants: ProductVariant[]; salon: Salon };

export async function quoteCart(db: Tx, lines: CartLineIn[], opts: { couponCode?: string | null; shipping?: Record<string, 'standard' | 'pickup'> } = {}): Promise<Quote> {
  const ids = [...new Set(lines.map((l) => l.productId))];
  const products = (await db.product.findMany({ where: { id: { in: ids } }, include: { variants: true, salon: true } })) as P[];
  const byId = new Map(products.map((p) => [p.id, p]));
  const problems: Quote['problems'] = [];
  const groups = new Map<string, QuoteGroup>();

  for (const l of lines) {
    const p = byId.get(l.productId);
    if (!p || p.status !== 'published' || p.deletedAt || p.salon.status !== 'approved') {
      problems.push({ productId: l.productId, variantId: l.variantId ?? undefined, code: 'unavailable' });
      continue;
    }
    const v = l.variantId ? p.variants.find((x) => x.id === l.variantId) : undefined;
    if (l.variantId && !v) {
      problems.push({ productId: p.id, variantId: l.variantId, code: 'unavailable' });
      continue;
    }
    const stock = v ? v.stock : p.stock;
    if (stock <= 0) {
      problems.push({ productId: p.id, variantId: v?.id, code: 'out_of_stock', available: 0 });
      continue;
    }
    if (stock < l.qty) problems.push({ productId: p.id, variantId: v?.id, code: 'not_enough_stock', available: stock });
    const qty = Math.min(l.qty, stock);
    const priceCents = p.priceCents + (v?.priceDeltaCents ?? 0);
    const g =
      groups.get(p.salonId) ??
      ({ salonId: p.salonId, salonName: p.salon.name, shippingMethod: opts.shipping?.[p.salonId] ?? 'standard', items: [], subtotalCents: 0, shippingFeeCents: 0, salonDiscountCents: 0, platformDiscountCents: 0 } as QuoteGroup);
    g.items.push({ productId: p.id, variantId: v?.id, name: v ? `${p.name} · ${v.label}` : p.name, image: ((p.images as string[]) ?? [])[0] ?? '', price: priceCents / 100, priceCents, qty, lineCents: priceCents * qty, stock });
    g.subtotalCents += priceCents * qty;
    groups.set(p.salonId, g);
  }

  for (const g of groups.values()) {
    const salon = products.find((p) => p.salonId === g.salonId)!.salon;
    const pol = (salon.policies ?? {}) as { shippingFee?: number; freeShippingOver?: number };
    const fee = Math.round((pol.shippingFee ?? 5.9) * 100);
    const freeOver = Math.round((pol.freeShippingOver ?? 0) * 100);
    g.shippingFeeCents = g.shippingMethod === 'pickup' || (freeOver > 0 && g.subtotalCents >= freeOver) ? 0 : fee;
  }

  // coupon
  let coupon: Quote['coupon'] = null;
  const list = [...groups.values()];
  if (opts.couponCode) {
    const c = await db.coupon.findUnique({ where: { code: opts.couponCode.trim().toUpperCase() } });
    const err = couponError(c, list);
    coupon = { code: opts.couponCode.trim().toUpperCase(), scope: c?.scope ?? '', error: err ?? undefined };
    if (c && !err) applyCoupon(c, list);
  }

  const subtotalCents = list.reduce((a, g) => a + g.subtotalCents, 0);
  const shippingCents = list.reduce((a, g) => a + g.shippingFeeCents, 0);
  const discountCents = list.reduce((a, g) => a + g.salonDiscountCents + g.platformDiscountCents, 0);
  return { groups: list, subtotalCents, shippingCents, discountCents, totalCents: Math.max(0, subtotalCents + shippingCents - discountCents), coupon, problems };
}

function couponError(c: Coupon | null, groups: QuoteGroup[]): string | null {
  if (!c || !c.active) return 'Codice non valido';
  if (c.expiresAt < toISODate(new Date())) return 'Codice scaduto';
  if (c.uses >= c.maxUses) return 'Codice esaurito';
  const base = c.scope === 'platform' ? groups.reduce((a, g) => a + g.subtotalCents, 0) : groups.find((g) => g.salonId === c.scope)?.subtotalCents ?? 0;
  if (c.scope !== 'platform' && base === 0) return 'Codice valido solo per i prodotti di un altro salone';
  if (base < c.minSpendCents) return `Spesa minima €${(c.minSpendCents / 100).toFixed(2)}`;
  return null;
}

function applyCoupon(c: Coupon, groups: QuoteGroup[]) {
  if (c.scope === 'platform') {
    const base = groups.reduce((a, g) => a + g.subtotalCents, 0);
    const total = c.type === 'percent' ? Math.round((base * c.value) / 100) : Math.min(c.value, base);
    // spread across salons proportionally (for reporting), funded by the platform
    let left = total;
    groups.forEach((g, i) => {
      const share = i === groups.length - 1 ? left : Math.round((total * g.subtotalCents) / base);
      g.platformDiscountCents = share;
      left -= share;
    });
  } else {
    const g = groups.find((x) => x.salonId === c.scope)!;
    g.salonDiscountCents = c.type === 'percent' ? Math.round((g.subtotalCents * c.value) / 100) : Math.min(c.value, g.subtotalCents);
  }
}

export const prismaDb = prisma;
