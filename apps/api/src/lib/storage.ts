/**
 * File storage with two drivers:
 *  - local: ./uploads/public (served at /uploads) and ./uploads/private (only via signed URL)
 *  - s3:    any S3-compatible bucket (Cloudflare R2, AWS S3). Public files under public/, private under private/.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config';

export const UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads');

const s3 =
  env.STORAGE_DRIVER === 's3'
    ? new S3Client({
        region: env.S3_REGION,
        endpoint: env.S3_ENDPOINT || undefined,
        credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
      })
    : null;

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf',
};

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
export const DOC_TYPES = [...IMAGE_TYPES, 'application/pdf'];

/** Checks the real file signature, not just the client-sent mimetype. */
export function sniffType(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.subarray(4, 8).toString() === 'ftyp' && /hei|mif|hev/.test(buf.subarray(8, 12).toString())) return 'image/heic';
  if (buf.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  return null;
}

export async function putFile(buf: Buffer, mime: string, visibility: 'public' | 'private', folder: string) {
  const key = `${visibility}/${folder}/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${EXT[mime] ?? 'bin'}`;
  if (s3) {
    await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: buf, ContentType: mime, CacheControl: visibility === 'public' ? 'public, max-age=31536000, immutable' : 'private' }));
  } else {
    const full = path.join(UPLOAD_ROOT, key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buf);
  }
  return key;
}

export function publicUrl(key: string) {
  if (s3) return `${env.S3_PUBLIC_URL.replace(/\/$/, '')}/${key}`;
  return `${env.API_PUBLIC_URL.replace(/\/$/, '')}/uploads/${key.replace(/^public\//, '')}`;
}

/** Short-lived link for private files (seller documents). Local driver signs with the JWT secret. */
export async function signedUrl(key: string, seconds = 300) {
  if (s3) return getSignedUrl(s3, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), { expiresIn: seconds });
  const exp = Math.floor(Date.now() / 1000) + seconds;
  const sig = crypto.createHmac('sha256', env.JWT_ACCESS_SECRET).update(`${key}:${exp}`).digest('base64url');
  return `${env.API_PUBLIC_URL.replace(/\/$/, '')}/api/v1/files?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}`;
}

export function verifyLocalSignature(key: string, exp: number, sig: string) {
  if (exp < Date.now() / 1000) return false;
  const good = crypto.createHmac('sha256', env.JWT_ACCESS_SECRET).update(`${key}:${exp}`).digest('base64url');
  return good.length === sig.length && crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig));
}

export const localPath = (key: string) => {
  const full = path.resolve(UPLOAD_ROOT, key);
  if (!full.startsWith(UPLOAD_ROOT + path.sep)) throw new Error('bad key');
  return full;
};
