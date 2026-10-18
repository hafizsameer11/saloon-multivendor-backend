import type {
  Booking, Banner, Coupon, Notification, Order, Payout, Product, ProductCategory, Review, Salon, SalonCategory,
  SellerApplication, Service, Staff, SubOrder, SupportTicket, TimeWindow, User, OpeningHours,
} from '../types';
import { pick, PHOTOS, u, type PhotoGroup } from '../images';

const P = (g: PhotoGroup, i: number, w = 1200) => u(pick(g, i), w);

// ---------- deterministic helpers ----------
let _s = 42;
const rnd = () => ((_s = (_s * 16807) % 2147483647) - 1) / 2147483646;
const ri = (a: number, b: number) => Math.floor(rnd() * (b - a + 1)) + a;
const rp = <T,>(arr: readonly T[]) => arr[Math.floor(rnd() * arr.length)];
const round = (n: number, step = 0.5) => Math.round(n / step) * step;
const pad = (n: number) => String(n).padStart(2, '0');
export const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const slugify = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

export interface DB {
  users: User[];
  salons: Salon[];
  applications: SellerApplication[];
  staff: Staff[];
  services: Service[];
  products: Product[];
  bookings: Booking[];
  windows: TimeWindow[];
  orders: Order[];
  subOrders: SubOrder[];
  reviews: Review[];
  payouts: Payout[];
  coupons: Coupon[];
  notifications: Notification[];
  banners: Banner[];
  tickets: SupportTicket[];
}

const STD_HOURS = (sundayOpen = false, mondayClosed = true): OpeningHours[] =>
  [0, 1, 2, 3, 4, 5, 6].map((day) => {
    if (day === 0 && mondayClosed) return { day, open: null, close: null };
    if (day === 6 && !sundayOpen) return { day, open: null, close: null };
    if (day === 5) return { day, open: '08:30', close: '20:00' };
    return { day, open: '09:00', close: '19:30' };
  });

const SALON_DEFS: {
  name: string; cat: SalonCategory; city: string; area: string; lat: number; lng: number; tagline: string; level: 1 | 2 | 3;
  cover: [PhotoGroup, number]; gallery: [PhotoGroup, number][]; status?: Salon['status']; featured?: boolean;
}[] = [
  { name: 'Barberia Elite', cat: 'barber', city: 'Catanzaro', area: 'Catanzaro Lido', lat: 38.8247, lng: 16.6145, tagline: 'Rasatura a panno caldo dal 1998', level: 2, cover: ['barber', 2], gallery: [['barber', 0], ['barber', 1], ['barber', 3], ['barber', 4], ['barber', 6], ['barber', 9]], featured: true },
  { name: 'Maison Aurora', cat: 'parrucchiere', city: 'Cosenza', area: 'Centro', lat: 39.2983, lng: 16.2537, tagline: 'Colore couture e tagli su misura', level: 3, cover: ['salonInterior', 3], gallery: [['hairStyling', 0], ['hairStyling', 1], ['salonInterior', 0], ['hairStyling', 3], ['hairTools', 0], ['salonInterior', 2]], featured: true },
  { name: 'Nail Atelier Nero', cat: 'unghie', city: 'Lamezia Terme', area: 'Nicastro', lat: 38.9654, lng: 16.3093, tagline: 'Nail art minimalista, gel e semipermanente', level: 2, cover: ['nails', 2], gallery: [['nails', 0], ['nails', 1], ['nails', 3], ['nails', 4], ['nails', 5], ['makeup', 2]], featured: true },
  { name: 'Glow Studio', cat: 'estetica', city: 'Catanzaro', area: 'Centro Storico', lat: 38.9098, lng: 16.5877, tagline: 'Trattamenti viso con dermocosmesi italiana', level: 3, cover: ['face', 2], gallery: [['face', 0], ['face', 1], ['face', 3], ['face', 4], ['skincare', 2], ['skincare', 5]], featured: true },
  { name: 'Terme di Luce Spa', cat: 'spa', city: 'Reggio Calabria', area: 'Lungomare', lat: 38.1113, lng: 15.6473, tagline: 'Rituali di benessere vista Stretto', level: 3, cover: ['spa', 0], gallery: [['spa', 1], ['spa', 2], ['spa', 4], ['spa', 5], ['spa', 6], ['spa', 7]], featured: true },
  { name: 'Officina del Capello', cat: 'parrucchiere', city: 'Catanzaro', area: 'Lido', lat: 38.8291, lng: 16.6232, tagline: 'Tagli contemporanei, balayage e trattamenti', level: 2, cover: ['salonInterior', 1], gallery: [['hairStyling', 2], ['hairStyling', 4], ['salonInterior', 4], ['hairTools', 1], ['hairStyling', 0], ['salonInterior', 3]] },
  { name: 'Il Barbiere di Tropea', cat: 'barber', city: 'Tropea', area: 'Corso Vittorio Emanuele', lat: 38.6773, lng: 15.8984, tagline: 'Barba, baffi e tradizione calabrese', level: 1, cover: ['barber', 5], gallery: [['barber', 7], ['barber', 8], ['barber', 10], ['barber', 2], ['barber', 1], ['barber', 0]] },
  { name: 'Rosa Canina Beauty', cat: 'estetica', city: 'Cosenza', area: 'Rende', lat: 39.3312, lng: 16.1832, tagline: 'Epilazione, ciglia e trucco sposa', level: 2, cover: ['makeup', 0], gallery: [['face', 2], ['makeup', 1], ['makeup', 3], ['face', 0], ['makeup', 5], ['skincare', 8]] },
  { name: 'Lacca Nail Bar', cat: 'unghie', city: 'Reggio Calabria', area: 'Corso Garibaldi', lat: 38.1061, lng: 15.6438, tagline: 'Manicure express e pedicure spa', level: 1, cover: ['nails', 0], gallery: [['nails', 1], ['nails', 2], ['nails', 3], ['nails', 5], ['nails', 4], ['spa', 3]] },
  { name: 'Salone Mediterraneo', cat: 'parrucchiere', city: 'Lamezia Terme', area: 'Sambiase', lat: 38.9661, lng: 16.2792, tagline: 'Colore naturale e cura del capello', level: 2, cover: ['salonInterior', 0], gallery: [['hairStyling', 1], ['salonInterior', 2], ['hairStyling', 3], ['hairStyling', 4], ['hairTools', 2], ['salonInterior', 1]] },
  { name: 'Corpo & Anima', cat: 'spa', city: 'Vibo Valentia', area: 'Vibo Marina', lat: 38.7144, lng: 16.1263, tagline: 'Massaggi decontratturanti e hammam', level: 2, cover: ['spa', 3], gallery: [['spa', 0], ['spa', 2], ['spa', 5], ['spa', 7], ['spa', 1], ['skincare', 10]] },
  { name: 'Fade Society', cat: 'barber', city: 'Crotone', area: 'Centro', lat: 39.0808, lng: 17.1271, tagline: 'Skin fade, design e grooming', level: 1, cover: ['barber', 9], gallery: [['barber', 3], ['barber', 6], ['barber', 4], ['barber', 10], ['barber', 8], ['barber', 5]] },
  // pending applicants (for the admin approval queue)
  { name: 'Luna Nails Studio', cat: 'unghie', city: 'Catanzaro', area: 'Siano', lat: 38.9001, lng: 16.6021, tagline: 'Ricostruzione e nail art a mano libera', level: 1, cover: ['nails', 4], gallery: [['nails', 0], ['nails', 3]], status: 'pending' },
  { name: 'Studio Bellavita', cat: 'estetica', city: 'Cosenza', area: 'Centro', lat: 39.3001, lng: 16.2501, tagline: 'Estetica avanzata e laser', level: 2, cover: ['face', 4], gallery: [['face', 1], ['face', 3]], status: 'pending' },
  { name: 'Barba & Co', cat: 'barber', city: 'Reggio Calabria', area: 'Sbarre', lat: 38.0901, lng: 15.6501, tagline: 'Il barbiere di quartiere, rinnovato', level: 1, cover: ['barber', 7], gallery: [['barber', 2]], status: 'needs_info' },
];

