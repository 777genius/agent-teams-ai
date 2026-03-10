import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { withFileLock } from './fileLock';

import type { CrossTeamMessage } from '@shared/types';

const CROSS_TEAM_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

function normalizeForDedupe(value: string | undefined): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function buildCrossTeamDedupeKey(message: CrossTeamMessage): string {
  return [
    normalizeForDedupe(message.fromTeam),
    normalizeForDedupe(message.fromMember),
    normalizeForDedupe(message.toTeam),
    normalizeForDedupe(message.summary),
    normalizeForDedupe(message.text),
  ].join('||');
}

function findRecentDuplicate(
  list: CrossTeamMessage[],
  message: CrossTeamMessage,
  windowMs: number
): CrossTeamMessage | null {
  const dedupeKey = buildCrossTeamDedupeKey(message);
  const cutoff = Date.now() - windowMs;

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const entry = list[i];
    const ts = Date.parse(entry.timestamp);
    if (!Number.isFinite(ts) || ts < cutoff) {
      break;
    }
    if (buildCrossTeamDedupeKey(entry) === dedupeKey) {
      return entry;
    }
  }

  return null;
}

export class CrossTeamOutbox {
  private getOutboxPath(teamName: string): string {
    return path.join(getTeamsBasePath(), teamName, 'sent-cross-team.json');
  }

  private async readUnlocked(outboxPath: string): Promise<CrossTeamMessage[]> {
    try {
      const raw = await fs.promises.readFile(outboxPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as CrossTeamMessage[]) : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  async append(teamName: string, message: CrossTeamMessage): Promise<void> {
    const outboxPath = this.getOutboxPath(teamName);
    await withFileLock(outboxPath, async () => {
      const list = await this.readUnlocked(outboxPath);
      list.push(message);
      const dir = path.dirname(outboxPath);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(outboxPath, JSON.stringify(list, null, 2), 'utf8');
    });
  }

  async appendIfNotRecent(
    teamName: string,
    message: CrossTeamMessage,
    onBeforeAppend: () => Promise<void>,
    windowMs = CROSS_TEAM_DEDUPE_WINDOW_MS
  ): Promise<{ duplicate: CrossTeamMessage | null }> {
    const outboxPath = this.getOutboxPath(teamName);
    let duplicate: CrossTeamMessage | null = null;

    await withFileLock(outboxPath, async () => {
      const list = await this.readUnlocked(outboxPath);
      duplicate = findRecentDuplicate(list, message, windowMs);
      if (duplicate) return;

      await onBeforeAppend();

      list.push(message);
      const dir = path.dirname(outboxPath);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(outboxPath, JSON.stringify(list, null, 2), 'utf8');
    });

    return { duplicate };
  }

  async read(teamName: string): Promise<CrossTeamMessage[]> {
    const outboxPath = this.getOutboxPath(teamName);
    return this.readUnlocked(outboxPath);
  }
}
