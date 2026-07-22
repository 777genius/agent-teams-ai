import { appendMemberWorkSyncAudit } from './MemberWorkSyncAudit';

import type { RuntimeTurnSettledEvent } from '../domain';
import type {
  MemberWorkSyncAuditJournalPort,
  MemberWorkSyncClockPort,
  MemberWorkSyncLoggerPort,
} from './ports';
import type {
  RuntimeTurnSettledEventStorePort,
  RuntimeTurnSettledPayloadNormalizerPort,
  RuntimeTurnSettledReconcileQueuePort,
  RuntimeTurnSettledTargetResolverPort,
} from './RuntimeTurnSettledPorts';

export interface RuntimeTurnSettledIngestorDeps {
  eventStore: RuntimeTurnSettledEventStorePort;
  normalizer: RuntimeTurnSettledPayloadNormalizerPort;
  targetResolver: RuntimeTurnSettledTargetResolverPort;
  reconcileQueue: RuntimeTurnSettledReconcileQueuePort;
  clock: MemberWorkSyncClockPort;
  auditJournal?: MemberWorkSyncAuditJournalPort;
  logger?: MemberWorkSyncLoggerPort;
}

export interface RuntimeTurnSettledDrainSummary {
  claimed: number;
  enqueued: number;
  unresolved: number;
  ignored: number;
  invalid: number;
  failed: number;
}

const NON_TERMINAL_OPENCODE_OUTCOMES = new Set([
  'timeout',
  'stream_unavailable',
  'prompt_rejected',
  'idle_without_assistant_activity',
  'unknown',
]);

function getIgnoredReason(event: RuntimeTurnSettledEvent): string | null {
  if (event.provider !== 'opencode') {
    return null;
  }
  if (event.threadId?.trim()) {
    return null;
  }
  const outcome = event.outcome?.trim();
  if (!outcome || !NON_TERMINAL_OPENCODE_OUTCOMES.has(outcome)) {
    return 'opencode_missing_prompt_identity';
  }
  return `opencode_non_terminal_outcome:${outcome}`;
}

export class RuntimeTurnSettledIngestor {
  constructor(private readonly deps: RuntimeTurnSettledIngestorDeps) {}

  async drainPending(limit: number = 50): Promise<RuntimeTurnSettledDrainSummary> {
    const summary: RuntimeTurnSettledDrainSummary = {
      claimed: 0,
      enqueued: 0,
      unresolved: 0,
      ignored: 0,
      invalid: 0,
      failed: 0,
    };

    const payloads = await this.deps.eventStore.claimPending(limit);
    summary.claimed = payloads.length;

    for (const payload of payloads) {
      const processedAt = this.deps.clock.now().toISOString();
      try {
        const normalized = this.deps.normalizer.normalize({
          provider: payload.provider,
          raw: payload.raw,
          recordedAt: payload.claimedAt,
        });

        if (!normalized.ok) {
          summary.invalid += 1;
          await this.deps.eventStore.markInvalid(payload, {
            reason: normalized.reason,
            processedAt,
          });
          continue;
        }

        if (normalized.event.teamName && normalized.event.memberName) {
          await appendMemberWorkSyncAudit(this.deps, {
            teamName: normalized.event.teamName,
            memberName: normalized.event.memberName,
            event: 'turn_settled_claimed',
            source: 'runtime_turn_settled_ingestor',
            reason: normalized.event.provider,
            metadata: {
              sourceId: normalized.event.sourceId,
              provider: normalized.event.provider,
            },
          });
        }

        const ignoredReason = getIgnoredReason(normalized.event);
        if (ignoredReason) {
          summary.ignored += 1;
          await this.deps.eventStore.markProcessed(payload, {
            event: normalized.event,
            outcome: 'ignored',
            reason: ignoredReason,
            processedAt,
          });
          if (normalized.event.teamName && normalized.event.memberName) {
            await appendMemberWorkSyncAudit(this.deps, {
              teamName: normalized.event.teamName,
              memberName: normalized.event.memberName,
              event: 'turn_settled_ignored',
              source: 'runtime_turn_settled_ingestor',
              reason: ignoredReason,
              metadata: {
                sourceId: normalized.event.sourceId,
                provider: normalized.event.provider,
              },
            });
          }
          continue;
        }

        const resolution = await this.deps.targetResolver.resolve(normalized.event);
        if (!resolution.ok) {
          summary.unresolved += 1;
          await this.deps.eventStore.markProcessed(payload, {
            event: normalized.event,
            outcome: 'unresolved',
            reason: resolution.reason,
            processedAt,
          });
          if (normalized.event.teamName && normalized.event.memberName) {
            await appendMemberWorkSyncAudit(this.deps, {
              teamName: normalized.event.teamName,
              memberName: normalized.event.memberName,
              event: 'turn_settled_unresolved',
              source: 'runtime_turn_settled_ingestor',
              reason: resolution.reason,
              metadata: {
                sourceId: normalized.event.sourceId,
                provider: normalized.event.provider,
              },
            });
          }
          continue;
        }

        const accepted = this.deps.reconcileQueue.enqueueRuntimeTurnSettled({
          teamName: resolution.teamName,
          memberName: resolution.memberName,
          event: normalized.event,
        });
        if (!accepted) {
          summary.failed += 1;
          this.deps.logger?.warn('runtime turn settled reconcile enqueue rejected', {
            filePath: payload.filePath,
            provider: payload.provider,
            teamName: resolution.teamName,
            memberName: resolution.memberName,
          });
          continue;
        }
        summary.enqueued += 1;
        await this.deps.eventStore.markProcessed(payload, {
          event: normalized.event,
          teamName: resolution.teamName,
          memberName: resolution.memberName,
          outcome: 'enqueued',
          processedAt,
        });
        await appendMemberWorkSyncAudit(this.deps, {
          teamName: resolution.teamName,
          memberName: resolution.memberName,
          event: 'turn_settled_resolved',
          source: 'runtime_turn_settled_ingestor',
          reason: normalized.event.provider,
          metadata: {
            sourceId: normalized.event.sourceId,
            provider: normalized.event.provider,
          },
        });
      } catch (error) {
        summary.failed += 1;
        this.deps.logger?.warn('runtime turn settled ingest failed', {
          filePath: payload.filePath,
          provider: payload.provider,
          error: String(error),
        });
      }
    }

    return summary;
  }
}
