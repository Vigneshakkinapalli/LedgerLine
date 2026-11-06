import crypto from 'node:crypto';
import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';
import { config } from '../config.js';
import type { AuthenticatedUser } from './types.js';

export interface TokenClaims { sub: string; sid: string; }

export function signAccessToken(userId: string, sessionId: string): string {
  const options: SignOptions = { expiresIn: config.JWT_EXPIRES_IN as SignOptions['expiresIn'] };
  return jwt.sign({ sub: userId, sid: sessionId }, config.JWT_SECRET, options);
}

export function verifyAccessToken(token: string): TokenClaims {
  const decoded = jwt.verify(token, config.JWT_SECRET) as JwtPayload;
  if (typeof decoded.sub !== 'string' || typeof decoded.sid !== 'string') throw new Error('Invalid token claims');
  return { sub: decoded.sub, sid: decoded.sid };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function authResponse(user: AuthenticatedUser, token: string) {
  return { accessToken: token, tokenType: 'Bearer', user: { id: user.id, email: user.email, roles: user.roles } };
}
