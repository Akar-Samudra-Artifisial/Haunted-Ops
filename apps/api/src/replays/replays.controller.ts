import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { REPLAY_ID_PATTERN, replayHash, replayListItem, validateReplayFile, type ReplayFile, type ReplayListItem } from '@haunted-ops/shared';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';
import { JsonLogger } from '../security/logger.js';
/** Replays change with a release, not by the minute. */
export const REPLAY_CACHE_CONTROL = 'public, max-age=300';
/**
 * The file of a row, or `null` when the row must not be served: the body no longer validates (this includes the hash of
 * its review), it is not reviewed, its id or duration differs from its columns, or the `sha256` of the row is not the hash
 * of the body (the row was changed by hand after the seed).
 */
function rowFile(row: { id: string; durationMs: number; sha256: string; body: unknown }): ReplayFile | null {
  const checked = validateReplayFile(row.body);
  if (!checked.ok || checked.value.id !== row.id || checked.value.review === null || checked.value.durationMs !== row.durationMs) return null;
  return replayHash(checked.value) === row.sha256 ? checked.value : null;
}
/**
 * Public and read-only: `GET` only (no POST route exists). The body of a row is validated again before it is sent, so
 * a row that was changed by hand or does not hold a reviewed file is never served, in the list or on its own.
 */
@Controller('api/replays')
export class ReplaysController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: JsonLogger,
  ) {}
  @Get()
  async list(@Res({ passthrough: true }) res: Response): Promise<ReplayListItem[]> {
    const rows = await this.prisma.client.replay.findMany({
      orderBy: [{ recordedOn: 'desc' }, { id: 'asc' }],
      select: { id: true, durationMs: true, sha256: true, body: true },
    });
    res.setHeader('Cache-Control', REPLAY_CACHE_CONTROL);
    const items: ReplayListItem[] = [];
    for (const row of rows) {
      const file = rowFile(row);
      if (file === null) {
        // A bad row is left out and the log names the id only: never the body or the paths.
        this.logger.log('error', 'replay row is not valid', { replayId: row.id });
        continue;
      }
      items.push(replayListItem(file));
    }
    return items;
  }
  @Get(':id')
  async get(@Param('id') id: string, @Res() res: Response): Promise<void> {
    if (!REPLAY_ID_PATTERN.test(id)) throw new NotFoundException();
    const row = await this.prisma.client.replay.findUnique({ where: { id } });
    if (row === null) throw new NotFoundException();
    const file = rowFile(row);
    if (file === null) {
      // No content, and the log names the id only: never the body or the paths of a bad row.
      this.logger.log('error', 'replay row is not valid', { replayId: row.id });
      res.status(500).end();
      return;
    }
    res.setHeader('Cache-Control', REPLAY_CACHE_CONTROL);
    res.json(file);
  }
}
