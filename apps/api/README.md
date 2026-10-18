# MyBeauty+ API

Node.js 20+ · Express 4 · TypeScript · MySQL 8 (Prisma 6) · Stripe Connect · Zod · JWT

One REST API for the website (`apps/web`) and the mobile app (`apps/mobile`). Base URL: `http://localhost:4000/api/v1`.

## 1. Run it locally (Windows)

1. **MySQL 8**: install MySQL Community Server (or run `docker compose up -d` in this folder), then create the database:
   ```sql
   CREATE DATABASE mybeauty CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'mybeauty'@'localhost' IDENTIFIED BY 'mybeauty';
   GRANT ALL ON mybeauty.* TO 'mybeauty'@'localhost';
   ```
2. In `D:\mybeauty\apps\api`:
   ```bat
   copy .env.example .env
   npm install
   npx prisma migrate deploy
   npm run seed
   npm run dev
   ```
3. Open http://localhost:4000/api/v1/health → `{"status":"ok","db":"ok","payments":"mock"}`.

Demo accounts (password **demo1234** for all): `giulia@demo.it` (customer), `marco@barberiaelite.it` (approved salon, Stripe ready), `sofia@lunanails.it` (salon under review), `admin@mybeauty.it` (admin).

`npm run seed` **deletes all data** and reloads the demo world. It refuses to run with `NODE_ENV=production`.

## 2. Tests

```bat
REM needs a second, empty database: mybeauty_test
npm test
```
29 end-to-end tests: auth, catalog, seller onboarding + approval, bookings + payments + double-booking race, checkout split, wallet, withdrawals with commission, refunds, jobs, reviews.

## 3. Payments: how the money moves

```
Customer card ──► MyBeauty+ Stripe balance ──(withdrawal: net = gross − commission)──► Salon's Stripe Express account ──► Salon's bank
```

* Each online payment becomes a **ledger line** for the salon with the commission rate **frozen at sale time**.
* Lines are **pending** until the service is completed (+48 h) or a delivered order's 14-day return window ends, then **available**.
* The seller presses **Withdraw** (whole available balance, min €20). Admin approves (or auto-approve in settings). The API creates a Stripe **Transfer** of the net amount; the commission stays with the platform.
* Refunds create negative lines, netted in the next withdrawal.
* Money older than **75 days** is withdrawn automatically: Stripe lets non-US platforms hold funds for 90 days at most.
* Cash paid at the salon: its commission is a negative line in the wallet (setting `commissionOnCash`).

### Mock mode (default)
With `STRIPE_SECRET_KEY` empty nothing touches Stripe. The apps call `POST /payments/:id/mock-confirm` instead of showing a card form, and Stripe onboarding is a redirect that marks the salon ready.

### Real Stripe (test mode first)
1. Create a Stripe account for the company (Italy) and enable **Connect** → *Platform / marketplace*, Express accounts.
2. Put `sk_test_…` in `STRIPE_SECRET_KEY` and `pk_test_…` in `STRIPE_PUBLISHABLE_KEY`.
3. Webhook endpoint `https://<api-domain>/api/v1/webhooks/stripe` with events: `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `account.updated`, `charge.dispute.created`. Include **Connect** events (account.updated comes from connected accounts). Put the signing secret in `STRIPE_WEBHOOK_SECRET`.
4. Locally: `stripe listen --forward-to localhost:4000/api/v1/webhooks/stripe` (Stripe CLI) and use the `whsec_…` it prints.
5. The apps confirm payments with Stripe Elements (web) / PaymentSheet (mobile) using the `clientSecret` returned by `POST /bookings` and `POST /checkout`.

The real Stripe code path has **not** been run against Stripe yet (no keys in this environment). Do a full test-mode pass before going live.

## 4. Main endpoints

| Area | Routes |
| --- | --- |
| Auth | `POST /auth/register` `/auth/login` `/auth/refresh` `/auth/logout` `/auth/forgot` `/auth/reset` `/auth/change-password`, `GET /auth/me` |
| Me | `PATCH /me`, `GET/POST/PUT/DELETE /me/addresses`, `GET /me/favourites`, `POST /me/favourites/toggle`, `GET /me/notifications`, `POST /me/notifications/read`, `GET /me/bookings` `/me/orders` `/me/orders/:id` `/me/reviews` `/me/tickets` |
| Catalog (public) | `GET /salons` `/salons/:slug` `/salons/:id/availability` `/salons/:id/availability/days` `/products` `/products/:id` `/banners` `/categories` `/cities` |
| Bookings | `POST /bookings`, `GET /bookings/:id`, `POST /bookings/:id/pay` `/cancel` `/reschedule` |
| Shop | `POST /cart/quote`, `POST /checkout`, `POST /orders/:id/return` |
| Payments | `GET /payments/config`, `GET /payments/:id`, `POST /payments/:id/mock-confirm`, `POST /webhooks/stripe` |
| Reviews / support | `POST /reviews`, `POST /support/tickets` |
| Uploads | `POST /uploads` (field `files`, ≤10 images), `POST /uploads/private` (field `file`), `GET /files` (signed) |
| Seller | `GET/PUT /seller/application`, `POST /seller/application/documents`, `GET /seller/application/checklist`, `POST /seller/application/submit`, `PATCH /seller/salon`, CRUD `/seller/services` `/seller/products` `/seller/staff` `/seller/coupons`, `GET /seller/agenda`, `POST /seller/bookings` (walk-in), `PATCH /seller/bookings/:id`, `GET /seller/orders`, `PATCH /seller/sub-orders/:id`, `POST /seller/sub-orders/:id/reject-return`, `GET /seller/reviews`, `POST /seller/reviews/:id/reply`, `GET /seller/clients`, `GET /seller/stats` |
| Wallet | `GET /seller/wallet` `/seller/wallet/ledger`, `POST /seller/stripe/onboarding`, `GET /seller/stripe/status`, `GET/POST /seller/withdrawals` |
| Admin | `/admin/applications` (+ `/checklist` `/approve` `/reject` `/request-info`), `/admin/salons` (+ `/wallet` `/adjustments`), `/admin/products` (+ `/moderate`), `/admin/users`, `/admin/bookings`, `/admin/orders`, `/admin/sub-orders/:id/refund`, `/admin/reviews`, `/admin/withdrawals` (+ `/approve` `/reject`), `/admin/coupons`, `/admin/banners`, `/admin/tickets`, `/admin/settings`, `/admin/stats`, `/admin/audit` |

Errors are always `{ "error": { "code", "message", "details?" } }`; validation errors return 422 with `fields`.

## 5. Production checklist

- `NODE_ENV=production`, real `JWT_*` secrets (48+ random bytes), `STRIPE_*` live keys.
- `STORAGE_DRIVER=s3` (Cloudflare R2): local disk is lost on most hosts when they redeploy.
- SMTP provider configured (otherwise emails only go to the log).
- Run `npx prisma migrate deploy` on each release; never `migrate reset` or `npm run seed` in production.
- One instance with `RUN_JOBS=true` (scheduled jobs), others `false`.
- Daily MySQL backups (managed DB or `mysqldump` cron) and HTTPS in front (Nginx/Caddy or the host's proxy).

## 6. Folder map

`prisma/` schema, migrations, seed · `src/modules/*` one folder per feature (routes + services) · `src/lib` shared helpers (auth, money, storage, mail, serializers) · `src/jobs` scheduled jobs · `tests/` end-to-end suite.
