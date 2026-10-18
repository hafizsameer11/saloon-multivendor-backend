/**
 * POST /uploads          multipart "files" (1–10 images, ≤10 MB each) → public URLs (service/product/salon photos)
 * POST /uploads/private  multipart "file" (image or PDF) → private key (seller documents; read via signed URL)
 * GET  /files?key&exp&sig  serves private files for the local driver
 */
import { Router } from 'express';
import { tr } from '../../lib/i18n';
import multer from 'multer';
import fs from 'node:fs';
import { ah, badRequest, forbidden } from '../../lib/errors';
import { requireAuth } from '../../middleware/auth';
import { DOC_TYPES, IMAGE_TYPES, localPath, putFile, publicUrl, sniffType, verifyLocalSignature } from '../../lib/storage';
import rateLimit from 'express-rate-limit';
import { isTest } from '../../config';

export const uploadsRouter = Router();
const mem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 10 } });
const limiter = rateLimit({ windowMs: 60_000, limit: isTest ? 10_000 : 60 });

uploadsRouter.post(
  '/uploads',
  requireAuth,
  limiter,
  mem.array('files', 10),
  ah(async (req, res) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (!files.length) throw badRequest('Nessun file ricevuto (campo "files")', 'no_files');
    const folder = req.user!.role === 'customer' ? 'avatars' : 'catalog';
    const out = [];
    for (const f of files) {
      const type = sniffType(f.buffer);
      if (!type || !IMAGE_TYPES.includes(type)) throw badRequest(`${f.originalname}: formato non supportato (JPG, PNG, WEBP, HEIC)`, 'bad_type');
      const key = await putFile(f.buffer, type, 'public', folder);
      out.push({ url: publicUrl(key), key, name: f.originalname, size: f.size });
    }
    res.status(201).json({ files: out });
  }),
);

uploadsRouter.post(
  '/uploads/private',
  requireAuth,
  limiter,
  mem.single('file'),
  ah(async (req, res) => {
    if (req.user!.role === 'customer') throw forbidden();
    const f = req.file;
    if (!f) throw badRequest('Nessun file ricevuto (campo "file")', 'no_files');
    const type = sniffType(f.buffer);
    if (!type || !DOC_TYPES.includes(type)) throw badRequest('Formato non supportato (PDF, JPG, PNG)', 'bad_type');
    const key = await putFile(f.buffer, type, 'private', 'documents');
    res.status(201).json({ key, name: f.originalname, size: f.size });
  }),
);

uploadsRouter.get('/files', (req, res) => {
  const { key, exp, sig } = req.query as Record<string, string>;
  if (!key || !exp || !sig || !verifyLocalSignature(key, Number(exp), sig)) return res.status(403).json({ error: { code: 'bad_signature', message: tr('Link scaduto o non valido') } });
  let p: string;
  try {
    p = localPath(key);
  } catch {
    return res.status(400).end();
  }
  if (!fs.existsSync(p)) return res.status(404).json({ error: { code: 'not_found', message: tr('File non trovato') } });
  res.setHeader('Cache-Control', 'private, no-store');
  res.sendFile(p);
});
