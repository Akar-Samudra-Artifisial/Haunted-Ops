import { Module } from '@nestjs/common';
import { ReplaysController } from './replays.controller.js';
/** `GET /api/replays` and `GET /api/replays/:id`. PrismaService and JsonLogger come from the global app module. */
@Module({ controllers: [ReplaysController] })
export class ReplaysModule {}