const SERVICE_TEMPLATES: Record<SalonCategory, { cat: string; name: string; desc: string; dur: number; price: number; img: PhotoGroup }[]> = {
  barber: [
    { cat: 'Taglio', name: 'Taglio Uomo', desc: 'Consulenza, shampoo, taglio a forbice o macchinetta e styling.', dur: 30, price: 18, img: 'barber' },
    { cat: 'Taglio', name: 'Skin Fade', desc: 'Sfumatura a zero con transizione morbida e rifinitura a rasoio.', dur: 45, price: 22, img: 'barber' },
    { cat: 'Barba', name: 'Barba Premium', desc: 'Panno caldo, rasatura a mano libera, olio e balsamo.', dur: 25, price: 16, img: 'barber' },
    { cat: 'Combo', name: 'Taglio + Barba', desc: 'Il rituale completo: taglio, barba a panno caldo e trattamento.', dur: 50, price: 30, img: 'barber' },
    { cat: 'Taglio', name: 'Taglio Bambino', desc: 'Per i più piccoli, fino a 12 anni.', dur: 20, price: 12, img: 'barber' },
    { cat: 'Trattamenti', name: 'Maschera Viso Carbone', desc: 'Pulizia profonda con maschera peel-off al carbone attivo.', dur: 20, price: 14, img: 'face' },
    { cat: 'Barba', name: 'Design Barba', desc: 'Definizione dei contorni e disegno della barba.', dur: 20, price: 12, img: 'barber' },
  ],
  parrucchiere: [
    { cat: 'Taglio', name: 'Taglio Donna + Piega', desc: 'Consulenza d’immagine, taglio su misura e piega.', dur: 60, price: 38, img: 'hairStyling' },
    { cat: 'Piega', name: 'Piega', desc: 'Shampoo, maschera e piega mossa o liscia.', dur: 40, price: 22, img: 'hairStyling' },
    { cat: 'Colore', name: 'Colore Radici', desc: 'Ritocco colore con prodotti senza ammoniaca.', dur: 75, price: 45, img: 'hairStyling' },
    { cat: 'Colore', name: 'Balayage', desc: 'Schiariture dipinte a mano per un effetto sole naturale.', dur: 150, price: 120, img: 'hairStyling' },
    { cat: 'Trattamenti', name: 'Trattamento Cheratina', desc: 'Ristrutturante anticrespo, risultati fino a 3 mesi.', dur: 120, price: 140, img: 'hairTools' },
    { cat: 'Taglio', name: 'Taglio Uomo', desc: 'Taglio classico o moderno con styling.', dur: 30, price: 20, img: 'hairStyling' },
    { cat: 'Trattamenti', name: 'Rituale Ricostruzione', desc: 'Trattamento intensivo per capelli danneggiati.', dur: 45, price: 35, img: 'hairTools' },
    { cat: 'Sposa', name: 'Acconciatura Sposa', desc: 'Prova inclusa, acconciatura raccolta o semiraccolta.', dur: 90, price: 150, img: 'hairStyling' },
  ],
  unghie: [
    { cat: 'Mani', name: 'Manicure Semipermanente', desc: 'Preparazione unghie, cuticole e smalto semipermanente.', dur: 45, price: 25, img: 'nails' },
    { cat: 'Mani', name: 'Ricostruzione Gel', desc: 'Allungamento con gel, forma a scelta.', dur: 90, price: 45, img: 'nails' },
    { cat: 'Mani', name: 'Refill Gel', desc: 'Riempimento ricostruzione esistente.', dur: 60, price: 35, img: 'nails' },
    { cat: 'Nail Art', name: 'Nail Art (per 2 unghie)', desc: 'Decorazioni a mano libera, linee, french, foil.', dur: 15, price: 6, img: 'nails' },
    { cat: 'Piedi', name: 'Pedicure Spa', desc: 'Pediluvio, scrub, trattamento talloni e smalto.', dur: 50, price: 30, img: 'nails' },
    { cat: 'Mani', name: 'Manicure Classica', desc: 'Lima, cuticole, massaggio e smalto tradizionale.', dur: 30, price: 15, img: 'nails' },
  ],
  estetica: [
    { cat: 'Viso', name: 'Pulizia Viso Profonda', desc: 'Detersione, vapore, estrazione e maschera specifica.', dur: 60, price: 45, img: 'face' },
    { cat: 'Viso', name: 'Trattamento Vitamina C', desc: 'Illuminante antiossidante per pelli spente.', dur: 50, price: 55, img: 'face' },
    { cat: 'Ciglia', name: 'Laminazione Ciglia', desc: 'Curvatura e nutrimento delle ciglia naturali, durata 6 settimane.', dur: 60, price: 50, img: 'makeup' },
    { cat: 'Sopracciglia', name: 'Brow Design', desc: 'Studio della forma, epilazione e tinta.', dur: 30, price: 20, img: 'makeup' },
    { cat: 'Corpo', name: 'Epilazione Gambe Complete', desc: 'Ceretta delicata con cera al miele.', dur: 45, price: 30, img: 'spa' },
    { cat: 'Trucco', name: 'Trucco Evento', desc: 'Make-up professionale per cerimonie ed eventi.', dur: 60, price: 60, img: 'makeup' },
    { cat: 'Viso', name: 'Peeling Enzimatico', desc: 'Rinnovamento cellulare delicato, adatto a pelli sensibili.', dur: 40, price: 40, img: 'face' },
  ],
  spa: [
    { cat: 'Massaggi', name: 'Massaggio Decontratturante', desc: 'Lavoro profondo su schiena, collo e spalle.', dur: 50, price: 55, img: 'spa' },
    { cat: 'Massaggi', name: 'Massaggio Hot Stone', desc: 'Pietre laviche calde per rilassare corpo e mente.', dur: 60, price: 70, img: 'spa' },
    { cat: 'Rituali', name: 'Rituale Bergamotto di Calabria', desc: 'Scrub agli agrumi, impacco e massaggio con olio di bergamotto.', dur: 90, price: 95, img: 'spa' },
    { cat: 'Percorsi', name: 'Percorso Spa di Coppia', desc: 'Sauna, bagno turco, idromassaggio e tisana per due.', dur: 120, price: 140, img: 'spa' },
    { cat: 'Massaggi', name: 'Linfodrenaggio', desc: 'Massaggio drenante manuale metodo Vodder.', dur: 50, price: 60, img: 'spa' },
    { cat: 'Viso', name: 'Facial Idratante', desc: 'Trattamento viso con acido ialuronico.', dur: 45, price: 50, img: 'face' },
  ],
};

