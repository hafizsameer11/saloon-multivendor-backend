/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Connects a prototype store (web or mobile — same actions) to the API.
 *
 * Pattern for every existing action: run the original (instant, optimistic UI) → call the API →
 * reload server data (debounced, after all in-flight calls finish). If the API refuses, the error is shown
 * and the reload puts the screen back to the server's truth. New async actions (apiLogin, apiCreateBooking,
 * apiCheckout, apiWithdraw, …) are for flows that need the server's answer before moving on.
 */
import type { Booking, Coupon, Product, Salon, SellerApplication, Service, Staff, TimeWindow, User } from '../types';
import type { WindowInput } from '../windows';
import type { DB } from '../mock/seed';
import { ApiError, errorText, type Api, type Tokens } from './client';
import * as R from './remote';

export interface SyncState {
  busy: R.BusyBlock[];
  wallet: R.Wallet | null;
  withdrawals: R.Withdrawal[];
  settings: R.PlatformSettings | null;
  paymentMode: 'stripe' | 'mock' | null;
  publishableKey: string | null;
  sync: { ready: boolean; loading: boolean; error: string | null; at: string | null };
}

export const emptyDB = (): DB => ({
  users: [], salons: [], applications: [], staff: [], services: [], products: [], bookings: [], windows: [], orders: [], subOrders: [],
  reviews: [], payouts: [], coupons: [], notifications: [], banners: [], tickets: [],
});

export const initialSyncState = (): SyncState => ({
  busy: [], wallet: null, withdrawals: [], settings: null, paymentMode: null, publishableKey: null,
  sync: { ready: false, loading: false, error: null, at: null },
});

/** Demo shortcuts (DemoBar / quick login) → real seeded accounts. Password for all: demo1234 */
export const DEMO_ACCOUNTS: Record<string, string> = {
  'u-giulia': 'giulia@demo.it',
  'u-marco': 'marco@barberiaelite.it',
  'u-sofia': 'sofia@lunanails.it',
  'u-admin': 'admin@mybeauty.it',
};
export const DEMO_PASSWORD = 'demo1234';

interface StoreLike {
  getState(): any;
  setState(partial: any): void;
}

export interface SyncHooks {
  onError(message: string): void;
  onInfo?(message: string): void;
  getTokens(): Tokens | null | Promise<Tokens | null>;
}

const byId = <T extends { id: string }>(base: T[], over: T[]) => {
  const m = new Map(base.map((x) => [x.id, x]));
  for (const x of over) m.set(x.id, x);
  return [...m.values()];
};

