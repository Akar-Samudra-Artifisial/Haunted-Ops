import {
  ConflictException,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CUID_PATTERN, type ProposalView } from '@haunted-ops/shared';
import { AdminAuthGuard } from '../hunts/admin-auth.guard.js';
import { RATE_LIMIT_WINDOW_MS } from '../security/rate-limit.guard.js';
import { FIX_CONFIG } from '../tokens.js';
import type { FixConfig } from './fix-config.js';
import { ProposalRunner } from './proposal-runner.js';
import { PrismaProposalStore } from './proposal-store.js';

/** A retry spends Credits and writes to GitHub: 5 requests per minute per client, like starting a Hunt. */
export const PROPOSAL_LIMIT_PER_MINUTE = 5;

export interface StartProposalAnswer {
  proposalId: string;
  status: 'drafting';
  attempt: number;
}

@Controller('api')
export class FixController {
  constructor(
    private readonly runner: ProposalRunner,
    private readonly store: PrismaProposalStore,
    @Inject(FIX_CONFIG) private readonly cfg: FixConfig,
  ) {}

  /** Public: the Proposal as the table shows it. No token, path or raw model text is in it. */
  @Get('proposals/:id')
  @Header('Cache-Control', 'no-store')
  async get(@Param('id') id: string): Promise<ProposalView> {
    if (!CUID_PATTERN.test(id)) throw new NotFoundException();
    const view = await this.store.view(id);
    if (view === null) throw new NotFoundException();
    return view;
  }

  /** The operator retries a failed Proposal of a succeeded Hunt as the next attempt. */
  @Post('hunts/:id/proposal')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AdminAuthGuard)
  @Throttle({ default: { limit: PROPOSAL_LIMIT_PER_MINUTE, ttl: RATE_LIMIT_WINDOW_MS } })
  async retry(@Param('id') id: string): Promise<StartProposalAnswer> {
    if (!this.cfg.enabled) throw new NotFoundException();
    const out = await this.runner.request(id, 'operator');
    switch (out.kind) {
      case 'started':
        return { proposalId: out.proposalId, status: 'drafting', attempt: out.attempt };
      case 'not_found':
        throw new NotFoundException();
      case 'disabled':
        // The Kill switch is off: no new Proposal starts.
        throw new ServiceUnavailableException();
      case 'not_succeeded':
        throw new ConflictException({ code: 'hunt_not_succeeded' });
      case 'conflict':
        throw new ConflictException({ code: 'proposal_active_or_final' });
    }
  }
}
