# MyBeauty+ API — progress log

Read this first if you are continuing the work. Plan document: "MyBeauty+ Backend Plan" (Claude Docs).

| Phase | Status | Notes |
| --- | --- | --- |
| B1 Foundation | ✅ code done | Express + TS, Prisma schema (MySQL), migrations, seed from demo data |
| B2 Accounts | ✅ code done | register client/seller, login, refresh rotation, forgot/reset, me, addresses, favourites |
| B3 Catalog | ✅ code done | public salons/products/availability, uploads (local + S3) |
| B4 Seller onboarding | ✅ code done | application, documents, submit, admin approve/reject/needs_info, product moderation |
| B5 Bookings | ✅ code done | availability engine, row-lock booking, cancel/reschedule, agenda, walk-in |
| B6 Shop | ✅ code done | quote, checkout split per salon, stock reservation, coupons, returns |
| B7 Payments + wallet | ✅ code done | Stripe PaymentIntents + mock, webhook, Connect Express, ledger, withdrawals |
| B8 Reviews + admin ops | ✅ code done | reviews, notifications, coupons, banners, tickets, settings, stats |
| Tests | ✅ 40/40 passing | `npm test` (needs empty DB mybeauty_test) |
| B9a Connect WEB | ✅ done | `apps/web/.env.local` → `VITE_API_URL=http://localhost:4000/api/v1`. Browser e2e: 27 steps pass (signup→approval→booking+payment→order→shipping→wallet→withdrawal) |
| B9b Connect MOBILE | ✅ done | `apps/mobile/.env` → `EXPO_PUBLIC_API_URL=http://<PC-LAN-IP>:4000/api/v1`. Expo-web e2e: 16 steps pass. Native PaymentSheet code written, NOT yet run on a phone with real Stripe keys |
| B9c Scope cut | ✅ done | Google/Apple sign-in, push, SMS and SDI e-invoicing removed from scope (client request) — buttons/toggles/texts removed in web + app |
| B9d Translation IT/EN | ✅ done | `X-Lang` header on every call; server errors + Zod messages translated (`src/lib/i18n.ts`, `tr()`); notifications/emails in the recipient's `User.lang` via `m(it,en)`; switching language updates `User.lang`; UI strings, dates, address labels, amenities, aria-labels translated in web + app |
| B9e Light/dark theme | ✅ done | Web: CSS-variable palette, `data-theme` on `<html>`, toggle in public + dashboard headers. App: `C` palette swapped by `applyTheme()` + navigator remount (returns to the same screen), toggle on home/profile/seller "Altro". Photo areas use `.on-dark` (web) / `<OnDark>` + fixed `D` palette (app). Persisted per device |
| B9f Time windows | ✅ done | `TimeWindow` table + `Booking.windowId`. Seller: `GET/POST/PATCH/DELETE /seller/windows` (bulk create by date range × weekdays, skips duplicates / stylist clashes). Customer: `POST /bookings {windowId}`; places counted under the salon row lock. Catalog returns bookable windows; staffed windows appear in `busy`. Web: `/seller/fasce`, agenda strip, salon page section, booking wizard. App: seller "Fasce orarie" (More), agenda chips, salon page, booking flow. Shared rules: `slots.ts` (windowCheck), `windows.ts` (planWindows) |
| B10 Launch prep | 🟡 partly | README production checklist + docker-compose MySQL done; hosting/backups when the client picks a host |

## Known issues / decisions pending
- Cash commission: salons paid mostly in cash end with a NEGATIVE wallet (commission owed > online money). Needs a collection method (monthly charge of the seller's card/SEPA via Stripe, or mandatory online deposit). Not built yet.
- Real Stripe path not yet run against Stripe test keys (only mock mode tested).
- 3 npm audit advisories inside Prisma CLI config tooling; fixed only by Prisma 7 (major upgrade).
- Salon rating is recomputed from real reviews on the first new review (seed ratings are invented).

## Theme notes (for whoever edits UI)
- Web: never hard-code `text-[#...]`; use tokens (`ivory`, `mute`, `gold`, `err`…). Text on photos/crimson/gold: wrap in `.on-dark`, or use `text-snow` / `text-coal`.
- App: `C.*` follows the theme, `D.*` never changes. Use `C.snow`/`C.coal` on crimson/gold. Screens with `<Screen light>` and photo blocks wrapped in `<OnDark>` use the fixed palette. Module-level constants must not capture `C` values (read them at render).
- Switching theme in the app remounts the navigator: the user stays on the screen but the back-history resets.

## How the apps talk to the API (B9)
- `packages/shared/src/api/client.ts` — fetch client, token refresh, ApiError
- `packages/shared/src/api/remote.ts` — loaders (catalog, per-role session) + every mutation
- `packages/shared/src/api/sync.ts` — `installRemote(store, api)`: wraps the existing store actions (instant UI → API → reload), writes run one at a time in order
- `packages/shared/src/slots.ts` — ONE availability engine used by API, web and mobile
- Without `VITE_API_URL` the website still runs as the standalone demo prototype.

## Fixed during B9 (worth knowing)
- Web/mobile computed free slots differently from the server (45-min grid, lunch break) → one shared engine (`slots.ts`).
- Server required a service before applying, but the wizard has no services step → rule removed; salons without services are hidden publicly instead.
- Temporary ids of just-created services could be saved into staff → ids swapped on create + server cleans staff serviceIds.
- "Approve" could overtake "save checklist" → app writes now run strictly in order.
- Mobile new-address form had no province/phone (server requires them) → added.

## Next step
B10 launch prep: pick hosting (API + MySQL + R2), real Stripe test-mode pass (web Elements + mobile PaymentSheet on a phone), SMTP provider, decide cash-commission collection.
