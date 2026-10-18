/**
 * Everything the web and mobile stores need from the API, expressed in the SAME shapes the screens already use
 * (types.ts). Loaders return partial DB collections that the stores merge; mutations return the server's version.
 */
import type {
  TimeWindow,
  Address, Banner, Booking, BookingStatus, Coupon, Notification, Order, Product, Review, Salon, SellerApplication, Service,
  Staff, SubOrder, SubOrderStatus, SupportTicket, User,
} from '../types';
import type { DB } from '../mock/seed';
import type { WindowInput, WindowSkip } from '../windows';
import type { Api, Tokens } from './client';

// ───────────── extra (API-only) shapes ─────────────
export interface BusyBlock { id: string; salonId: string; staffId: string | null; date: string; time: string; durationMin: number; status: BookingStatus }
export interface MoneySum { gross: number; commission: number; net: number }
export interface LedgerLine { id: string; type: 'sale' | 'cash_commission' | 'refund' | 'adjustment'; amount: number; commissionRate: number; commission: number; net: number; sourceType: string; sourceId: string; description: string; status: 'pending' | 'available' | 'withdrawn'; availableAt?: string; withdrawalId?: string; createdAt: string }
export interface Withdrawal { id: string; salonId: string; gross: number; commission: number; net: number; status: 'requested' | 'approved' | 'paid' | 'rejected' | 'failed'; auto: boolean; stripeTransferId?: string; failureReason?: string; requestedAt: string; decidedAt?: string; paidAt?: string; salon?: { id: string; name: string; stripePayoutsReady: boolean; stripeAccountId: string | null } }
export interface Wallet {
  commissionRate: number; minWithdrawal: number; pending: MoneySum; available: MoneySum; inProgress: MoneySum; withdrawn: MoneySum;
  nextReleaseAt: string | null; canWithdraw: boolean; openWithdrawal: Withdrawal | null;
  stripe: { accountId: string | null; payoutsReady: boolean; mode: 'stripe' | 'mock' };
  ledger: LedgerLine[]; withdrawals: Withdrawal[];
}
export interface PlatformSettings { defaultCommissionRate: number; minWithdrawal: number; withdrawalAutoApprove: boolean; autoWithdrawAfterDays: number; bookingReleaseHours: number; returnWindowDays: number; autoDeliverAfterDays: number; paymentHoldMinutes: number; commissionOnCash: boolean; freeCancellationHours: number; supportEmail: string }
export interface PaymentStart { clientSecret: string; amount: number; provider: 'stripe' | 'mock'; paymentId: string }
export interface PaymentConfig { mode: 'stripe' | 'mock'; publishableKey: string | null }

export interface Remote {
  /** collections to merge into the store */
  data: Partial<DB>;
  busy?: BusyBlock[];
  favSalons?: string[];
  favProducts?: string[];
  wallet?: Wallet | null;
  withdrawals?: Withdrawal[];
  settings?: PlatformSettings;
}

type Session = { user: User; salon: Salon | null; accessToken: string; refreshToken: string };

const qs = (o: Record<string, string | number | undefined>) =>
  Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
const isoOffset = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const soft = async <T,>(p: Promise<T>, fallback: T) => {
  try {
    return await p;
  } catch {
    return fallback;
  }
};

type ApiOrder = Order & { subOrders?: SubOrder[]; status?: string };
const splitOrders = (rows: ApiOrder[]) => ({
  orders: rows.map(({ subOrders: _s, ...o }) => o as Order),
  subOrders: rows.flatMap((o) => o.subOrders ?? []),
});

// ───────────── loaders ─────────────

export async function loadCatalog(api: Api): Promise<Remote> {
  const c = await api.get<{ salons: Salon[]; services: Service[]; staff: Staff[]; products: Product[]; reviews: Review[]; banners: Banner[]; busy: BusyBlock[]; windows?: TimeWindow[] }>('/catalog');
  return { data: { salons: c.salons, services: c.services, staff: c.staff, products: c.products, reviews: c.reviews, banners: c.banners, windows: c.windows ?? [] }, busy: c.busy };
}

