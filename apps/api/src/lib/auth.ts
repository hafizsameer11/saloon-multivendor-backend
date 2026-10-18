import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '../config';
import { prisma } from './prisma';
import { randomToken, sha256 } from './ids';

export interface AccessClaims {
  sub: string;
  role: Role;
  salonId?: string;
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, 11);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

export const signAccess = (c: AccessClaims) =>
  jwt.sign(c, env.JWT_ACCESS_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'] });

export const verifyAccess = (token: string) => jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessClaims & { exp: number };

/** Refresh tokens are random strings; only their SHA-256 is stored, so a DB leak can't be replayed. */
export async function issueRefresh(userId: string, userAgent?: string) {
  const token = randomToken(48);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_DAYS * 86400_000);
  await prisma.refreshToken.create({ data: { userId, tokenHash: sha256(token), expiresAt, userAgent: userAgent?.slice(0, 250) } });
  return { token, expiresAt };
}

/** Rotate: the old refresh token is revoked and a new one issued. Reuse of a revoked token revokes all sessions. */
export async function rotateRefresh(token: string, userAgent?: string) {
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: { include: { salon: { select: { id: true } } } } } });
  if (!row) return null;
  if (row.revokedAt) {
    // token reuse → likely stolen; kill every session of this user
    await prisma.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    return null;
  }
  if (row.expiresAt < new Date() || row.user.blocked) return null;
  await prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
  const next = await issueRefresh(row.userId, userAgent);
  return { user: row.user, refresh: next };
}

export async function revokeRefresh(token: string) {
  await prisma.refreshToken.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
}

export const claimsFor = (u: { id: string; role: Role; salon?: { id: string } | null }): AccessClaims => ({
  sub: u.id,
  role: u.role,
  salonId: u.salon?.id,
});
