/** Cart quote, checkout (stock reservation + payment), returns. */
import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ah, badRequest, conflict, notFound } from '../../lib/errors';
import { sOrder } from '../../lib/serialize';
import { body } from '../../middleware/validate';
import { requireAuth, requireRole } from '../../middleware/auth';
import { humanCode } from '../../lib/ids';
import { addMinutes } from '../../lib/time';
import { getSettings } from '../../lib/settings';
import { notify } from '../../lib/notify';
import { quoteCart, type Quote } from './pricing';
import { createIntentForOrder } from '../payments/service';
import { gateway } from '../payments/gateway';
import { m, tr } from '../../lib/i18n';

export const shopRouter = Router();

const lines = z.array(z.object({ productId: z.string(), variantId: z.string().nullish(), qty: z.number().int().min(1).max(20) })).min(1).max(50);
const quoteSchema = z.object({ lines, couponCode: z.string().max(40).nullish(), shipping: z.record(z.enum(['standard', 'pickup'])).optional() });

const toEuroQuote = (q: Quote) => ({
  groups: q.groups.map((g) => ({
    salonId: g.salonId, salonName: g.salonName, shippingMethod: g.shippingMethod,
    items: g.items.map((i) => ({ productId: i.productId, variantId: i.variantId, name: i.name, image: i.image, price: i.price, qty: i.qty, stock: i.stock })),
    subtotal: g.subtotalCents / 100, shippingFee: g.shippingFeeCents / 100, discount: (g.salonDiscountCents + g.platformDiscountCents) / 100,
  })),
  subtotal: q.subtotalCents / 100, shipping: q.shippingCents / 100, discount: q.discountCents / 100, total: q.totalCents / 100,
  coupon: q.coupon ? { ...q.coupon, error: q.coupon.error ? tr(q.coupon.error) : undefined } : null, problems: q.problems,
});

shopRouter.post(
  '/cart/quote',
  body(quoteSchema),
  ah(async (req, res) => res.json(toEuroQuote(await quoteCart(prisma, req.body.lines, { couponCode: req.body.couponCode, shipping: req.body.shipping })))),
);

const addressSchema = z.object({
  name: z.string().min(2).max(80), street: z.string().min(3).max(120), city: z.string().min(2).max(60),
  zip: z.string().regex(/^\d{5}$/), province: z.string().min(2).max(2), phone: z.string().min(6).max(30), label: z.string().max(40).optional(),
});

const checkoutSchema = quoteSchema.extend({ addressId: z.string().optional(), address: addressSchema.optional() });