/** Role-specific data after login / app start. Merged ON TOP of the catalog (same ids replace). */
export async function loadSession(api: Api): Promise<Remote & { user: User; salon: Salon | null }> {
  const me = await api.get<{ user: User; salon: Salon | null }>('/auth/me');
  const notifications = await soft(api.get<Notification[]>('/me/notifications'), []);
  const user = me.user;

  if (user.role === 'customer') {
    const [bookings, orders, fav, reviews, tickets] = await Promise.all([
      api.get<Booking[]>('/me/bookings'),
      api.get<ApiOrder[]>('/me/orders'),
      api.get<{ salons: string[]; products: string[] }>('/me/favourites'),
      api.get<Review[]>('/me/reviews'),
      soft(api.get<SupportTicket[]>('/me/tickets'), []),
    ]);
    return { user, salon: null, data: { users: [user], bookings, ...splitOrders(orders), notifications, reviews, tickets }, favSalons: fav.salons, favProducts: fav.products };
  }

  if (user.role === 'seller') {
    const app = await api.get<{ application: SellerApplication; salon: Salon }>('/seller/application');
    const salon = app.salon;
    const approved = salon.status === 'approved';
    const [services, products, staff, coupons, reviews, agenda, subs, wallet, windows] = await Promise.all([
      api.get<Service[]>('/seller/services'),
      api.get<Product[]>('/seller/products'),
      api.get<Staff[]>('/seller/staff'),
      api.get<Coupon[]>('/seller/coupons'),
      api.get<Review[]>('/seller/reviews'),
      approved ? api.get<Booking[]>(`/seller/agenda?${qs({ from: isoOffset(-120), to: isoOffset(120) })}`) : Promise.resolve([] as Booking[]),
      approved ? api.get<(SubOrder & { order: { code: string; customerName: string; address?: Address; createdAt: string } })[]>('/seller/orders') : Promise.resolve([]),
      approved ? soft(api.get<Wallet>('/seller/wallet'), null) : Promise.resolve(null),
      soft(api.get<TimeWindow[]>(`/seller/windows?${qs({ from: isoOffset(-30), to: isoOffset(90) })}`), [] as TimeWindow[]),
    ]);
    const orders: Order[] = [];
    for (const s of subs)
      if (!orders.some((o) => o.id === s.orderId))
        orders.push({ id: s.orderId, code: s.order.code, customerId: '', customerName: s.order.customerName, createdAt: s.order.createdAt, address: s.order.address, paymentMethod: 'card', discount: 0, total: 0, subOrderIds: subs.filter((x) => x.orderId === s.orderId).map((x) => x.id) });
    // customers seen by the salon (names/phones only; needed by agenda + clients pages)
    const users: User[] = [user];
    for (const b of agenda)
      if (b.customerId && !users.some((u) => u.id === b.customerId))
        users.push({ id: b.customerId, role: 'customer', name: b.customerName, email: '', phone: b.customerPhone, createdAt: b.createdAt, addresses: [] });
    return {
      user, salon,
      data: { users, salons: [salon], applications: [app.application], services, products, staff, coupons, reviews, bookings: agenda, windows, subOrders: subs.map(({ order: _o, ...s }) => s as SubOrder), orders, notifications },
      wallet,
    };
  }

  // admin
  const [applications, salons, products, users, bookings, orders, reviews, coupons, banners, tickets, withdrawals, settings] = await Promise.all([
    api.get<(SellerApplication & { salon: Salon })[]>('/admin/applications'),
    api.get<Salon[]>('/admin/salons'),
    api.get<Product[]>('/admin/products?status=all'),
    api.get<{ items: User[] }>('/admin/users?pageSize=200'),
    api.get<{ items: Booking[] }>('/admin/bookings?pageSize=200'),
    api.get<{ items: ApiOrder[] }>('/admin/orders?pageSize=200'),
    api.get<Review[]>('/admin/reviews'),
    api.get<Coupon[]>('/admin/coupons'),
    api.get<Banner[]>('/admin/banners'),
    api.get<SupportTicket[]>('/admin/tickets'),
    api.get<Withdrawal[]>('/admin/withdrawals'),
    api.get<PlatformSettings>('/admin/settings'),
  ]);
  const allUsers = users.items.some((u) => u.id === user.id) ? users.items : [user, ...users.items];
  return {
    user, salon: null,
    data: { applications: applications.map(({ salon: _s, ...a }) => a as SellerApplication), salons, products, users: allUsers, bookings: bookings.items, ...splitOrders(orders.items), reviews, coupons, banners, tickets, notifications },
    withdrawals, settings,
  };
}

