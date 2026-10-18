// Shared domain types — used by web today, Express + MySQL backend + Expo app later.
// Keep these in sync with the MySQL schema (Prisma) (Phase 6).

export type Role = 'customer' | 'seller' | 'admin';
export type ID = string;

export type SalonCategory = 'parrucchiere' | 'barber' | 'unghie' | 'estetica' | 'spa';
export type ProductCategory = 'capelli' | 'unghie' | 'viso' | 'corpo' | 'barba' | 'strumenti';

export type SalonStatus = 'draft' | 'pending' | 'needs_info' | 'approved' | 'rejected' | 'suspended';
export type ProductStatus = 'draft' | 'review' | 'published' | 'rejected';
export type BookingStatus = 'awaiting_payment' | 'booked' | 'confirmed' | 'in_progress' | 'completed' | 'no_show' | 'cancelled';
export type SubOrderStatus = 'awaiting_payment' | 'received' | 'preparing' | 'shipped' | 'ready_pickup' | 'delivered' | 'cancelled' | 'refunded';
export type PaymentMode = 'in_salon' | 'deposit' | 'card';
export type ShippingMethod = 'standard' | 'pickup';

export interface Address {
  id: ID;
  label: string;
  name: string;
  street: string;
  city: string;
  zip: string;
  province: string;
  phone: string;
  isDefault?: boolean;
}

export interface User {
  id: ID;
  role: Role;
  name: string;
  email: string;
  phone: string;
  avatar?: string;
  city?: string;
  createdAt: string;
  blocked?: boolean;
  addresses: Address[];
  loyaltyPoints?: number;
  salonId?: ID; // sellers
}

export interface OpeningHours {
  day: number; // 0=Mon .. 6=Sun
  open: string | null; // "09:00" or null if closed
  close: string | null;
}

export interface Salon {
  id: ID;
  slug: string;
  ownerId: ID;
  name: string;
  tagline: string;
  description: string;
  category: SalonCategory;
  city: string;
  address: string;
  zip: string;
  lat: number;
  lng: number;
  phone: string;
  email: string;
  cover: string;
  logo?: string;
  gallery: string[];
  hours: OpeningHours[];
  rating: number;
  reviewCount: number;
  status: SalonStatus;
  commissionRate: number; // 0.12 = 12%
  featured?: boolean;
  verified?: boolean;
  priceLevel: 1 | 2 | 3;
  amenities: string[];
  policies: { cancellation: string; noShow: string; shippingZones: string; shippingFee: number; freeShippingOver: number };
  createdAt: string;
}

export interface SellerDocument {
  id: ID;
  type: 'visura' | 'id' | 'license' | 'other';
  name: string;
  uploadedAt: string;
}

export interface SellerApplication {
  id: ID;
  salonId: ID;
  ownerId: ID;
  ragioneSociale: string;
  pIva: string;
  codiceFiscale: string;
  sdi: string;
  pec: string;
  legalAddress: string;
  iban: string;
  accountHolder: string;
  documents: SellerDocument[];
  status: SalonStatus;
  submittedAt?: string;
  reviewedAt?: string;
  rejectionReason?: string;
  adminNotes?: string;
  checklist: { docs: boolean; vat: boolean; iban: boolean; photos: boolean };
}

export interface Staff {
  id: ID;
  salonId: ID;
  name: string;
  role: string;
  photo: string;
  bio: string;
  serviceIds: ID[];
  workingDays: number[]; // 0..6
  active: boolean;
}

export interface Service {
  id: ID;
  salonId: ID;
  category: string;
  name: string;
  description: string;
  /** cover image (always === images[0]); kept for list thumbnails */
  image: string;
  /** gallery: before/after, results, ambience — first one is the cover */
  images: string[];
  durationMin: number;
  price: number;
  bufferMin: number;
  depositPct: number;
  active: boolean;
  popular?: boolean;
}

export interface ProductVariant {
  id: ID;
  label: string; // "250 ml", "Rosso"
  priceDelta: number;
  stock: number;
}

