import { Module, type DynamicModule, type ModuleMetadata } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Config } from './config/config.js';
import { EventBus } from './events/event-bus.js';
import { SseController } from './events/sse.controller.js';
import { SseService } from './events/sse.service.js';
import { HealthController } from './health/health.controller.js';
import { FixController } from './fix/fix.controller.js';
import { FixerWorkdir } from './fix/fixer-workdir.js';
import { GitClient } from './fix/git-client.js';
import { GithubClient } from './fix/github-client.js';
import { HttpChaosClient, HttpFixLab } from './fix/lab-deploy-client.js';
import { ProposalRunner, type ProposalRunnerDeps } from './fix/proposal-runner.js';
import { PrismaProposalStore } from './fix/proposal-store.js';
import { parseFixConfig, type FixConfig } from './fix/fix-config.js';
import { AdminAuthGuard } from './hunts/admin-auth.guard.js';
import { parseHuntConfig, type HuntConfig } from './hunts/hunt-config.js';
import { HuntRunner, type HuntRunnerDeps } from './hunts/hunt-runner.js';
import { PrismaHuntStore } from './hunts/hunt-store.js';
import { HuntWorkdir } from './hunts/hunt-workdir.js';
import { HuntsController } from './hunts/hunts.controller.js';
import { HttpLabClient } from './hunts/lab-client.js';
import { IngestController } from './ingest/ingest.controller.js';
import { IngestRunner } from './ingest/ingest.runner.js';
import { IngestService } from './ingest/ingest.service.js';
import { PrismaIngestStore } from './ingest/store.js';
import { PrismaService } from './prisma/prisma.service.js';
import { JsonLogger } from './security/logger.js';
import { RATE_LIMIT_WINDOW_MS, RateLimitGuard } from './security/rate-limit.guard.js';
import { ServicesController } from './services/services.controller.js';
import { ServicesService } from './services/services.service.js';
import { APP_CONFIG, FIX_CONFIG, HUNT_CONFIG } from './tokens.js';

export interface AppModuleOptions {
  config: Config;
  logger: JsonLogger;
  /** Extra modules, used by tests to mount test-only routes. */
  imports?: ModuleMetadata['imports'];
  /** Hunt settings. Without them Hunts are off. */
  huntConfig?: HuntConfig;
  /** Test seams of the Hunt runner (a fake process, a fake lab, a clock). */
  huntOverrides?: Partial<Pick<HuntRunnerDeps, 'spawn' | 'lab' | 'now' | 'workdir' | 'mcpBinDir' | 'parentEnv' | 'ledgerPollMs'>>;
  /** Fix-flow settings. Without them the fix flow is off. */
  fixConfig?: FixConfig;
  /** Test seams of the fix flow: a fake GitHub URL, a local git remote, a fake process, timings. */
  fixOverrides?: FixOverrides;
}

export interface FixOverrides extends Partial<Pick<ProposalRunnerDeps, 'spawn' | 'now' | 'sleep' | 'parentEnv' | 'timings' | 'poll' | 'reapOrphans'>> {
  /** Test only: the base URL of the fake GitHub server. Production never sets it (the client uses https://api.github.com). */
  githubBaseUrl?: string;
  /** Test only: where `git fetch` and `git push` go instead of github.com. */
  gitRemoteUrl?: (repo: string) => string;
  allowFileProtocol?: boolean;
}

