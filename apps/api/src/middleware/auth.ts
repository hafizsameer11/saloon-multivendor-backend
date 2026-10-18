import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@prisma/client';
import { verifyAccess, type AccessClaims } from '../lib/auth';
import { forbidden, unauthorized } from '../lib/errors';
import { prisma } from '../lib/prisma';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AccessClaims;
    }
  }
}

const readToken = (req: Request) => {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  return undefined;
};

/** Attaches req.user when a valid token is present; never fails. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const t = readToken(req);
  if (t) {
    try {
      req.user = verifyAccess(t);
    } catch {
      /* ignore invalid token on public routes */
    }
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const t = readToken(req);
  if (!t) return next(unauthorized());
  try {
    req.user = verifyAccess(t);
    next();
  } catch {
    next(unauthorized('Sessione scaduta', 'token_expired'));
  }
}

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };

/**
 * Seller routes: resolves the caller's salon (fresh from DB, the token may be older than the salon)
 * and stores it on res.locals.salon. Pass { approved: true } for actions only approved salons may do.
 */
export const requireSalon =
  (opts: { approved?: boolean } = {}) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.user) throw unauthorized();
      if (req.user.role !== 'seller') throw forbidden('Solo per account salone');
      const salon = await prisma.salon.findUnique({ where: { ownerId: req.user.sub } });
      if (!salon) throw forbidden('Nessun salone associato a questo account', 'no_salon');
      if (opts.approved && salon.status !== 'approved')
        throw forbidden('Il tuo salone deve essere approvato prima di questa azione', 'salon_not_approved');
      if (salon.status === 'suspended' && req.method !== 'GET') throw forbidden('Salone sospeso', 'salon_suspended');
      res.locals.salon = salon;
      next();
    } catch (e) {
      next(e);
    }
  };
