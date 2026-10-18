import { env, stripeMode } from './config';
import { createApp } from './app';
import { prisma } from './lib/prisma';
import { startJobs } from './jobs';

const app = createApp();
const host = process.env.HOST || '0.0.0.0';
const server = app.listen(env.PORT, host, () => {
  console.log(`✨ MyBeauty+ API on http://${host}:${env.PORT}/api/v1  (env=${env.NODE_ENV}, payments=${stripeMode}, tz=${process.env.TZ})`);
  if (stripeMode === 'mock') console.log('   ⚠ Stripe MOCK mode — set STRIPE_SECRET_KEY (test key) to use real Stripe test payments.');
});
if (env.RUN_JOBS) startJobs();

const shutdown = async (sig: string) => {
  console.log(`\n${sig} received, shutting down…`);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