@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    const { config, logger } = options;
    const huntConfig = options.huntConfig ?? parseHuntConfig({});
    const overrides = options.huntOverrides ?? {};
    const fixConfig = options.fixConfig ?? parseFixConfig({}, huntConfig);
    const fixOverrides = options.fixOverrides ?? {};
    return {
      module: AppModule,
      global: true,
      imports: [
        ThrottlerModule.forRoot([{ name: 'default', ttl: RATE_LIMIT_WINDOW_MS, limit: config.rateLimitMax }]),
        ...(options.imports ?? []),
      ],
      controllers: [HealthController, ServicesController, IngestController, SseController, HuntsController, FixController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: HUNT_CONFIG, useValue: huntConfig },
        { provide: FIX_CONFIG, useValue: fixConfig },
        AdminAuthGuard,
        { provide: JsonLogger, useValue: logger },
        { provide: APP_GUARD, useClass: RateLimitGuard },
        // One process-wide Prisma client and one in-memory event bus.
        { provide: PrismaService, useFactory: () => new PrismaService(config.databaseUrl) },
        { provide: EventBus, useFactory: () => new EventBus() },
        {
          provide: SseService,
          useFactory: (bus: EventBus) =>
            new SseService(bus, { maxClients: config.sseMaxClients, maxClientsPerIp: config.sseMaxClientsPerIp }),
          inject: [EventBus],
        },
        {
          provide: IngestService,
          useFactory: (prisma: PrismaService, bus: EventBus) =>
            new IngestService({ store: new PrismaIngestStore(prisma.client), bus, logger }),
          inject: [PrismaService, EventBus],
        },
        {
          provide: IngestRunner,
          useFactory: (prisma: PrismaService, ingest: IngestService) => new IngestRunner(config, ingest, prisma, logger),
          inject: [PrismaService, IngestService],
        },
        { provide: PrismaHuntStore, useFactory: (prisma: PrismaService) => new PrismaHuntStore(prisma.client), inject: [PrismaService] },
        {
          provide: HuntRunner,
          useFactory: (store: PrismaHuntStore, bus: EventBus, ingest: IngestService) => {
            const runner = new HuntRunner({
              config: huntConfig,
              store,
              bus,
              workdir: overrides.workdir ?? new HuntWorkdir(huntConfig.workdir),
              lab: overrides.lab ?? new HttpLabClient(huntConfig.labUrl, huntConfig.labReadToken ?? ''),
              logger,
              prometheus: { url: config.prometheusUrl, allowRemote: config.prometheusAllowRemote },
              spawn: overrides.spawn,
              now: overrides.now,
              mcpBinDir: overrides.mcpBinDir,
              parentEnv: overrides.parentEnv,
              ledgerPollMs: overrides.ledgerPollMs,
            });
            ingest.setHuntLookup((name) => runner.latest(name));
            return runner;
          },
          inject: [PrismaHuntStore, EventBus, IngestService],
        },
        { provide: PrismaProposalStore, useFactory: (prisma: PrismaService) => new PrismaProposalStore(prisma.client), inject: [PrismaService] },
        {
          provide: GitClient,
          useFactory: () =>
            new GitClient({
              gitPath: fixConfig.gitPath,
              repo: fixConfig.repo ?? 'owner/name',
              token: fixConfig.githubToken,
              home: fixConfig.workdir,
              remoteUrl: fixOverrides.gitRemoteUrl,
              allowFileProtocol: fixOverrides.allowFileProtocol,
            }),
        },
        {
          provide: GithubClient,
          useFactory: () => new GithubClient({ token: fixConfig.githubToken ?? '', repo: fixConfig.repo ?? 'owner/name', baseUrl: fixOverrides.githubBaseUrl }),
        },
        {
          provide: ProposalRunner,
          useFactory: (store: PrismaProposalStore, hunts: PrismaHuntStore, bus: EventBus, ingest: IngestService, huntRunner: HuntRunner, git: GitClient, github: GithubClient) => {
            const reader = overrides.lab ?? new HttpLabClient(huntConfig.labUrl, huntConfig.labReadToken ?? '');
            const runner = new ProposalRunner({
              config: fixConfig,
              huntConfig,
              proposals: store,
              hunts,
              lab: new HttpFixLab(reader, new HttpChaosClient(fixConfig.chaosUrl, fixConfig.chaosToken ?? '')),
              github,
              git,
              workdir: new FixerWorkdir(fixConfig.workdir),
              bus,
              logger,
              huntsEnabled: () => huntRunner.isEnabled,
              parentEnv: overrides.parentEnv,
              ...fixOverrides,
            });
            ingest.setProposalLookup((name) => runner.latest(name));
            return runner;
          },
          inject: [PrismaProposalStore, PrismaHuntStore, EventBus, IngestService, HuntRunner, GitClient, GithubClient],
        },
        {
          provide: ServicesService,
          useFactory: (prisma: PrismaService, ingest: IngestService, hunts: PrismaHuntStore, proposals: PrismaProposalStore) => new ServicesService(prisma, ingest, hunts, proposals),
          inject: [PrismaService, IngestService, PrismaHuntStore, PrismaProposalStore],
        },
      ],
      exports: [APP_CONFIG, JsonLogger, EventBus, PrismaService, IngestService, IngestRunner, PrismaHuntStore, HuntRunner, PrismaProposalStore, ProposalRunner, GitClient, GithubClient],
    };
  }
}
