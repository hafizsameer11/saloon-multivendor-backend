import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { MulterError } from 'multer';
import { HttpError } from '../lib/errors';
import { isProd } from '../config';
import { tr } from '../lib/i18n';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: 'route_not_found', message: tr(`Nessuna rotta ${req.method} ${req.path}`) } });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    const d = err.details as { missing?: string[] } | undefined;
    const details = d && Array.isArray(d.missing) ? { ...d, missing: d.missing.map((x) => tr(x)) } : err.details;
    return res.status(err.status).json({ error: { code: err.code, message: tr(err.message), details } });
  }
  if (err instanceof ZodError) {
    return res.status(422).json({
      error: {
        code: 'validation_error',
        message: tr('Dati non validi'),
        fields: Object.fromEntries(Object.entries(err.flatten().fieldErrors).map(([k, v]) => [k, (v ?? []).map((x) => tr(x))])),
        issues: err.issues.map((i) => ({ ...i, message: tr(i.message) })),
      },
    });
  }
  if (err instanceof MulterError) {
    return res.status(400).json({ error: { code: 'upload_error', message: err.code === 'LIMIT_FILE_SIZE' ? tr('File troppo grande (max 10 MB)') : err.message } });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') return res.status(409).json({ error: { code: 'duplicate', message: tr('Esiste già un elemento con questi dati'), details: err.meta } });
    if (err.code === 'P2025') return res.status(404).json({ error: { code: 'not_found', message: tr('Elemento non trovato') } });
  }
  if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'bad_json', message: tr('JSON non valido') } });
  }
  console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  res.status(500).json({ error: { code: 'internal', message: isProd ? tr('Errore interno') : String((err as Error)?.message ?? err) } });
}