// ───────────── auth ─────────────
export async function login(api: Api, email: string, password: string) {
  const s = await api.post<Session>('/auth/login', { email, password });
  await api.setTokens({ accessToken: s.accessToken, refreshToken: s.refreshToken });
  return s;
}
export async function register(api: Api, body: { role: 'customer' | 'seller'; name: string; email: string; phone: string; password: string; city?: string; salonName?: string; salonCategory?: Salon['category'] }) {
  const s = await api.post<Session>('/auth/register', { ...body, acceptTerms: true });
  await api.setTokens({ accessToken: s.accessToken, refreshToken: s.refreshToken });
  return s;
}
export async function logout(api: Api, tokens: Tokens | null) {
  if (tokens?.refreshToken) await soft(api.post('/auth/logout', { refreshToken: tokens.refreshToken }), null);
  await api.setTokens(null);
}
export const forgotPassword = (api: Api, email: string) => api.post('/auth/forgot', { email });
export const resetPassword = (api: Api, token: string, password: string) => api.post('/auth/reset', { token, password });

// ───────────── uploads ─────────────
/** `file` = browser File/Blob, or React Native { uri, name, type } */
export async function uploadImages(api: Api, files: unknown[], names?: string[]): Promise<string[]> {
  const form = new FormData();
  files.forEach((f, i) => form.append('files', f as Blob, names?.[i] ?? `photo-${i}.jpg`));
  const r = await api.upload<{ files: { url: string }[] }>('/uploads', form);
  return r.files.map((f) => f.url);
}
export async function uploadPrivate(api: Api, file: unknown, name: string): Promise<string> {
  const form = new FormData();
  form.append('file', file as Blob, name);
  return (await api.upload<{ key: string }>('/uploads/private', form)).key;
}

// ───────────── customer ─────────────
export const createBooking = (api: Api, b: { salonId: string; serviceIds: string[]; staffId: string | null; date?: string; time?: string; windowId?: string | null; paymentMode: Booking['paymentMode']; notes?: string; pickupProductIds?: string[] }) =>
  api.post<{ booking: Booking; payment: PaymentStart | null }>('/bookings', b);
export const payBooking = (api: Api, id: string) => api.post<PaymentStart>(`/bookings/${id}/pay`);
export const cancelBooking = (api: Api, id: string, reason?: string) => api.post<{ ok: boolean; refunded: number; lateCancellation: boolean }>(`/bookings/${id}/cancel`, { reason });
export const rescheduleBooking = (api: Api, id: string, date: string, time: string, staffId?: string | null) => api.post<Booking>(`/bookings/${id}/reschedule`, { date, time, staffId });
export const quoteCart = (api: Api, lines: { productId: string; variantId?: string; qty: number }[], couponCode?: string | null, shipping?: Record<string, 'standard' | 'pickup'>) =>
  api.post<{ groups: { salonId: string; salonName: string; shippingMethod: 'standard' | 'pickup'; subtotal: number; shippingFee: number; discount: number }[]; subtotal: number; shipping: number; discount: number; total: number; coupon: { code: string; scope: string; error?: string } | null; problems: { productId: string; code: string; available?: number }[] }>('/cart/quote', { lines, couponCode, shipping });
