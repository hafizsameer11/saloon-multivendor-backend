import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import path from 'node:path';
import { env, isTest, stripeMode } from './config';
import { prisma } from './lib/prisma';
import { UPLOAD_ROOT } from './lib/storage';
import { errorHandler, notFoundHandler } from './middleware/error';
import { optionalAuth } from './middleware/auth';
import { langMiddleware } from './lib/i18n';
import { authRouter } from './modules/auth/routes';
import { meRouter } from './modules/me/routes';
import { catalogRouter } from './modules/catalog/routes';
import { uploadsRouter } from './modules/uploads/routes';
import { bookingsRouter } from './modules/bookings/routes';
import { shopRouter } from './modules/shop/routes';
import { paymentsRouter, webhookHandler } from './modules/payments/routes';
import { reviewsRouter } from './modules/reviews/routes';
import { sellerRouter } from './modules/seller/routes';
import { walletRouter } from './modules/wallet/routes';
import { adminRouter } from './modules/admin/routes';
import { supportRouter } from './modules/support/routes';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(langMiddleware);
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  // Allow all browser origins (Dokploy / multi-domain)
  app.use(cors({ origin: true, credentials: true }));
  app.use(compression());
  if (!isTest) app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

  // Stripe needs the raw body to verify the signature → mounted BEFORE express.json()
  app.post('/api/v1/webhooks/stripe', express.raw({ type: 'application/json', limit: '1mb' }), webhookHandler);

  app.use(express.json({ limit: '1mb' }));
  app.use('/uploads', express.static(path.join(UPLOAD_ROOT, 'public'), { maxAge: '365d', immutable: true }));

  const api = express.Router();
  api.use(optionalAuth);
  api.get('/health', async (_req, res) => {
    let db = 'ok';
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'down';
    }
    res.status(db === 'ok' ? 200 : 503).json({ status: db === 'ok' ? 'ok' : 'degraded', db, payments: stripeMode, time: new Date().toISOString(), version: '0.1.0' });
  });
  api.use('/auth', authRouter);
  api.use('/me', meRouter);
  api.use('/', catalogRouter);
  api.use('/', uploadsRouter);
  api.use('/', bookingsRouter);
  api.use('/', shopRouter);
  api.use('/payments', paymentsRouter);
  api.use('/', reviewsRouter);
  api.use('/', supportRouter);
  api.use('/seller', sellerRouter);
  api.use('/seller', walletRouter);
  api.use('/admin', adminRouter);
  app.use('/api/v1', api);

  app.get('/', (_req, res) => res.json({ name: 'MyBeauty+ API', docs: '/api/v1/health' }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