export interface Product {
  id: ID;
  salonId: ID;
  brand: string;
  category: ProductCategory;
  name: string;
  short: string;
  description: string;
  images: string[];
  price: number;
  compareAtPrice?: number;
  stock: number;
  sku: string;
  variants: ProductVariant[];
  inci: string;
  howToUse: string;
  rating: number;
  reviewCount: number;
  status: ProductStatus;
  rejectionReason?: string;
  weightGr: number;
  isNew?: boolean;
  createdAt: string;
  sold: number;
}

export interface Booking {
  id: ID;
  code: string;
  customerId: ID;
  customerName: string;
  customerPhone: string;
  salonId: ID;
  staffId: ID | null;
  serviceIds: ID[];
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  durationMin: number;
  total: number;
  deposit: number;
  paymentMode: PaymentMode;
  status: BookingStatus;
  notes?: string;
  pickupProductIds?: ID[];
  createdAt: string;
  reviewed?: boolean;
  /** API: amount already paid online (deposit or full) */
  paid?: number;
  /** API: unpaid online booking is held until this time */
  holdExpiresAt?: string;
  /** booked inside a salon time window (see TimeWindow) */
  windowId?: ID | null;
}

/**
 * A block of time a salon opens on purpose, with a fixed number of places and a list of services
 * (e.g. Sun 10:00–13:00, 4 places, cut / beard / cut+beard). Each booking takes one place.
 * staffId set = that person is reserved for the whole window; null = extra capacity.
 */
export interface TimeWindow {
  id: ID;
  salonId: ID;
  date: string; // YYYY-MM-DD
  start: string; // HH:mm
  end: string; // HH:mm
  serviceIds: ID[];
  capacity: number;
  staffId: ID | null;
  note?: string;
  /** false = closed to new bookings (existing ones stay) */
  open: boolean;
  /** places taken (computed: server in API mode, from bookings in demo mode) */
  booked: number;
}

export interface OrderItem {
  productId: ID;
  variantId?: ID;
  name: string;
  image: string;
  price: number;
  qty: number;
}

export interface SubOrder {
  id: ID;
  code: string;
  orderId: ID;
  salonId: ID;
  items: OrderItem[];
  shippingMethod: ShippingMethod;
  shippingFee: number;
  subtotal: number;
  status: SubOrderStatus;
  trackingNo?: string;
  carrier?: string;
  timeline: { status: SubOrderStatus; at: string }[];
  returnRequested?: boolean;
}

export interface Order {
  id: ID;
  code: string;
  customerId: ID;
  customerName: string;
  createdAt: string;
  address?: Address;
  paymentMethod: string;
  discount: number;
  total: number;
  subOrderIds: ID[];
}

export interface Review {
  id: ID;
  customerId: ID;
  customerName: string;
  customerAvatar?: string;
  salonId: ID;
  productId?: ID;
  bookingId?: ID;
  rating: number;
  text: string;
  createdAt: string;
  reply?: string;
  hidden?: boolean;
  reported?: boolean;
}

export interface Payout {
  id: ID;
  salonId: ID;
  period: string;
  gross: number;
  commission: number;
  net: number;
  status: 'scheduled' | 'paid';
  paidAt?: string;
}

export interface Coupon {
  id: ID;
  code: string;
  type: 'percent' | 'fixed';
  value: number;
  scope: 'platform' | ID; // salonId
  minSpend: number;
  uses: number;
  maxUses: number;
  active: boolean;
  expiresAt: string;
}

export interface Notification {
  id: ID;
  userId: ID;
  title: string;
  body: string;
  at: string;
  read: boolean;
  link?: string;
}

export interface Banner {
  id: ID;
  title: string;
  subtitle: string;
  image: string;
  cta: string;
  link: string;
  active: boolean;
}

export interface CartLine {
  productId: ID;
  variantId?: ID;
  qty: number;
}

export interface SupportTicket {
  id: ID;
  from: string;
  subject: string;
  status: 'open' | 'closed';
  at: string;
}
