import { execSync } from 'node:child_process';

/** Fresh schema + demo data in the TEST database before the suite. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'mysql://mybeauty:mybeauty@localhost:3306/mybeauty_test';
  const env = { ...process.env, DATABASE_URL: url, TZ: 'Europe/Rome' };
  execSync('npx prisma migrate deploy', { env, stdio: 'inherit' }); // non-destructive; the seed below clears demo rows
  execSync('npx tsx prisma/seed.ts', { env, stdio: 'inherit' });
}
