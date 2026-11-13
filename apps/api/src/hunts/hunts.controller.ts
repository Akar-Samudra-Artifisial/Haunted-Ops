import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CUID_PATTERN, SERVICE_NAMES, type HuntDetail, type HuntEndReason, type ServiceName } from '@haunted-ops/shared';
import { RATE_LIMIT_WINDOW_MS } from '../security/rate-limit.guard.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { HuntRunner, type HuntRequest } from './hunt-runner.js';
import { PrismaHuntStore } from './hunt-store.js';

/** Starting Hunts is rare and spends Credits: 5 requests per minute per client. */
export const START_LIMIT_PER_MINUTE = 5;

export interface StartHuntAnswer {
  huntId: string;
  status: 'queued' | 'cancelled';
  reason: HuntEndReason | null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `{ incidentId }` or `{ service }`, and nothing else. */
export function parseStartBody(body: unknown): HuntRequest | null {
  if (!isPlainObject(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1) return null;
  if (keys[0] === 'incidentId') {
    const id = body.incidentId;
    return typeof id === 'string' && CUID_PATTERN.test(id) ? { trigger: 'operator', incidentId: id } : null;
  }
  if (keys[0] === 'service') {
    const s = body.service;
    return typeof s === 'string' && (SERVICE_NAMES as readonly string[]).includes(s) ? { trigger: 'operator', service: s as ServiceName } : null;
  }
  return null;
}

/** `{ enabled: boolean }` and nothing else. */
export function parseKillSwitchBody(body: unknown): boolean | null {
  if (!isPlainObject(body)) return null;
  const keys = Object.keys(body);
  return keys.length === 1 && keys[0] === 'enabled' && typeof body.enabled === 'boolean' ? body.enabled : null;
}

@Controller('api/hunts')
export class HuntsController {
  constructor(
    private readonly runner: HuntRunner,
    private readonly store: PrismaHuntStore,
  ) {}

  /** The only way to start a Hunt by hand. */
  @Post()
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AdminAuthGuard)
  @Throttle({ default: { limit: START_LIMIT_PER_MINUTE, ttl: RATE_LIMIT_WINDOW_MS } })
  async start(@Body() body: unknown): Promise<StartHuntAnswer> {
    const request = parseStartBody(body);
    if (request === null) throw new BadRequestException();
    const result = await this.runner.request(request);
    if (result.kind === 'no_open_incident') throw new NotFoundException({ code: 'no_open_incident' });
    if (result.kind === 'skipped') throw new ServiceUnavailableException();
    return { huntId: result.huntId, status: result.status, reason: result.reason };
  }

  @Post('kill-switch')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AdminAuthGuard)
  async killSwitch(@Body() body: unknown): Promise<{ enabled: boolean }> {
    const enabled = parseKillSwitchBody(body);
    if (enabled === null) throw new BadRequestException();
    return { enabled: await this.runner.setEnabled(enabled) };
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  async get(@Param('id') id: string): Promise<HuntDetail> {
    if (!CUID_PATTERN.test(id)) throw new BadRequestException();
    const hunt = await this.store.get(id);
    if (hunt === null) throw new NotFoundException();
    return hunt;
  }
}
