import crypto from 'node:crypto';

/** Human-friendly codes shown to customers (booking MB-48213, order ORD-…) */
export const humanCode = (prefix: string) => `${prefix}-${crypto.randomInt(10000, 99999)}${crypto.randomBytes(1).toString('hex').toUpperCase()}`;
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60) || 'salone';