const ALT: Partial<Record<PhotoGroup, PhotoGroup>> = { face: 'skincare', hairTools: 'hairStyling', makeup: 'face' };
const BRANDS = ['Olea Lab', 'Atelier Nero', 'Gel Pro Italia', 'Bergamia', 'Calabra Cosmetics', 'Officina Barba', 'Aurora Professional', 'Sila Botanica'];

const PRODUCT_TEMPLATES: { cat: ProductCategory; name: string; brand: string; short: string; price: number; compare?: number; img: PhotoGroup; variants?: string[] }[] = [
  { cat: 'capelli', name: 'Shampoo Idratante Assoluto', brand: 'Olea Lab', short: 'Con olio d’oliva calabrese e proteine della seta', price: 22.9, compare: 26.9, img: 'skincare', variants: ['250 ml', '1000 ml'] },
  { cat: 'capelli', name: 'Maschera Ricostruttrice', brand: 'Aurora Professional', short: 'Trattamento intensivo per capelli danneggiati', price: 28.5, img: 'skincare', variants: ['200 ml', '500 ml'] },
  { cat: 'capelli', name: 'Lacca Tenuta Forte', brand: 'Aurora Professional', short: 'Spray fissante, asciuga in pochi secondi', price: 14.9, img: 'skincare' },
  { cat: 'capelli', name: 'Olio Sublimatore Punte', brand: 'Olea Lab', short: 'Anticrespo e lucentezza senza appesantire', price: 24, img: 'skincare' },
  { cat: 'capelli', name: 'Spray Termoprotettore', brand: 'Aurora Professional', short: 'Protegge fino a 230°C', price: 18.5, img: 'skincare' },
  { cat: 'capelli', name: 'Shampoo Antigiallo Silver', brand: 'Aurora Professional', short: 'Neutralizza i riflessi gialli su biondi e grigi', price: 19.9, img: 'skincare' },
  { cat: 'unghie', name: 'Gel UV Rosso Carminio', brand: 'Gel Pro Italia', short: 'Semipermanente coprente, durata 3 settimane', price: 12.5, img: 'nails', variants: ['Carminio', 'Nero Onice', 'Nude Rosa'] },
  { cat: 'unghie', name: 'Base Rubber Gel', brand: 'Gel Pro Italia', short: 'Base livellante ad alta adesione', price: 15.9, img: 'nails' },
  { cat: 'unghie', name: 'Top Coat No-Wipe', brand: 'Gel Pro Italia', short: 'Finish specchio senza dispersione', price: 13.9, img: 'nails' },
  { cat: 'unghie', name: 'Olio Cuticole Mandorla', brand: 'Sila Botanica', short: 'Nutre e ammorbidisce, con vitamina E', price: 9.9, img: 'skincare' },
  { cat: 'unghie', name: 'Kit Semipermanente Starter', brand: 'Gel Pro Italia', short: 'Lampada LED 48W + 4 colori + base e top', price: 69, compare: 89, img: 'nails' },
  { cat: 'viso', name: 'Siero Vitamina C 15%', brand: 'Atelier Nero', short: 'Illuminante antiossidante, uso quotidiano', price: 34, img: 'skincare' },
  { cat: 'viso', name: 'Crema Acido Ialuronico', brand: 'Bergamia', short: 'Idratazione profonda 24h', price: 29.9, compare: 35, img: 'skincare', variants: ['50 ml'] },
  { cat: 'viso', name: 'Detergente Schiumogeno', brand: 'Sila Botanica', short: 'Delicato, per tutti i tipi di pelle', price: 16.5, img: 'skincare' },
  { cat: 'viso', name: 'Maschera Argilla Purificante', brand: 'Calabra Cosmetics', short: 'Con argilla verde e bergamotto', price: 19.9, img: 'skincare' },
  { cat: 'viso', name: 'Contorno Occhi Caffeina', brand: 'Atelier Nero', short: 'Riduce borse e occhiaie', price: 26, img: 'skincare' },
  { cat: 'viso', name: 'Palette Ombretti Terre', brand: 'Atelier Nero', short: '12 tonalità matte e shimmer', price: 32, img: 'makeup' },
  { cat: 'viso', name: 'Rossetto Velluto', brand: 'Atelier Nero', short: 'Finish matte a lunga tenuta', price: 18, img: 'makeup', variants: ['Rosso Calabria', 'Nude', 'Prugna'] },
  { cat: 'corpo', name: 'Olio Corpo al Bergamotto', brand: 'Bergamia', short: 'Olio secco profumato, assorbimento rapido', price: 27.5, img: 'skincare' },
  { cat: 'corpo', name: 'Scrub Sale e Agrumi', brand: 'Calabra Cosmetics', short: 'Esfoliante con sale marino dello Ionio', price: 21, img: 'spa' },
  { cat: 'corpo', name: 'Crema Mani Fico d’India', brand: 'Sila Botanica', short: 'Nutriente, non unge', price: 9.5, img: 'skincare' },
  { cat: 'corpo', name: 'Candela Massaggio Ambra', brand: 'Bergamia', short: 'Si scioglie in olio caldo da massaggio', price: 24, img: 'spa' },
  { cat: 'barba', name: 'Olio da Barba Cedro', brand: 'Officina Barba', short: 'Ammorbidisce e profuma, con olio di argan', price: 15.9, img: 'skincare' },
  { cat: 'barba', name: 'Balsamo Barba', brand: 'Officina Barba', short: 'Modella e nutre, tenuta leggera', price: 16.9, img: 'skincare' },
  { cat: 'barba', name: 'Crema da Barba Classica', brand: 'Officina Barba', short: 'Schiuma ricca per rasatura a pennello', price: 12.9, img: 'skincare' },
  { cat: 'barba', name: 'Pomata Opaca', brand: 'Officina Barba', short: 'Tenuta forte, effetto naturale', price: 17.5, img: 'skincare' },
  { cat: 'barba', name: 'Dopobarba Lenitivo', brand: 'Officina Barba', short: 'Senza alcool, con aloe', price: 14, img: 'skincare' },
  { cat: 'strumenti', name: 'Spazzola Termica Pro', brand: 'Aurora Professional', short: 'Ceramica e ioni, diametro 43 mm', price: 29, img: 'hairTools' },
  { cat: 'strumenti', name: 'Asciugacapelli Ionico 2200W', brand: 'Aurora Professional', short: 'Leggero e silenzioso, 3 accessori', price: 89, compare: 119, img: 'hairTools' },
  { cat: 'strumenti', name: 'Set Pennelli Make-up', brand: 'Atelier Nero', short: '8 pennelli in fibra sintetica', price: 39, img: 'makeup' },
  { cat: 'strumenti', name: 'Rullo di Giada', brand: 'Sila Botanica', short: 'Massaggio viso drenante', price: 22, img: 'skincare' },
];

