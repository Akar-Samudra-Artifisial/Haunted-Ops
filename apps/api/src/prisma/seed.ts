import { SERVICE_NAMES, type RoomPosition, type ServiceName } from '@haunted-ops/shared';
import type { PrismaClient } from './client.js';

/** Fixed room positions (grid cells) for the four lab services. */
export const SERVICE_ROOMS: Readonly<Record<ServiceName, RoomPosition>> = Object.freeze({
  gate: { x: 0, y: 0 },
  orders: { x: 1, y: 0 },
  payments: { x: 0, y: 1 },
  ledger: { x: 1, y: 1 },
});

/**
 * Upserts the four services by name. On update only the room position is set,
 * so running the seed again never resets a haunt level.
 */
export async function seedServices(prisma: PrismaClient): Promise<void> {
  for (const name of SERVICE_NAMES) {
    const room = SERVICE_ROOMS[name];
    await prisma.service.upsert({
      where: { name },
      create: { name, roomX: room.x, roomY: room.y },
      update: { roomX: room.x, roomY: room.y },
    });
  }
}
