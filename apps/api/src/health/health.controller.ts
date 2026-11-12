import { Controller, Get, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { PrismaService } from '../prisma/prisma.service.js';

export const HEALTH_DB_TIMEOUT_MS = 2_000;

export type Health = { status: 'ok'; db: 'up' } | { status: 'degraded'; db: 'down' };

/** Resolves true if the check settles truthy within the timeout. Never rejects. */
export async function withinTimeout(check: () => Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([check().then(() => true, () => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('healthz')
  async health(@Res() res: ServerResponse): Promise<void> {
    const up = await withinTimeout(() => this.prisma.client.$queryRaw`SELECT 1`, HEALTH_DB_TIMEOUT_MS);
    const body: Health = up ? { status: 'ok', db: 'up' } : { status: 'degraded', db: 'down' };
    res.statusCode = up ? 200 : 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  }
}
