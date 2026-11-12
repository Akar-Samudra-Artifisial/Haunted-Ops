import {
  SERVICE_NAMES,
  validateHauntLevel,
  validateServiceName,
  type ServiceName,
  type ServiceState,
} from '@haunted-ops/shared';
import type { PrismaService } from '../prisma/prisma.service.js';

export interface ServiceRow {
  name: string;
  roomX: number;
  roomY: number;
  hauntLevel: number;
  updatedAt: Date;
}

/** Maps database rows to Service state in the fixed room order. Unknown names are dropped. */
export function toServiceStates(rows: readonly ServiceRow[]): ServiceState[] {
  const order = (n: ServiceName): number => SERVICE_NAMES.indexOf(n);
  const out: ServiceState[] = [];
  for (const row of rows) {
    const name = validateServiceName(row.name);
    if (!name.ok) continue;
    const level = validateHauntLevel(row.hauntLevel);
    if (!level.ok) throw new Error('haunt level out of range in database');
    out.push({
      name: name.value,
      room: { x: row.roomX, y: row.roomY },
      hauntLevel: level.value,
      updatedAt: row.updatedAt.toISOString(),
    });
  }
  return out.sort((a, b) => order(a.name) - order(b.name));
}

export class ServicesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<ServiceState[]> {
    const rows = await this.prisma.client.service.findMany({
      select: { name: true, roomX: true, roomY: true, hauntLevel: true, updatedAt: true },
    });
    return toServiceStates(rows);
  }
}
