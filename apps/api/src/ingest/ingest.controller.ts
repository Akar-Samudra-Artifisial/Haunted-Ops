import { Controller, Get, Header } from '@nestjs/common';
import type { IngestStatus } from '@haunted-ops/shared';
import { IngestService } from './ingest.service.js';

@Controller('api')
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  /** Reads memory only, so it answers even when the database is down. */
  @Get('ingest/status')
  @Header('Cache-Control', 'no-store')
  status(): IngestStatus {
    return this.ingest.status();
  }
}
