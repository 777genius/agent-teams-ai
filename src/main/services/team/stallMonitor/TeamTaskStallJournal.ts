import { getTeamTaskStallAlertCooldownMs } from './featureGates';
import { JsonTaskStallJournalStore } from './JsonTaskStallJournalStore';

import type { TaskStallJournalStore } from './TaskStallJournalStore';
import type { TaskStallEvaluation } from './TeamTaskStallTypes';

function parseTime(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export interface TeamTaskStallJournalOptions {
  alertCooldownMs?: number;
  /** Persistence backend. Defaults to the legacy per-team JSON file store. */
  store?: TaskStallJournalStore;
}

export class TeamTaskStallJournal {
  private readonly alertCooldownMs: number;
  private readonly store: TaskStallJournalStore;

  constructor(options: TeamTaskStallJournalOptions = {}) {
    this.alertCooldownMs =
      options.alertCooldownMs != null && options.alertCooldownMs > 0
        ? options.alertCooldownMs
        : getTeamTaskStallAlertCooldownMs();
    this.store = options.store ?? new JsonTaskStallJournalStore();
  }

  async reconcileScan(args: {
    teamName: string;
    evaluations: TaskStallEvaluation[];
    activeTaskIds: string[];
    scopeTaskIds?: string[];
    now: string;
  }): Promise<TaskStallEvaluation[]> {
    return this.store.update(args.teamName, (entries) => {
      const readyEvaluations: TaskStallEvaluation[] = [];
      const candidateByEpoch = new Map(
        args.evaluations
          .filter(
            (
              evaluation
            ): evaluation is TaskStallEvaluation &
              Required<Pick<TaskStallEvaluation, 'taskId' | 'branch' | 'signal' | 'epochKey'>> =>
              evaluation.status === 'alert' &&
              typeof evaluation.taskId === 'string' &&
              typeof evaluation.branch === 'string' &&
              typeof evaluation.signal === 'string' &&
              typeof evaluation.epochKey === 'string'
          )
          .map((evaluation) => [evaluation.epochKey, evaluation] as const)
      );

      const activeTaskIdSet = new Set(args.activeTaskIds);
      const scopeTaskIdSet = args.scopeTaskIds ? new Set(args.scopeTaskIds) : null;
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (scopeTaskIdSet && !scopeTaskIdSet.has(entry.taskId)) {
          continue;
        }
        if (!activeTaskIdSet.has(entry.taskId) || !candidateByEpoch.has(entry.epochKey)) {
          entries.splice(i, 1);
        }
      }

      for (const [epochKey, evaluation] of candidateByEpoch) {
        const existing = entries.find((entry) => entry.epochKey === epochKey);
        if (!existing) {
          entries.push({
            epochKey,
            teamName: args.teamName,
            taskId: evaluation.taskId,
            ...(evaluation.memberName ? { memberName: evaluation.memberName } : {}),
            branch: evaluation.branch,
            signal: evaluation.signal,
            state: 'suspected',
            consecutiveScans: 1,
            createdAt: args.now,
            updatedAt: args.now,
          });
          continue;
        }

        existing.updatedAt = args.now;
        if (evaluation.memberName) {
          existing.memberName = evaluation.memberName;
        }
        if (existing.state === 'alerted') {
          const nowMs = parseTime(args.now) ?? Date.now();
          const alertedAtMs = parseTime(existing.alertedAt);
          if (
            alertedAtMs != null &&
            alertedAtMs <= nowMs &&
            nowMs - alertedAtMs < this.alertCooldownMs
          ) {
            continue;
          }

          existing.state = 'alert_ready';
          existing.consecutiveScans += 1;
          readyEvaluations.push(evaluation);
          continue;
        }

        existing.consecutiveScans += 1;
        if (existing.consecutiveScans >= 2) {
          existing.state = 'alert_ready';
          readyEvaluations.push(evaluation);
        }
      }

      return { entries, result: readyEvaluations };
    });
  }

  async markAlerted(teamName: string, epochKey: string, now: string): Promise<void> {
    await this.store.update<void>(teamName, (entries) => {
      const target = entries.find((entry) => entry.epochKey === epochKey);
      if (!target) {
        return { entries, result: undefined, changed: false };
      }
      target.state = 'alerted';
      target.updatedAt = now;
      target.alertedAt = now;
      return { entries, result: undefined };
    });
  }
}