export const checkout = (api: Api, body: { lines: { productId: string; variantId?: string; qty: number }[]; couponCode?: string | null; shipping: Record<string, 'standard' | 'pickup'>; addressId?: string; address?: Omit<Address, 'id' | 'isDefault'> }) =>
  api.post<{ order: ApiOrder; payment: PaymentStart }>('/checkout', body);
export const paymentConfig = (api: Api) => api.get<PaymentConfig>('/payments/config');
export const paymentStatus = (api: Api, id: string) => api.get<{ status: string }>(`/payments/${id}`);
export const mockConfirm = (api: Api, id: string, outcome: 'succeeded' | 'failed' = 'succeeded') => api.post<{ status: string }>(`/payments/${id}/mock-confirm`, { outcome });
export const requestReturn = (api: Api, orderId: string, subOrderId: string, reason: string) => api.post(`/orders/${orderId}/return`, { subOrderId, reason });
export const addReview = (api: Api, r: { bookingId?: string; productId?: string; rating: number; text: string }) => api.post<Review>('/reviews', r);
export const toggleFavourite = (api: Api, kind: 'salon' | 'product', id: string) => api.post<{ favourite: boolean }>('/me/favourites/toggle', { kind, id });
export const updateProfile = (api: Api, p: Partial<Pick<User, 'name' | 'phone' | 'city' | 'avatar'>>) => api.patch<User>('/me', p);
export async function saveAddress(api: Api, a: Address, isNew: boolean) {
  const body = { label: a.label, name: a.name, street: a.street, city: a.city, zip: a.zip, province: a.province, phone: a.phone, isDefault: !!a.isDefault };
  return isNew ? api.post<Address>('/me/addresses', body) : api.put<Address>(`/me/addresses/${a.id}`, body);
}
export const removeAddress = (api: Api, id: string) => api.del(`/me/addresses/${id}`);
export const markNotificationsRead = (api: Api) => api.post('/me/notifications/read', {});
export const sendTicket = (api: Api, t: { email?: string; name?: string; subject: string; message: string }) => api.post<SupportTicket>('/support/tickets', t);

// ───────────── seller ─────────────
const BUSINESS_KEYS = ['ragioneSociale', 'pIva', 'codiceFiscale', 'sdi', 'pec', 'legalAddress', 'iban', 'accountHolder'] as const;
const SALON_KEYS = ['name', 'tagline', 'description', 'category', 'city', 'address', 'zip', 'lat', 'lng', 'phone', 'email', 'cover', 'logo', 'gallery', 'hours', 'amenities', 'policies', 'priceLevel'] as const;
const pick = <T extends object>(o: Partial<T>, keys: readonly string[]) => Object.fromEntries(Object.entries(o).filter(([k, v]) => keys.includes(k) && v !== undefined));

export async function saveApplication(api: Api, business: Partial<SellerApplication>, salon: Partial<Salon> = {}) {
  const b = pick(business, BUSINESS_KEYS);
  const s = pick(salon, SALON_KEYS);
  return api.put<{ application: SellerApplication; salon: Salon }>('/seller/application', { ...(Object.keys(b).length ? { business: b } : {}), ...(Object.keys(s).length ? { salon: s } : {}) });
}
export const updateSalon = (api: Api, patch: Partial<Salon>) => api.patch<Salon>('/seller/salon', pick(patch, SALON_KEYS));
export async function addDocument(api: Api, type: 'visura' | 'id' | 'license' | 'other', file: unknown, name: string) {
  const key = await uploadPrivate(api, file, name);
  return api.post<{ id: string; type: string; name: string; uploadedAt: string }>('/seller/application/documents', { type, name, key });
}
export const removeDocument = (api: Api, id: string) => api.del(`/seller/application/documents/${id}`);
export const submitApplication = (api: Api) => api.post('/seller/application/submit', { acceptSellerTerms: true });

