import { Injectable, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/** Methods that never count against the rate limit. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isMutating(method: unknown): boolean {
  return typeof method === 'string' && !SAFE_METHODS.has(method.toUpperCase());
}

export const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Global guard on @nestjs/throttler. Only POST, PUT, PATCH and DELETE count,
 * so reads and SSE streams are never limited. Over the limit it answers 429
 * with Retry-After (set by the throttler).
 */
@Injectable()
export class RateLimitGuard extends ThrottlerGuard {
  protected override async shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<{ method?: string }>();
    return !isMutating(req.method);
  }
}