const PRODUCT_CATS_BY_SALON: Record<SalonCategory, ProductCategory[]> = {
  barber: ['barba', 'capelli', 'strumenti'],
  parrucchiere: ['capelli', 'strumenti'],
  unghie: ['unghie', 'corpo'],
  estetica: ['viso', 'corpo', 'strumenti'],
  spa: ['corpo', 'viso'],
};

const FIRST_F = ['Giulia', 'Martina', 'Chiara', 'Francesca', 'Sara', 'Alessia', 'Valentina', 'Elena', 'Federica', 'Ilaria', 'Noemi', 'Rosa'];
const FIRST_M = ['Marco', 'Luca', 'Antonio', 'Francesco', 'Giuseppe', 'Davide', 'Salvatore', 'Pietro', 'Andrea', 'Domenico'];
const LAST = ['Ferraro', 'Russo', 'Romeo', 'Greco', 'Scalise', 'Gallo', 'Caruso', 'Mazza', 'Lombardo', 'Rizzo', 'Bruno', 'Colosimo', 'Mancuso', 'Talarico'];
const REVIEW_TEXTS = [
  'Esperienza impeccabile, puntuali e attentissimi ai dettagli. Tornerò sicuramente.',
  'Ambiente curato e personale gentilissimo. Il risultato è andato oltre le aspettative.',
  'Prenotazione velocissima dall’app, nessuna attesa. Consigliatissimo.',
  'Professionalità altissima, mi hanno consigliato anche i prodotti giusti per casa.',
  'Buon servizio, un po’ di ritardo ma il risultato finale è ottimo.',
  'Il miglior salone della zona, prezzi onesti e qualità vera.',
  'Atmosfera rilassante, mi sono sentita coccolata dall’inizio alla fine.',
  'Precisi e veloci, finalmente un posto dove capiscono cosa chiedi.',
];