export function serviceBody(s: Service) {
  return { category: s.category, name: s.name, description: s.description ?? '', images: s.images?.length ? s.images : [s.image].filter(Boolean), durationMin: s.durationMin, price: s.price, bufferMin: s.bufferMin ?? 0, depositPct: s.depositPct ?? 0, active: s.active, popular: !!s.popular };
}
export const saveService = (api: Api, s: Service, isNew: boolean) => (isNew ? api.post<Service>('/seller/services', serviceBody(s)) : api.put<Service>(`/seller/services/${s.id}`, serviceBody(s)));
export const deleteService = (api: Api, id: string) => api.del(`/seller/services/${id}`);

export function productBody(p: Product, known: Product | undefined) {
  const knownVariants = new Set(known?.variants.map((v) => v.id) ?? []);
  return {
    brand: p.brand, category: p.category, name: p.name, short: p.short ?? '', description: p.description ?? '', images: p.images, price: p.price,
    compareAtPrice: p.compareAtPrice ?? null, stock: p.stock, sku: p.sku ?? '', inci: p.inci ?? '', howToUse: p.howToUse ?? '', weightGr: p.weightGr ?? 0, isNew: !!p.isNew,
    variants: p.variants.map((v) => ({ ...(knownVariants.has(v.id) ? { id: v.id } : {}), label: v.label, priceDelta: v.priceDelta, stock: v.stock })),
    submit: p.status !== 'draft',
  };
}
export const saveProduct = (api: Api, p: Product, known: Product | undefined) => (known ? api.put<Product>(`/seller/products/${p.id}`, productBody(p, known)) : api.post<Product>('/seller/products', productBody(p, undefined)));
export const deleteProduct = (api: Api, id: string) => api.del(`/seller/products/${id}`);

export function staffBody(s: Staff) {
  return { name: s.name, role: s.role ?? '', photo: s.photo ?? '', bio: s.bio ?? '', serviceIds: s.serviceIds ?? [], workingDays: s.workingDays ?? [], active: s.active };
}
export const saveStaff = (api: Api, s: Staff, isNew: boolean) => (isNew ? api.post<Staff>('/seller/staff', staffBody(s)) : api.put<Staff>(`/seller/staff/${s.id}`, staffBody(s)));
export const deleteStaff = (api: Api, id: string) => api.del(`/seller/staff/${id}`);

export function couponBody(c: Coupon) {
  return { code: c.code, type: c.type, value: c.value, minSpend: c.minSpend, maxUses: c.maxUses, active: c.active, expiresAt: c.expiresAt };
}
export const saveCoupon = (api: Api, c: Coupon, isNew: boolean, admin = false) =>
  admin
    ? isNew ? api.post<Coupon>('/admin/coupons', couponBody(c)) : api.patch<Coupon>(`/admin/coupons/${c.id}`, { active: c.active, maxUses: c.maxUses, expiresAt: c.expiresAt })
    : isNew ? api.post<Coupon>('/seller/coupons', couponBody(c)) : api.put<Coupon>(`/seller/coupons/${c.id}`, couponBody(c));

export const createWindows = (api: Api, w: WindowInput) => api.post<{ created: TimeWindow[]; skipped: { date: string; reason: WindowSkip }[] }>('/seller/windows', w);
export const updateWindow = (api: Api, id: string, p: Partial<Pick<TimeWindow, 'capacity' | 'serviceIds' | 'note' | 'open'>>) => api.patch<TimeWindow>(`/seller/windows/${id}`, p);
export const deleteWindow = (api: Api, id: string) => api.del(`/seller/windows/${id}`);
export const setBookingStatus = (api: Api, id: string, status: BookingStatus, reason?: string) => api.patch<Booking>(`/seller/bookings/${id}`, { status, reason });
export const walkIn = (api: Api, b: { customerName: string; customerPhone: string; serviceIds: string[]; staffId: string | null; date: string; time: string; notes?: string; force?: boolean }) => api.post<Booking>('/seller/bookings', b);
export const setSubOrderStatus = (api: Api, id: string, status: SubOrderStatus, trackingNo?: string, reason?: string) => api.patch<SubOrder>(`/seller/sub-orders/${id}`, { status, trackingNo, reason });
export const rejectReturn = (api: Api, id: string, reason: string) => api.post(`/seller/sub-orders/${id}/reject-return`, { reason });
export const replyReview = (api: Api, id: string, reply: string) => api.post<Review>(`/seller/reviews/${id}/reply`, { reply });

