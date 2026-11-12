import { Module, type DynamicModule, type ModuleMetadata } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Config } from './config/config.js';
import { EventBus } from './events/event-bus.js';
import { SseController } from './events/sse.controller.js';
import { SseService } from './events/sse.service.js';
import { HealthController } from './health/health.controller.js';
import { PrismaService } from './prisma/prisma.service.js';
import { JsonLogger } from './security/logger.js';
import { RATE_LIMIT_WINDOW_MS, RateLimitGuard } from './security/rate-limit.guard.js';
import { ServicesController } from './services/services.controller.js';
import { ServicesService } from './services/services.service.js';
import { APP_CONFIG } from './tokens.js';

export interface AppModuleOptions {
  config: Config;
  logger: JsonLogger;
  /** Extra modules, used by tests to mount test-only routes. */
  imports?: ModuleMetadata['imports'];
}

@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    const { config, logger } = options;
    return {
      module: AppModule,
      global: true,
      imports: [
        ThrottlerModule.forRoot([{ name: 'default', ttl: RATE_LIMIT_WINDOW_MS, limit: config.rateLimitMax }]),
        ...(options.imports ?? []),
      ],
      controllers: [HealthController, ServicesController, SseController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
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
        { provide: ServicesService, useFactory: (prisma: PrismaService) => new ServicesService(prisma), inject: [PrismaService] },
      ],
      exports: [APP_CONFIG, JsonLogger, EventBus, PrismaService],
    };
  }
}
