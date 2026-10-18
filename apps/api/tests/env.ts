// Test env: separate database, mock Stripe, console mailer.
process.env.NODE_ENV = 'test';
process.env.TZ = 'Europe/Rome';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'mysql://mybeauty:mybeauty@localhost:3306/mybeauty_test';
process.env.STRIPE_SECRET_KEY = '';
process.env.SMTP_HOST = '';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789-0123456789';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789-0123456789';
process.env.RUN_JOBS = 'false';