export const getWallet = (api: Api) => api.get<Wallet>('/seller/wallet');
export const requestWithdrawal = (api: Api) => api.post<Withdrawal>('/seller/withdrawals', {});
export const stripeOnboarding = (api: Api, returnUrl: string) => api.post<{ url: string }>('/seller/stripe/onboarding', { returnUrl });
export const stripeStatus = (api: Api) => api.get<{ connected: boolean; payoutsReady: boolean; requirements: string[]; dashboardUrl?: string | null }>('/seller/stripe/status');

// ───────────── admin ─────────────
export const approveApplication = (api: Api, appId: string, override = false) => api.post(`/admin/applications/${appId}/approve`, { override });
export const rejectApplication = (api: Api, appId: string, reason: string) => api.post(`/admin/applications/${appId}/reject`, { reason });
export const requestInfo = (api: Api, appId: string, reason: string) => api.post(`/admin/applications/${appId}/request-info`, { reason });
export const setChecklist = (api: Api, appId: string, checklist: SellerApplication['checklist']) => api.patch<SellerApplication>(`/admin/applications/${appId}/checklist`, checklist);
export const applicationDetail = (api: Api, appId: string) => api.get<{ application: Omit<SellerApplication, 'documents'> & { documents: { id: string; type: string; name: string; uploadedAt: string; url: string | null }[] }; missing: string[] }>(`/admin/applications/${appId}`);
export const updateSalonAdmin = (api: Api, id: string, patch: { status?: 'approved' | 'suspended'; commissionRate?: number; featured?: boolean; reason?: string }) => api.patch<Salon>(`/admin/salons/${id}`, patch);
export const moderateProduct = (api: Api, id: string, ok: boolean, reason?: string) => api.post<Product>(`/admin/products/${id}/moderate`, { decision: ok ? 'publish' : 'reject', reason });
export const setReviewFlags = (api: Api, id: string, flags: { hidden?: boolean; reported?: boolean }) => api.patch<Review>(`/admin/reviews/${id}`, flags);
export const setUserBlocked = (api: Api, id: string, blocked: boolean) => api.patch<User>(`/admin/users/${id}`, { blocked });
export const setTicketStatus = (api: Api, id: string, status: 'open' | 'closed') => api.patch(`/admin/tickets/${id}`, { status });
export const saveBanner = (api: Api, b: Banner) => api.put<Banner>(`/admin/banners/${b.id}`, { title: b.title, subtitle: b.subtitle, image: b.image, cta: b.cta, link: b.link, active: b.active });
export const approveWithdrawal = (api: Api, id: string) => api.post<Withdrawal>(`/admin/withdrawals/${id}/approve`, {});
export const rejectWithdrawal = (api: Api, id: string, reason: string) => api.post(`/admin/withdrawals/${id}/reject`, { reason });
export const getWithdrawals = (api: Api) => api.get<Withdrawal[]>('/admin/withdrawals');
export const saveSettings = (api: Api, s: Partial<PlatformSettings>) => api.put<PlatformSettings>('/admin/settings', s);
export const salonWallet = (api: Api, salonId: string) => api.get<Omit<Wallet, 'commissionRate' | 'minWithdrawal' | 'nextReleaseAt' | 'canWithdraw' | 'openWithdrawal' | 'stripe'>>(`/admin/salons/${salonId}/wallet`);
