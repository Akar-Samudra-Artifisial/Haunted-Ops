import { Controller, Get, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { SseService, type SseRequest } from './sse.service.js';

@Controller('api')
export class SseController {
  constructor(private readonly sse: SseService) {}

  /** GET /api/events: SSE stream with Last-Event-ID (or ?lastEventId=) resume. */
  @Get('events')
  events(@Req() req: SseRequest, @Res() res: ServerResponse): void {
    this.sse.open(req, res);
  }
}
