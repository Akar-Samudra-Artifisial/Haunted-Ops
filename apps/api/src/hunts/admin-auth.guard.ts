import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { HUNT_CONFIG } from '../tokens.js';
import type { HuntConfig } from './hunt-config.js';

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/**
 * Exact check of a bearer token against `HUNT_ADMIN_TOKEN`. Both sides are hashed with SHA-256, so
 * the comparison has a fixed length and `timingSafeEqual` leaks nothing about the token. A missing
 * header, another scheme, a wrong token or no configured token all give the same 401.
 */
export function isAdminAuthorized(header: unknown, token: string | null): boolean {
  if (token === null) return false;
  if (typeof header !== 'string') return false;
  const m = /^Bearer ([^\s]{1,512})$/.exec(header);
  if (m === null) return false;
  return timingSafeEqual(digest(m[1] as string), digest(token));
}

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(@Inject(HUNT_CONFIG) private readonly config: HuntConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ headers?: Record<string, unknown> }>();
    if (!isAdminAuthorized(req.headers?.authorization, this.config.adminToken)) throw new UnauthorizedException();
    return true;
  }
}
