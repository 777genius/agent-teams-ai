import { readFile } from 'fs/promises';
import { join } from 'path';

import type { MemberWorkSyncWatchdogCooldownPort } from '../../../core/application';

const DEFAULT_WATCHDOG_COOLDOWN_MS = 10 * 60_000;

interface StallJournalEntry {
  taskId: string;
  memberName?: string;
  state: string;
  alertedAt?: string;
}

interface WatchdogCooldownResult {
  active: boolean;
  retryAfterIso?: string;
}

function parseTime(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function normalizeMemberName(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

export class TeamTaskStallJournalWorkSyncCooldown implements MemberWorkSyncWatchdogCooldownPort {
  constructor(
    private readonly teamsBasePath: string,
    private readonly cooldownMs: number = DEFAULT_WATCHDOG_COOLDOWN_MS
  ) {}

  async hasRecentNudge(input: {
    teamName: string;
    memberName: string;
    taskIds: string[];
    nowIso: string;
  }): Promise<boolean> {
    return (await this.getRecentNudgeCooldown(input)).active;
  }

  async getRecentNudgeCooldown(input: {
    teamName: string;
    memberName: string;
    taskIds: string[];
    nowIso: string;
  }): Promise<WatchdogCooldownResult> {
    const taskIds = new Set(input.taskIds);
    if (taskIds.size === 0) {
      return { active: false };
    }

    try {
      const raw = await readFile(
        join(this.teamsBasePath, input.teamName, 'stall-monitor-journal.json'),
        'utf8'
      );
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return { active: false };
      }
      const now = parseTime(input.nowIso) ?? Date.now();
      const expectedMemberName = normalizeMemberName(input.memberName);
      let retryAfterMs: number | null = null;
      for (const entry of parsed) {
        const row = entry as Partial<StallJournalEntry>;
        if (row.state !== 'alerted' || !row.taskId || !taskIds.has(row.taskId)) {
          continue;
        }
        const rowMemberName = normalizeMemberName(row.memberName);
        if (rowMemberName && rowMemberName !== expectedMemberName) {
          continue;
        }
        const alertedAt = parseTime(row.alertedAt);
        if (alertedAt == null || alertedAt > now || now - alertedAt >= this.cooldownMs) {
          continue;
        }
        const entryRetryAfterMs = alertedAt + this.cooldownMs;
        retryAfterMs =
          retryAfterMs == null ? entryRetryAfterMs : Math.max(retryAfterMs, entryRetryAfterMs);
      }
      if (retryAfterMs == null) {
        return { active: false };
      }
      return { active: true, retryAfterIso: new Date(retryAfterMs).toISOString() };
    } catch {
      return { active: false };
    }
  }
}