export function installRemote(store: StoreLike, api: Api, hooks: SyncHooks) {
  // Optimistic prototype actions may look up data the API session doesn't have (e.g. the admin user from a
  // seller's browser). They are best-effort: a failure there must never block the real API call.
  const orig = Object.fromEntries(
    Object.entries(store.getState()).map(([k, v]) => [
      k,
      typeof v === 'function'
        ? (...a: unknown[]) => {
            try {
              return (v as (...x: unknown[]) => unknown)(...a);
            } catch (e) {
              if (typeof console !== 'undefined') console.warn(`[optimistic ${k}] skipped:`, (e as Error)?.message);
              return undefined;
            }
          }
        : v,
    ]),
  ) as Record<string, any>;
  let inflight = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let catalog: R.Remote | null = null;
  const debouncers = new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => Promise<void> }>();

  const S = () => store.getState();
  const tt = (it: string, en: string) => (S().lang === 'en' ? en : it);
  const set = (p: any) => store.setState(p);
  const fail = (e: unknown) => {
    hooks.onError(errorText(e));
    scheduleRefresh(50);
  };

  /** apply catalog + session to the store (union by id, session wins) */
  function apply(cat: R.Remote | null, ses: (R.Remote & { user?: User }) | null) {
    const data: any = emptyDB();
    for (const src of [cat?.data, ses?.data])
      if (src) for (const [k, v] of Object.entries(src)) data[k] = byId(data[k] ?? [], v as any[]);
    const patch: any = { ...data, busy: cat?.busy ?? S().busy };
    if (ses) {
      patch.userId = ses.user?.id ?? null;
      if (ses.favSalons) patch.favSalons = ses.favSalons;
      if (ses.favProducts) patch.favProducts = ses.favProducts;
      patch.wallet = ses.wallet ?? null;
      patch.withdrawals = ses.withdrawals ?? [];
      patch.settings = ses.settings ?? null;
    } else {
      patch.userId = null;
      patch.wallet = null;
      patch.withdrawals = [];
      patch.settings = null;
    }
    set(patch);
  }

  async function refresh() {
    set({ sync: { ...S().sync, loading: true } });
    try {
      catalog = await R.loadCatalog(api);
      const ses = (await api.hasSession()) ? await R.loadSession(api).catch((e) => (e instanceof ApiError && e.status === 401 ? null : Promise.reject(e))) : null;
      apply(catalog, ses);
      set({ sync: { ready: true, loading: false, error: null, at: new Date().toISOString() } });
    } catch (e) {
      set({ sync: { ...S().sync, loading: false, error: errorText(e) } });
      throw e;
    }
  }

  function scheduleRefresh(delay = 350) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (inflight > 0 || debouncers.size > 0) return scheduleRefresh(250);
      refresh().catch(() => undefined);
    }, delay);
  }

  /** run an API call tied to an optimistic change */
  // Writes run ONE AT A TIME in the order the user made them (e.g. "save checklist" must land before "approve").
  let queue: Promise<unknown> = Promise.resolve();
  async function track<T>(p: () => Promise<T>, opts: { refresh?: boolean; info?: (r: T) => string | null } = {}) {
    inflight++;
    const run = queue.then(() => p());
    queue = run.catch(() => undefined);
    try {
      const r = await run;
      const msg = opts.info?.(r);
      if (msg) hooks.onInfo?.(msg);
      return r;
    } catch (e) {
      fail(e);
      return undefined;
    } finally {
      inflight--;
      if (opts.refresh !== false) scheduleRefresh();
    }
  }

  /** collapse rapid edits (typing in a form) into one request */
  function debounce(key: string, run: () => Promise<void>, ms = 700) {
    const prev = debouncers.get(key);
    if (prev) clearTimeout(prev.timer);
    const entry = {
      run,
      timer: setTimeout(async () => {
        debouncers.delete(key);
        await track(run);
      }, ms),
    };
    debouncers.set(key, entry);
  }
  async function flush() {
    const all = [...debouncers.entries()];
    debouncers.clear();
    for (const [, d] of all) {
      clearTimeout(d.timer);
      await track(d.run, { refresh: false });
    }
  }

  /** a create returned the real server id → replace the temporary client id everywhere it is referenced */
  function swapId(kind: 'services' | 'products' | 'staff' | 'coupons', tempId: string, real: { id: string } | undefined) {
    if (!real || real.id === tempId) return;
    const st = S();
    const patch: any = { [kind]: st[kind].map((x: any) => (x.id === tempId ? real : x)) };
    if (kind === 'services') patch.staff = st.staff.map((m: Staff) => (m.serviceIds?.includes(tempId) ? { ...m, serviceIds: m.serviceIds.map((i) => (i === tempId ? real.id : i)) } : m));
    set(patch);
  }

  const me = (): User | null => S().users.find((u: User) => u.id === S().userId) ?? null;
  const appIdFor = (salonId: string) => S().applications.find((a: SellerApplication) => a.salonId === salonId)?.id as string | undefined;

  // pending business/salon patches accumulate between debounced saves
  let appPatch: Partial<SellerApplication> = {};
  let salonPatch: Partial<Salon> = {};

  const wrapped: Record<string, any> = {
    // ── session ──
    login: () => null, // password needed → pages call apiLogin
    loginAs: (userId: string) => {
      const email = DEMO_ACCOUNTS[userId];
      if (email) wrapped.apiLogin(email, DEMO_PASSWORD).catch((e: unknown) => hooks.onError(errorText(e)));
    },
    logout: () => {
      const tokens = hooks.getTokens();
      Promise.resolve(tokens).then((t) => R.logout(api, t));
      apply(catalog, null);
    },
    resetDemo: () => hooks.onInfo?.(tt('Con il backend attivo i dati vivono sul server: per ripristinarli esegui "npm run seed" nella cartella apps/api.', 'With the backend on, data lives on the server: run "npm run seed" in apps/api to reset it.')),
    setLang: (lang: 'it' | 'en') => {
      orig.setLang(lang);
      if (S().userId) track(() => api.patch('/me', { lang }), { refresh: false });
    },
    registerCustomer: () => {
      throw new Error('Use apiRegister in API mode');
    },
    registerSeller: () => {
      throw new Error('Use apiRegister in API mode');
    },

    // ── customer ──
    toggleFavSalon: (id: string) => {
      orig.toggleFavSalon(id);
      if (S().userId) track(() => R.toggleFavourite(api, 'salon', id), { refresh: false });
    },
    toggleFavProduct: (id: string) => {
      orig.toggleFavProduct(id);
      if (S().userId) track(() => R.toggleFavourite(api, 'product', id), { refresh: false });
    },
    cancelBooking: (id: string) => {
      orig.cancelBooking(id);
      track(() => R.cancelBooking(api, id), { info: (r) => (r.refunded > 0 ? tt(`Rimborso di €${r.refunded.toFixed(2)} in arrivo sulla carta`, `Refund of €${r.refunded.toFixed(2)} on its way to your card`) : r.lateCancellation ? tt('Cancellazione tardiva: la caparra resta al salone', 'Late cancellation: the deposit stays with the salon') : null) });
    },
    rescheduleBooking: (id: string, date: string, time: string) => {
      orig.rescheduleBooking(id, date, time);
      track(() => R.rescheduleBooking(api, id, date, time));
    },
    addReview: (d: { bookingId?: string; productId?: string; rating: number; text: string }) => {
      orig.addReview(d);
      track(() => R.addReview(api, { bookingId: d.bookingId, productId: d.bookingId ? undefined : d.productId, rating: d.rating, text: d.text }));
    },
    requestReturn: (subOrderId: string, reason = 'Reso richiesto dal cliente') => {
      const so = S().subOrders.find((x: any) => x.id === subOrderId);
      orig.requestReturn(subOrderId);
      if (so) track(() => R.requestReturn(api, so.orderId, subOrderId, reason));
    },
    saveAddress: (a: any) => {
      const isNew = !(me()?.addresses ?? []).some((x) => x.id === a.id);
      orig.saveAddress(a);
      track(() => R.saveAddress(api, a, isNew));
    },
    removeAddress: (id: string) => {
      orig.removeAddress(id);
      track(() => R.removeAddress(api, id));
    },
    updateProfile: (p: Partial<User>) => {
      orig.updateProfile(p);
      const body: any = {};
      for (const k of ['name', 'phone', 'city', 'avatar'] as const) if (p[k] !== undefined) body[k] = p[k];
      if (Object.keys(body).length) track(() => R.updateProfile(api, body));
    },
    markNotificationsRead: () => {
      orig.markNotificationsRead();
      track(() => R.markNotificationsRead(api), { refresh: false });
    },

    // ── seller ──
    saveApplication: (patch: Partial<SellerApplication>) => {
      const before: SellerApplication | undefined = S().applications.find((a: SellerApplication) => a.salonId === me()?.salonId);
      orig.saveApplication(patch);
      if (patch.documents && before) {
        const keep = new Set(patch.documents.map((d) => d.id));
        for (const d of before.documents) if (!keep.has(d.id)) track(() => R.removeDocument(api, d.id));
      }
      const { documents: _d, status: _s, checklist: _c, ...business } = patch as any;
      if (Object.keys(business).length) {
        appPatch = { ...appPatch, ...business };
        debounce('application', async () => {
          const p = appPatch;
          appPatch = {};
          await R.saveApplication(api, p);
        });
      }
    },
    updateSalon: (id: string, patch: Partial<Salon>) => {
      orig.updateSalon(id, patch);
      const u = me();
      if (u?.role === 'seller' && u.salonId === id) {
        salonPatch = { ...salonPatch, ...patch };
        debounce('salon', async () => {
          const p = salonPatch;
          salonPatch = {};
          await R.updateSalon(api, p);
        });
      } else if (u?.role === 'admin') {
        const admin: any = {};
        if (patch.featured !== undefined) admin.featured = patch.featured;
        if (patch.commissionRate !== undefined) admin.commissionRate = patch.commissionRate;
        if (Object.keys(admin).length) track(() => R.updateSalonAdmin(api, id, admin));
      }
    },
    submitApplication: () => {
      orig.submitApplication();
      track(async () => {
        await flush();
        return R.submitApplication(api);
      });
    },
    upsertService: (sv: Service) => {
      const isNew = !S().services.some((x: Service) => x.id === sv.id);
      orig.upsertService(sv);
      track(() => R.saveService(api, sv, isNew)).then((r) => isNew && swapId('services', sv.id, r));
    },
    // ── time windows ──
    createWindows: async (input: WindowInput) => {
      const r = await R.createWindows(api, input);
      set({ windows: byId(S().windows, r.created) });
      scheduleRefresh();
      return r;
    },
    updateWindow: (id: string, p: Partial<TimeWindow>) => {
      orig.updateWindow(id, p);
      track(() => R.updateWindow(api, id, p));
    },
    deleteWindow: (id: string) => {
      orig.deleteWindow(id);
      track(() => R.deleteWindow(api, id));
    },
    deleteService: (id: string) => {
      orig.deleteService(id);
      track(() => R.deleteService(api, id));
    },
    upsertProduct: (p: Product) => {
      const known = S().products.find((x: Product) => x.id === p.id);
      orig.upsertProduct(p);
      track(() => R.saveProduct(api, p, known).then((r) => (known ? r : (swapId('products', p.id, r), r))), { info: (r) => (r.status === 'review' && known?.status === 'published' ? tt('Modifica inviata in revisione: il prodotto tornerà visibile dopo l’approvazione', 'Change sent for review: the product will be visible again once approved') : null) });
    },
    deleteProduct: (id: string) => {
      orig.deleteProduct(id);
      track(() => R.deleteProduct(api, id));
    },
    upsertStaff: (m: Staff) => {
      const isNew = !S().staff.some((x: Staff) => x.id === m.id);
      orig.upsertStaff(m);
      track(() => R.saveStaff(api, m, isNew)).then((r) => isNew && swapId('staff', m.id, r));
    },
    setBookingStatus: (id: string, status: Booking['status']) => {
      orig.setBookingStatus(id, status);
      track(() => R.setBookingStatus(api, id, status));
    },
    addWalkIn: (b: Booking) => {
      orig.addWalkIn(b);
      track(() => R.walkIn(api, { customerName: b.customerName, customerPhone: b.customerPhone ?? '', serviceIds: b.serviceIds, staffId: b.staffId, date: b.date, time: b.time, notes: b.notes, force: true }));
    },
    setSubOrderStatus: (id: string, status: any, tracking?: string) => {
      orig.setSubOrderStatus(id, status, tracking);
      track(() => R.setSubOrderStatus(api, id, status, tracking));
    },
    replyReview: (id: string, reply: string) => {
      orig.replyReview(id, reply);
      track(() => R.replyReview(api, id, reply));
    },
    upsertCoupon: (c: Coupon) => {
      const isNew = !S().coupons.some((x: Coupon) => x.id === c.id);
      orig.upsertCoupon(c);
      track(() => R.saveCoupon(api, c, isNew, me()?.role === 'admin')).then((r) => isNew && swapId('coupons', c.id, r));
    },

    // ── admin ──
    approveApplication: (salonId: string) => {
      orig.approveApplication(salonId);
      const id = appIdFor(salonId);
      if (id) track(() => R.approveApplication(api, id));
    },
    rejectApplication: (salonId: string, reason: string) => {
      orig.rejectApplication(salonId, reason);
      const id = appIdFor(salonId);
      if (id) track(() => R.rejectApplication(api, id, reason));
    },
    requestInfo: (salonId: string, reason: string) => {
      orig.requestInfo(salonId, reason);
      const id = appIdFor(salonId);
      if (id) track(() => R.requestInfo(api, id, reason));
    },
    setSalonStatus: (salonId: string, status: Salon['status']) => {
      orig.setSalonStatus(salonId, status);
      if (status === 'approved' || status === 'suspended') track(() => R.updateSalonAdmin(api, salonId, { status }));
      else fail(new Error(tt('Dal pannello si può solo riattivare o sospendere un salone', 'From the panel you can only reactivate or suspend a salon')));
    },
    setCommission: (salonId: string, rate: number) => {
      orig.setCommission(salonId, rate);
      track(() => R.updateSalonAdmin(api, salonId, { commissionRate: rate }));
    },
    toggleFeatured: (salonId: string) => {
      const cur = S().salons.find((x: Salon) => x.id === salonId);
      orig.toggleFeatured(salonId);
      track(() => R.updateSalonAdmin(api, salonId, { featured: !cur?.featured }));
    },
    moderateProduct: (id: string, ok: boolean, reason?: string) => {
      orig.moderateProduct(id, ok, reason);
      track(() => R.moderateProduct(api, id, ok, reason));
    },
    setReviewHidden: (id: string, hidden: boolean) => {
      orig.setReviewHidden(id, hidden);
      track(() => R.setReviewFlags(api, id, { hidden, reported: false }));
    },
    markPayoutPaid: () => hooks.onInfo?.(tt('I pagamenti ai saloni ora passano dai prelievi Stripe (sezione Prelievi).', 'Salon payouts now go through Stripe withdrawals (Withdrawals section).')),
    toggleBanner: (id: string) => {
      orig.toggleBanner(id);
      const b = S().banners.find((x: any) => x.id === id);
      if (b) track(() => R.saveBanner(api, b));
    },
    setUserBlocked: (id: string, blocked: boolean) => {
      orig.setUserBlocked(id, blocked);
      track(() => R.setUserBlocked(api, id, blocked));
    },
    setTicketStatus: (id: string, status: 'open' | 'closed') => {
      orig.setTicketStatus(id, status);
      track(() => R.setTicketStatus(api, id, status));
    },
    setApplicationNotes: (salonId: string, notes: string, checklist?: SellerApplication['checklist']) => {
      orig.setApplicationNotes(salonId, notes, checklist);
      const id = appIdFor(salonId);
      if (id && checklist) track(() => R.setChecklist(api, id, checklist), { refresh: false });
    },

    // ── API-only async actions ──
    bootstrap: async () => {
      try {
        const cfg = await R.paymentConfig(api).catch(() => null);
        if (cfg) set({ paymentMode: cfg.mode, publishableKey: cfg.publishableKey });
        await refresh();
      } catch {
        /* sync.error is set; the app shows a retry screen */
      }
    },
    refresh: () => refresh(),
    apiLogin: async (email: string, password: string) => {
      const s = await R.login(api, email.trim().toLowerCase(), password);
      if ((s.user as User & { lang?: string }).lang !== S().lang) await api.patch('/me', { lang: S().lang }).catch(() => undefined);
      await refresh();
      return s.user as User;
    },
    apiRegister: async (body: Parameters<typeof R.register>[1]) => {
      const s = await R.register(api, body);
      await refresh();
      return s.user as User;
    },
    apiForgot: (email: string) => R.forgotPassword(api, email),
    apiReset: (token: string, password: string) => R.resetPassword(api, token, password),
    apiCreateBooking: async (b: Parameters<typeof R.createBooking>[1]) => {
      const r = await R.createBooking(api, b);
      set({ bookings: byId(S().bookings, [r.booking]) });
      scheduleRefresh();
      return r;
    },
    apiQuote: (lines: any, couponCode?: string | null, shipping?: any) => R.quoteCart(api, lines, couponCode, shipping),
    apiCheckout: async (body: Parameters<typeof R.checkout>[1]) => {
      const r = await R.checkout(api, body);
      return r;
    },
    apiPayBooking: (id: string) => R.payBooking(api, id),
    /** mock mode: simulate the card payment; stripe mode: poll until the webhook marked it paid */
    apiConfirmPayment: async (paymentId: string) => {
      if (S().paymentMode === 'mock') await R.mockConfirm(api, paymentId);
      else
        for (let i = 0; i < 20; i++) {
          const st = await R.paymentStatus(api, paymentId);
          if (st.status === 'succeeded') break;
          if (st.status === 'failed') throw new Error(tt('Pagamento non riuscito', 'Payment failed'));
          await new Promise((r) => setTimeout(r, 1000));
        }
      await refresh();
    },
    uploadImages: (files: unknown[], names?: string[]) => R.uploadImages(api, files, names),
    addSellerDocuments: async (type: 'visura' | 'id' | 'license' | 'other', files: { file: unknown; name: string }[]) => {
      for (const f of files) await R.addDocument(api, type, f.file, f.name);
      await refresh();
    },
    refreshWallet: async () => set({ wallet: await R.getWallet(api) }),
    apiWithdraw: async () => {
      const w = await R.requestWithdrawal(api);
      await refresh();
      return w;
    },
    apiStripeOnboarding: (returnUrl: string) => R.stripeOnboarding(api, returnUrl),
    apiStripeStatus: () => R.stripeStatus(api),
    apiApproveWithdrawal: async (id: string) => {
      try {
        await R.approveWithdrawal(api, id);
      } finally {
        await refresh();
      }
    },
    apiRejectWithdrawal: async (id: string, reason: string) => {
      await R.rejectWithdrawal(api, id, reason);
      await refresh();
    },
    apiSaveSettings: async (p: Partial<R.PlatformSettings>) => set({ settings: await R.saveSettings(api, p) }),
    apiDocumentUrl: async (salonId: string, docId: string) => {
      const id = appIdFor(salonId);
      if (!id) return null;
      const d = await R.applicationDetail(api, id);
      return d.application.documents.find((x) => x.id === docId)?.url ?? null;
    },
    apiSalonWallet: (salonId: string) => R.salonWallet(api, salonId),
    apiSendTicket: (t: Parameters<typeof R.sendTicket>[1]) => R.sendTicket(api, t),
  };

  set({ ...initialSyncState(), ...wrapped });
  return wrapped;
}

