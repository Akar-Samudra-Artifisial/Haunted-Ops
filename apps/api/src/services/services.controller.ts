import { Controller, Get, Header } from '@nestjs/common';
import type { ServiceState } from '@haunted-ops/shared';
import { ServicesService } from './services.service.js';

@Controller('api')
export class ServicesController {
  constructor(private readonly services: ServicesService) {}

  @Get('services')
  @Header('Cache-Control', 'no-store')
  list(): Promise<ServiceState[]> {
    return this.services.list();
  }
}
