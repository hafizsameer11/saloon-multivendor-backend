/** Throw these from services; the error middleware turns them into JSON responses. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = 'bad_request', details?: unknown) => new HttpError(400, code, message, details);
export const unauthorized = (message = 'Accesso richiesto', code = 'unauthorized') => new HttpError(401, code, message);
export const forbidden = (message = 'Non hai i permessi per questa azione', code = 'forbidden') => new HttpError(403, code, message);
const FEMININE = new Set(['Risorsa', 'Prenotazione', 'Candidatura', 'Recensione']);
export const notFound = (what = 'Risorsa') => new HttpError(404, 'not_found', `${what} non ${FEMININE.has(what) ? 'trovata' : 'trovato'}`);
export const conflict = (message: string, code = 'conflict', details?: unknown) => new HttpError(409, code, message, details);

/** Wrap async route handlers so thrown errors reach the error middleware (Express 4). */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
export const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