export type RemoteActions = {
  bootstrap(): Promise<void>;
  refresh(): Promise<void>;
  apiLogin(email: string, password: string): Promise<User>;
  apiRegister(body: Parameters<typeof R.register>[1]): Promise<User>;
  apiForgot(email: string): Promise<unknown>;
  apiReset(token: string, password: string): Promise<unknown>;
  apiCreateBooking(b: Parameters<typeof R.createBooking>[1]): Promise<{ booking: Booking; payment: R.PaymentStart | null }>;
  apiQuote(...a: [Parameters<typeof R.quoteCart>[1], string | null | undefined, Record<string, 'standard' | 'pickup'> | undefined]): ReturnType<typeof R.quoteCart>;
  apiCheckout(body: Parameters<typeof R.checkout>[1]): ReturnType<typeof R.checkout>;
  apiPayBooking(id: string): Promise<R.PaymentStart>;
  apiConfirmPayment(paymentId: string): Promise<void>;
  uploadImages(files: unknown[], names?: string[]): Promise<string[]>;
  addSellerDocuments(type: 'visura' | 'id' | 'license' | 'other', files: { file: unknown; name: string }[]): Promise<void>;
  refreshWallet(): Promise<void>;
  apiWithdraw(): Promise<R.Withdrawal>;
  apiStripeOnboarding(returnUrl: string): Promise<{ url: string }>;
  apiStripeStatus(): ReturnType<typeof R.stripeStatus>;
  apiApproveWithdrawal(id: string): Promise<void>;
  apiRejectWithdrawal(id: string, reason: string): Promise<void>;
  apiSaveSettings(p: Partial<R.PlatformSettings>): Promise<void>;
  apiDocumentUrl(salonId: string, docId: string): Promise<string | null>;
  apiSalonWallet(salonId: string): ReturnType<typeof R.salonWallet>;
  apiSendTicket(t: Parameters<typeof R.sendTicket>[1]): ReturnType<typeof R.sendTicket>;
};
