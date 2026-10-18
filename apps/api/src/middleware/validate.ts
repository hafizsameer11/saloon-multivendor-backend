import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';

/** Validates req.body / req.query and replaces them with the parsed (typed, defaulted) value. */
export const body =
  (schema: ZodTypeAny) =>
  (req: Request, _res: Response, next: NextFunction) => {
    const r = schema.safeParse(req.body ?? {});
    if (!r.success) return next(r.error);
    req.body = r.data;
    next();
  };

export const query =
  (schema: ZodTypeAny) =>
  (req: Request, res: Response, next: NextFunction) => {
    const r = schema.safeParse(req.query ?? {});
    if (!r.success) return next(r.error);
    res.locals.query = r.data;
    next();
  };

export const q = <S extends ZodTypeAny>(res: Response, _schema: S) => res.locals.query as z.infer<S>;