export function createSeed(today = new Date()): DB {
  _s = 42;
  const now = today.toISOString();
  const users: User[] = [];
  const salons: Salon[] = [];
  const applications: SellerApplication[] = [];
  const staff: Staff[] = [];
  const services: Service[] = [];
  const products: Product[] = [];

  // --- core demo accounts ---
  users.push({ id: 'u-admin', role: 'admin', name: 'Admin MyBeauty', email: 'admin@mybeauty.it', phone: '+39 0961 000000', avatar: P('portraitsM', 2, 300), createdAt: '2025-01-10T09:00:00Z', addresses: [] });
  users.push({
    id: 'u-giulia', role: 'customer', name: 'Giulia Ferraro', email: 'giulia@demo.it', phone: '+39 347 123 4567', avatar: P('portraitsF', 5, 300), city: 'Catanzaro',
    createdAt: '2025-11-02T10:00:00Z', loyaltyPoints: 340,
    addresses: [
      { id: 'a1', label: 'Casa', name: 'Giulia Ferraro', street: 'Via Lungomare 112', city: 'Catanzaro Lido', zip: '88100', province: 'CZ', phone: '+39 347 123 4567', isDefault: true },
      { id: 'a2', label: 'Ufficio', name: 'Giulia Ferraro', street: 'Corso Mazzini 45', city: 'Catanzaro', zip: '88100', province: 'CZ', phone: '+39 347 123 4567' },
    ],
  });
  // other customers
  for (let i = 0; i < 22; i++) {
    const f = i % 3 === 2;
    const first = f ? rp(FIRST_M) : rp(FIRST_F);
    const last = rp(LAST);
    users.push({
      id: `u-c${i}`, role: 'customer', name: `${first} ${last}`, email: `${slugify(first)}.${slugify(last)}${i}@mail.it`, phone: `+39 3${ri(20, 49)} ${ri(100, 999)} ${ri(1000, 9999)}`,
      avatar: f ? P('portraitsM', i, 300) : P('portraitsF', i, 300), city: rp(['Catanzaro', 'Cosenza', 'Lamezia Terme', 'Reggio Calabria']), createdAt: isoDate(addDays(today, -ri(10, 400))) + 'T10:00:00Z', addresses: [], loyaltyPoints: ri(0, 500),
    });
  }

  SALON_DEFS.forEach((d, si) => {
    const id = `s${si + 1}`;
    const ownerFirst = d.cat === 'barber' ? FIRST_M[si % FIRST_M.length] : FIRST_F[si % FIRST_F.length];
    const ownerName = si === 0 ? 'Marco Scalise' : `${ownerFirst} ${LAST[(si + 3) % LAST.length]}`;
    const ownerId = si === 0 ? 'u-marco' : si === 12 ? 'u-sofia' : `u-o${si}`;
    const email = si === 0 ? 'marco@barberiaelite.it' : si === 12 ? 'sofia@lunanails.it' : `${slugify(ownerFirst)}@${slugify(d.name).replace(/-/g, '')}.it`;
    users.push({ id: ownerId, role: 'seller', name: si === 12 ? 'Sofia Mancuso' : ownerName, email, phone: `+39 3${ri(20, 49)} ${ri(100, 999)} ${ri(1000, 9999)}`, avatar: d.cat === 'barber' ? P('portraitsM', si, 300) : P('portraitsF', si + 2, 300), createdAt: '2025-06-01T10:00:00Z', addresses: [], salonId: id });
    const status = d.status ?? 'approved';
    const slug = slugify(d.name);
    salons.push({
      id, slug, ownerId, name: d.name, tagline: d.tagline,
      description: `${d.name} è un punto di riferimento a ${d.city} per chi cerca qualità, puntualità e un’esperienza curata in ogni dettaglio. Il team lavora solo su appuntamento, con prodotti professionali selezionati che puoi acquistare anche online e ritirare in salone.`,
      category: d.cat, city: d.city, address: `${d.area}, Via ${rp(['Roma', 'Garibaldi', 'Mazzini', 'dei Mille', 'Indipendenza', 'XX Settembre'])} ${ri(2, 140)}`, zip: '88100',
      lat: d.lat, lng: d.lng, phone: `+39 09${ri(61, 68)} ${ri(100000, 999999)}`, email,
      cover: P(d.cover[0], d.cover[1]), gallery: d.gallery.map(([g, i]) => P(g, i)),
      hours: STD_HOURS(d.cat === 'spa', d.cat !== 'spa'),
      rating: status === 'approved' ? round(4.4 + rnd() * 0.55, 0.1) : 0, reviewCount: status === 'approved' ? ri(40, 320) : 0,
      status, commissionRate: 0.12, featured: d.featured, verified: status === 'approved', priceLevel: d.level,
      amenities: rp([['Wi-Fi', 'Aria condizionata', 'Pagamento con carta', 'Accessibile'], ['Wi-Fi', 'Caffè offerto', 'Parcheggio', 'Pagamento con carta'], ['Aria condizionata', 'Prodotti vegan', 'Pagamento con carta']]),
      policies: { cancellation: 'Cancellazione gratuita fino a 24 ore prima dell’appuntamento.', noShow: 'In caso di mancata presentazione la caparra non è rimborsabile.', shippingZones: 'Italia', shippingFee: 5.9, freeShippingOver: 49 },
      createdAt: status === 'approved' ? '2025-07-01T10:00:00Z' : isoDate(addDays(today, -ri(1, 6))) + 'T10:00:00Z',
    });
    applications.push({
      id: `app-${id}`, salonId: id, ownerId,
      ragioneSociale: `${d.name} di ${si === 12 ? 'Sofia Mancuso' : ownerName}`, pIva: `0${ri(1000000000, 9999999999)}`, codiceFiscale: `${slugify(ownerName).slice(0, 3).toUpperCase()}XYZ${ri(10, 99)}A${ri(10, 99)}C352K`,
      sdi: 'M5UXCR1', pec: `${slug}@pec.it`, legalAddress: `${d.area}, ${d.city}`, iban: `IT60 X054 2811 1010 0000 0${ri(100000, 999999)}`, accountHolder: si === 12 ? 'Sofia Mancuso' : ownerName,
      documents: [
        { id: `${id}-d1`, type: 'visura', name: 'Visura_camerale.pdf', uploadedAt: now },
        { id: `${id}-d2`, type: 'id', name: 'Documento_identita.pdf', uploadedAt: now },
        ...(d.status === 'needs_info' ? [] : [{ id: `${id}-d3`, type: 'license' as const, name: 'SCIA_attivita.pdf', uploadedAt: now }]),
      ],
      status, submittedAt: salons[si].createdAt, reviewedAt: status === 'approved' ? '2025-07-02T10:00:00Z' : undefined,
      rejectionReason: d.status === 'needs_info' ? 'Manca la SCIA dell’attività. Caricala per completare la verifica.' : undefined,
      checklist: { docs: status === 'approved', vat: status === 'approved', iban: status === 'approved', photos: status === 'approved' },
    });

    // staff
    const nStaff = status === 'approved' ? ri(3, 4) : 1;
    const staffIds: string[] = [];
    for (let k = 0; k < nStaff; k++) {
      const male = d.cat === 'barber' ? k !== 3 : k === 2;
      const sid = `${id}-st${k}`;
      staffIds.push(sid);
      staff.push({
        id: sid, salonId: id, name: k === 0 && si === 0 ? 'Marco' : male ? FIRST_M[(si + k * 3) % FIRST_M.length] : FIRST_F[(si + k * 5) % FIRST_F.length],
        role: k === 0 ? (d.cat === 'barber' ? 'Master Barber' : 'Titolare & Stylist') : rp(['Senior Stylist', 'Specialista', 'Junior', 'Colorist', 'Estetista']),
        photo: male ? P('portraitsM', si + k, 300) : P('portraitsF', si + k * 2, 300), bio: 'Oltre 8 anni di esperienza, formazione continua con le migliori accademie italiane.',
        serviceIds: [], workingDays: [1, 2, 3, 4, 5].concat(k % 2 ? [] : [6]), active: true,
      });
    }

    // services
    const tpl = SERVICE_TEMPLATES[d.cat];
    tpl.forEach((t, k) => {
      if (status !== 'approved' && k > 2) return;
      const svId = `${id}-sv${k}`;
      const price = round(t.price * (d.level === 3 ? 1.25 : d.level === 1 ? 0.9 : 1), 1);
      services.push({
        id: svId, salonId: id, category: t.cat, name: t.name, description: t.desc, image: P(t.img, si + k), images: [P(t.img, si + k), P(t.img, si + k + 1), P(t.img, si + k + 2), ALT[t.img] ? P(ALT[t.img]!, si + k) : P(t.img, si + k + 3)], durationMin: t.dur, price,
        bufferMin: 10, depositPct: price > 60 ? 20 : 0, active: true, popular: k < 2,
      });
      staff.filter((s) => s.salonId === id).forEach((s, j) => { if ((k + j) % 3 !== 2 || j === 0) s.serviceIds.push(svId); });
    });

    // products
    const cats = PRODUCT_CATS_BY_SALON[d.cat];
    const pool = PRODUCT_TEMPLATES.filter((p) => cats.includes(p.cat));
    const nProd = status === 'approved' ? Math.min(pool.length, ri(5, 8)) : 2;
    for (let k = 0; k < nProd; k++) {
      const t = pool[(k + si) % pool.length];
      const pid = `${id}-p${k}`;
      const imgs = [P(t.img, si * 3 + k), P(t.img, si * 3 + k + 1), P(t.img === 'skincare' ? 'makeup' : 'skincare', k)];
      products.push({
        id: pid, salonId: id, brand: t.brand, category: t.cat, name: t.name, short: t.short,
        description: `${t.name} di ${t.brand}: ${t.short.toLowerCase()}. Selezionato e usato ogni giorno dal team di ${d.name}. Formula sviluppata in Italia, dermatologicamente testata.`,
        images: imgs, price: t.price, compareAtPrice: t.compare, stock: k === 1 ? 3 : ri(8, 60), sku: `${slug.slice(0, 4).toUpperCase()}-${1000 + k}`,
        variants: (t.variants ?? []).map((v, j) => ({ id: `${pid}-v${j}`, label: v, priceDelta: j === 0 ? 0 : v.includes('1000') ? 18 : v.includes('500') ? 14 : 0, stock: ri(4, 30) })),
        inci: 'Aqua, Glycerin, Olea Europaea Fruit Oil, Citrus Aurantium Bergamia Peel Oil, Cetearyl Alcohol, Tocopherol, Parfum, Citric Acid, Sodium Benzoate.',
        howToUse: 'Applicare sulla zona interessata con movimenti delicati. Per uso esterno. Evitare il contatto con gli occhi.',
        rating: round(4.2 + rnd() * 0.8, 0.1), reviewCount: ri(4, 120), status: status === 'approved' ? 'published' : 'draft', weightGr: ri(80, 600),
        isNew: k === 0 && si % 2 === 0, createdAt: isoDate(addDays(today, -ri(5, 200))) + 'T10:00:00Z', sold: ri(5, 300),
      });
    }
  });

  // a couple of products waiting moderation from approved sellers
  products.push({
    ...products.find((p) => p.salonId === 's1')!, id: 's1-p90', name: 'Kit Barba Viaggio', short: 'Olio, balsamo e pettine in legno', price: 34.9, compareAtPrice: undefined,
    status: 'review', sku: 'BARB-1090', isNew: true, createdAt: isoDate(addDays(today, -1)) + 'T09:00:00Z', sold: 0, reviewCount: 0, rating: 0,
  });
  products.push({
    ...products.find((p) => p.salonId === 's3')!, id: 's3-p90', name: 'Gel Glitter Champagne', short: 'Glitter fine effetto oro rosa', price: 13.5, status: 'review', sku: 'NAIL-1090', isNew: true,
    createdAt: isoDate(today) + 'T08:00:00Z', sold: 0, reviewCount: 0, rating: 0,
  });

  // ---------- bookings ----------
  const bookings: Booking[] = [];
  const customers = users.filter((u) => u.role === 'customer');
  const approved = salons.filter((s) => s.status === 'approved');
  const times = ['09:00', '09:45', '10:30', '11:15', '12:00', '14:30', '15:15', '16:00', '16:45', '17:30', '18:15'];
  let bk = 1000;
  const mkBooking = (cust: User, salon: Salon, dayOffset: number, time: string, status: Booking['status']) => {
    const svs = services.filter((s) => s.salonId === salon.id);
    const chosen = [svs[ri(0, svs.length - 1)]];
    if (rnd() > 0.75) chosen.push(svs[(svs.indexOf(chosen[0]) + 1) % svs.length]);
    const st = staff.filter((s) => s.salonId === salon.id);
    const total = chosen.reduce((a, s) => a + s.price, 0);
    bookings.push({
      id: `b${bk}`, code: `MB-${bk++}`, customerId: cust.id, customerName: cust.name, customerPhone: cust.phone, salonId: salon.id, staffId: rp(st).id,
      serviceIds: chosen.map((c) => c.id), date: isoDate(addDays(today, dayOffset)), time, durationMin: chosen.reduce((a, s) => a + s.durationMin, 0),
      total, deposit: 0, paymentMode: rnd() > 0.7 ? 'deposit' : 'in_salon', status, createdAt: isoDate(addDays(today, dayOffset - ri(1, 10))) + 'T12:00:00Z', reviewed: status === 'completed' && rnd() > 0.5,
    });
  };
  // Giulia's bookings
  mkBooking(customers[0], salons[1], 2, '10:30', 'confirmed');
  mkBooking(customers[0], salons[2], 9, '16:00', 'booked');
  mkBooking(customers[0], salons[3], -12, '15:15', 'completed');
  bookings[bookings.length - 1].reviewed = false;
  mkBooking(customers[0], salons[1], -40, '11:15', 'completed');
  mkBooking(customers[0], salons[4], -25, '17:30', 'cancelled');
  // Barberia Elite (s1) — a full agenda today and this week
  const s1 = salons[0];
  times.forEach((t, i) => { if (i % 4 !== 3) mkBooking(customers[1 + (i % 20)], s1, 0, t, i < 3 ? 'completed' : i === 3 ? 'in_progress' : 'confirmed'); });
  for (let d = 1; d <= 6; d++) for (let k = 0; k < 4; k++) mkBooking(rp(customers.slice(1)), s1, d, times[(k * 3 + d) % times.length], 'booked');
  for (let d = 1; d <= 60; d++) for (let k = 0; k < 3; k++) mkBooking(rp(customers.slice(1)), s1, -d, times[(k * 4 + d) % times.length], rnd() > 0.92 ? 'no_show' : rnd() > 0.93 ? 'cancelled' : 'completed');
  // other salons
  approved.slice(1).forEach((s) => { for (let k = 0; k < 8; k++) mkBooking(rp(customers.slice(1)), s, ri(-20, 10), rp(times), 'completed'); });
  bookings.forEach((b) => { if (b.date >= isoDate(today) && b.status === 'completed' && b.date > isoDate(today)) b.status = 'booked'; });

  // ---------- time windows (Barberia Elite) ----------
  // next Sunday (normally closed): 10:00–13:00, 4 places, no staff tied up · next Wednesday lunch with Marco, 2 places
  const nextDow = (dow: number) => { for (let i = 1; i <= 7; i++) { const d = addDays(today, i); if (d.getDay() === dow) return isoDate(d); } return isoDate(addDays(today, 7)); };
  const s1svc = services.filter((x) => x.salonId === s1.id).slice(0, 4).map((x) => x.id);
  const s1staff = staff.filter((x) => x.salonId === s1.id);
  const windows: TimeWindow[] = [
    { id: 'w1', salonId: s1.id, date: nextDow(0), start: '10:00', end: '13:00', serviceIds: s1svc, capacity: 4, staffId: null, note: 'Domenica speciale', open: true, booked: 0 },
    { id: 'w2', salonId: s1.id, date: nextDow(3), start: '13:00', end: '14:00', serviceIds: s1svc.slice(0, 2), capacity: 2, staffId: s1staff[0]?.id ?? null, note: 'Pausa pranzo express', open: true, booked: 0 },
  ];
  {
    const c = customers[3], sv = services.find((x) => x.id === s1svc[0])!;
    bookings.push({ id: `b${bk}`, code: `MB-${bk++}`, customerId: c.id, customerName: c.name, customerPhone: c.phone, salonId: s1.id, staffId: null, serviceIds: [sv.id], date: windows[0].date, time: '10:00', durationMin: sv.durationMin, total: sv.price, deposit: 0, paymentMode: 'in_salon', status: 'booked', createdAt: isoDate(today) + 'T09:00:00Z', windowId: 'w1' });
  }

  // ---------- orders ----------
  const orders: Order[] = [];
  const subOrders: SubOrder[] = [];
  let oc = 5000;
  const mkOrder = (cust: User, daysAgo: number, picks: { salonId: string; n: number; method: 'standard' | 'pickup'; status: SubOrder['status'] }[]) => {
    const oid = `o${oc}`;
    const ids: string[] = [];
    let total = 0;
    picks.forEach((p, j) => {
      const prods = products.filter((x) => x.salonId === p.salonId && x.status === 'published');
      const items = prods.slice(0, p.n).map((x) => ({ productId: x.id, name: x.name, image: x.images[0], price: x.price, qty: ri(1, 2) }));
      const subtotal = items.reduce((a, it) => a + it.price * it.qty, 0);
      const fee = p.method === 'pickup' || subtotal >= 49 ? 0 : 5.9;
      const created = addDays(today, -daysAgo);
      const flow: SubOrder['status'][] = p.method === 'pickup' ? ['received', 'preparing', 'ready_pickup', 'delivered'] : ['received', 'preparing', 'shipped', 'delivered'];
      const idx = flow.indexOf(p.status);
      const sid = `${oid}-${j}`;
      ids.push(sid);
      subOrders.push({
        id: sid, code: `MB-${oc}-${j + 1}`, orderId: oid, salonId: p.salonId, items, shippingMethod: p.method, shippingFee: fee, subtotal, status: p.status,
        trackingNo: idx >= 2 && p.method === 'standard' ? `BRT${ri(10000000, 99999999)}` : undefined, carrier: p.method === 'standard' ? 'BRT' : undefined,
        timeline: flow.slice(0, Math.max(idx, 0) + 1).map((st, k) => ({ status: st, at: addDays(created, k).toISOString() })),
      });
      total += subtotal + fee;
    });
    orders.push({ id: oid, code: `MB-${oc++}`, customerId: cust.id, customerName: cust.name, createdAt: addDays(today, -daysAgo).toISOString(), address: cust.addresses[0], paymentMethod: rp(['Visa •••• 4242', 'PayPal', 'Apple Pay', 'Mastercard •••• 8812']), discount: 0, total: round(total, 0.01), subOrderIds: ids });
  };
  mkOrder(customers[0], 3, [{ salonId: 's2', n: 2, method: 'standard', status: 'shipped' }, { salonId: 's4', n: 1, method: 'pickup', status: 'ready_pickup' }]);
  mkOrder(customers[0], 21, [{ salonId: 's3', n: 2, method: 'standard', status: 'delivered' }]);
  for (let i = 0; i < 26; i++) {
    const s = rp(approved);
    const st = rp(['received', 'received', 'preparing', 'shipped', 'delivered', 'delivered'] as const);
    mkOrder(rp(customers.slice(1)), ri(0, 40), [{ salonId: i < 8 ? 's1' : s.id, n: ri(1, 3), method: rnd() > 0.7 ? 'pickup' : 'standard', status: st === 'shipped' && rnd() > 0.5 ? 'shipped' : st }]);
  }

  // ---------- reviews ----------
  const reviews: Review[] = [];
  approved.forEach((s, si) => {
    for (let k = 0; k < 6; k++) {
      const c = customers[(si * 3 + k) % customers.length];
      reviews.push({
        id: `r-${s.id}-${k}`, customerId: c.id, customerName: c.name, customerAvatar: c.avatar, salonId: s.id, rating: k === 4 ? 4 : 5 - (k === 5 && si % 3 === 0 ? 2 : 0),
        text: REVIEW_TEXTS[(si + k) % REVIEW_TEXTS.length], createdAt: addDays(today, -ri(2, 120)).toISOString(), reply: k === 0 ? 'Grazie mille, ti aspettiamo presto!' : undefined,
        reported: k === 5 && si % 3 === 0,
      });
    }
  });
  products.filter((p) => p.status === 'published').slice(0, 25).forEach((p, i) => {
    const c = customers[i % customers.length];
    reviews.push({ id: `rp-${p.id}`, customerId: c.id, customerName: c.name, customerAvatar: c.avatar, salonId: p.salonId, productId: p.id, rating: i % 5 === 0 ? 4 : 5, text: 'Prodotto ottimo, si sente la qualità professionale. Spedizione rapida.', createdAt: addDays(today, -ri(2, 90)).toISOString() });
  });

  // ---------- payouts ----------
  const payouts: Payout[] = [];
  approved.forEach((s) => {
    ['2026-07', '2026-08', '2026-09', '2026-10'].forEach((m, i) => {
      const gross = ri(1800, 6200);
      const commission = round(gross * s.commissionRate, 0.01);
      payouts.push({ id: `po-${s.id}-${m}`, salonId: s.id, period: m, gross, commission, net: round(gross - commission, 0.01), status: i < 3 ? 'paid' : 'scheduled', paidAt: i < 3 ? `${m}-28` : undefined });
    });
  });

  const coupons: Coupon[] = [
    { id: 'c1', code: 'BENVENUTA10', type: 'percent', value: 10, scope: 'platform', minSpend: 20, uses: 412, maxUses: 2000, active: true, expiresAt: '2026-12-31' },
    { id: 'c2', code: 'SPEDIZIONEGRATIS', type: 'fixed', value: 5.9, scope: 'platform', minSpend: 30, uses: 156, maxUses: 500, active: true, expiresAt: '2026-11-30' },
    { id: 'c3', code: 'ELITE5', type: 'fixed', value: 5, scope: 's1', minSpend: 25, uses: 38, maxUses: 100, active: true, expiresAt: '2026-12-15' },
    { id: 'c4', code: 'ESTATE20', type: 'percent', value: 20, scope: 'platform', minSpend: 50, uses: 900, maxUses: 900, active: false, expiresAt: '2026-08-31' },
  ];

  const notifications: Notification[] = [
    { id: 'n1', userId: 'u-giulia', title: 'Promemoria appuntamento', body: 'Maison Aurora ti aspetta tra 2 giorni alle 10:30.', at: addDays(today, 0).toISOString(), read: false, link: '/account/prenotazioni' },
    { id: 'n2', userId: 'u-giulia', title: 'Il tuo ordine è stato spedito', body: 'Tracking BRT disponibile nella pagina dell’ordine.', at: addDays(today, -1).toISOString(), read: false, link: '/account/ordini' },
    { id: 'n3', userId: 'u-giulia', title: 'Lascia una recensione', body: 'Com’è andata da Glow Studio?', at: addDays(today, -11).toISOString(), read: true, link: '/account/prenotazioni' },
    { id: 'n4', userId: 'u-marco', title: 'Nuovo ordine da spedire', body: 'Hai un nuovo ordine in attesa di preparazione.', at: now, read: false, link: '/seller/ordini' },
    { id: 'n5', userId: 'u-marco', title: 'Prodotto in revisione', body: '“Kit Barba Viaggio” è in attesa di approvazione.', at: now, read: false, link: '/seller/prodotti' },
  ];

  const banners: Banner[] = [
    { id: 'bn1', title: 'Ottobre Rosa', subtitle: 'Il 5% di ogni prenotazione va alla LILT Calabria', image: P('face', 1), cta: 'Scopri', link: '/esplora', active: true },
    { id: 'bn2', title: 'Rituali d’autunno', subtitle: '-15% sui percorsi spa del weekend', image: P('spa', 2), cta: 'Prenota', link: '/categoria/spa', active: true },
  ];

  const tickets: SupportTicket[] = [
    { id: 't1', from: 'Giulia Ferraro', subject: 'Rimborso caparra', status: 'open', at: now },
    { id: 't2', from: 'Barberia Elite', subject: 'Modifica IBAN', status: 'open', at: now },
    { id: 't3', from: 'Davide Russo', subject: 'Ordine non ricevuto', status: 'closed', at: now },
  ];

  return { users, salons, applications, staff, services, products, bookings, windows, orders, subOrders, reviews, payouts, coupons, notifications, banners, tickets };
}