shopRouter.post(
  '/checkout',
  requireAuth,
  requireRole('customer'),
  body(checkoutSchema),
  ah(async (req, res) => {
    const b = req.body as z.infer<typeof checkoutSchema>;
    const settings = await getSettings();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.sub } });

    const order = await prisma.$transaction(
      async (tx) => {
        const q = await quoteCart(tx, b.lines, { couponCode: b.couponCode, shipping: b.shipping });
        if (q.problems.length) throw conflict('Alcuni prodotti non sono più disponibili', 'cart_changed', toEuroQuote(q));
        if (q.coupon?.error) throw badRequest(q.coupon.error, 'coupon_invalid');
        if (!q.groups.length) throw badRequest('Carrello vuoto', 'empty_cart');
        const needsAddress = q.groups.some((g) => g.shippingMethod === 'standard');
        let address: Prisma.InputJsonValue | undefined;
        if (needsAddress) {
          if (b.addressId) {
            const a = await tx.address.findFirst({ where: { id: b.addressId, userId: user.id } });
            if (!a) throw badRequest('Indirizzo non trovato', 'address_missing');
            address = { name: a.name, street: a.street, city: a.city, zip: a.zip, province: a.province, phone: a.phone, label: a.label };
          } else if (b.address) address = b.address;
          else throw badRequest('Indirizzo di spedizione obbligatorio', 'address_missing');
        }

        // reserve stock with conditional decrements (fails cleanly if someone bought the last unit meanwhile)
        for (const g of q.groups)
          for (const it of g.items) {
            const r = it.variantId
              ? await tx.productVariant.updateMany({ where: { id: it.variantId, stock: { gte: it.qty } }, data: { stock: { decrement: it.qty } } })
              : await tx.product.updateMany({ where: { id: it.productId, stock: { gte: it.qty } }, data: { stock: { decrement: it.qty } } });
            if (r.count !== 1) throw conflict(`"${it.name}" è appena andato esaurito`, 'out_of_stock');
            if (it.variantId) await tx.product.update({ where: { id: it.productId }, data: { stock: { decrement: it.qty } } });
            await tx.product.update({ where: { id: it.productId }, data: { sold: { increment: it.qty } } });
          }

        return tx.order.create({
          data: {
            code: humanCode('ORD'), customerId: user.id, customerName: user.name, address, couponCode: q.coupon && !q.coupon.error ? q.coupon.code : null,
            discountCents: q.discountCents, totalCents: q.totalCents, status: 'pending_payment', holdExpiresAt: addMinutes(new Date(), settings.paymentHoldMinutes + 15),
            subOrders: {
              create: q.groups.map((g) => ({
                code: humanCode('SO'), salonId: g.salonId, shippingMethod: g.shippingMethod, shippingFeeCents: g.shippingFeeCents,
                subtotalCents: g.subtotalCents, salonDiscountCents: g.salonDiscountCents, platformDiscountCents: g.platformDiscountCents, status: 'awaiting_payment' as const, timeline: [],
                items: g.items.map((i) => ({ productId: i.productId, variantId: i.variantId, name: i.name, image: i.image, price: i.price, qty: i.qty })),
              })),
            },
          },
          include: { subOrders: true },
        });
      },
      { isolationLevel: 'ReadCommitted', timeout: 20_000 },
    );

    if (order.totalCents === 0) throw badRequest('Totale zero non supportato', 'zero_total');
    const r = await createIntentForOrder(order.id, user.id);
    res.status(201).json({ order: sOrder(order), payment: { clientSecret: r.clientSecret, amount: r.payment.amountCents / 100, provider: gateway.mode, paymentId: r.payment.id } });
  }),
);

/** Customer asks to return a delivered sub-order (EU 14-day withdrawal right). Salon/admin then refunds. */
shopRouter.post(
  '/orders/:id/return',
  requireAuth,
  body(z.object({ subOrderId: z.string(), reason: z.string().min(3).max(500) })),
  ah(async (req, res) => {
    const settings = await getSettings();
    const s = await prisma.subOrder.findUnique({ where: { id: req.body.subOrderId }, include: { order: true, salon: true } });
    if (!s || s.orderId !== req.params.id || s.order.customerId !== req.user!.sub) throw notFound('Ordine');
    if (s.status !== 'delivered' || !s.deliveredAt) throw badRequest('Puoi chiedere il reso solo dopo la consegna', 'not_delivered');
    if (Date.now() - s.deliveredAt.getTime() > settings.returnWindowDays * 86400_000) throw badRequest(`Il reso è possibile entro ${settings.returnWindowDays} giorni dalla consegna`, 'return_window_closed');
    if (s.returnRequested) throw conflict('Reso già richiesto');
    await prisma.subOrder.update({ where: { id: s.id }, data: { returnRequested: true, returnReason: req.body.reason } });
    // freeze the seller's money for this sub-order until the return is resolved
    await prisma.ledgerEntry.updateMany({ where: { sourceType: 'sub_order', sourceId: s.id, status: 'pending' }, data: { availableAt: null } });
    await notify(s.salon.ownerId, m('Richiesta di reso', 'Return request'), m(`Ordine ${s.code}: ${req.body.reason}`, `Order ${s.code}: ${req.body.reason}`), { link: '/seller/ordini', email: true });
    res.json({ ok: true });
  }),
);