export const CATEGORY_LABELS: Record<SalonCategory, { it: string; en: string; img: string }> = {
  parrucchiere: { it: 'Parrucchieri', en: 'Hair salons', img: PHOTOS.salonInterior[0] },
  barber: { it: 'Barber', en: 'Barbers', img: PHOTOS.barber[2] },
  unghie: { it: 'Unghie', en: 'Nails', img: PHOTOS.nails[0] },
  estetica: { it: 'Estetica', en: 'Aesthetics', img: PHOTOS.face[0] },
  spa: { it: 'Massaggi & Spa', en: 'Massage & Spa', img: PHOTOS.spa[1] },
};

export const PRODUCT_CATEGORY_LABELS: Record<ProductCategory, { it: string; en: string }> = {
  capelli: { it: 'Capelli', en: 'Hair' },
  unghie: { it: 'Unghie', en: 'Nails' },
  viso: { it: 'Viso & Make-up', en: 'Face & Make-up' },
  corpo: { it: 'Corpo', en: 'Body' },
  barba: { it: 'Barba', en: 'Beard' },
  strumenti: { it: 'Strumenti', en: 'Tools' },
};

export const CITIES = ['Catanzaro', 'Cosenza', 'Lamezia Terme', 'Reggio Calabria', 'Tropea', 'Vibo Valentia', 'Crotone'];
export { BRANDS };
