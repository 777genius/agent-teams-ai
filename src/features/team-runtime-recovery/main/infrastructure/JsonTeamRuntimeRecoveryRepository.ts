import { withFileLock } from '@main/services/team/fileLock';
import { atomicWriteAsync, renamePathWithRetry } from '@main/utils/atomicWrite';
import { mkdir, readdir, readFile } from 'fs/promises';
import { dirname } from 'path';

import type {
  RuntimeRecoveryRepositoryPort,
  RuntimeRecoveryTeamState,
} from '../../core/application';
import type { TeamRuntimeRecoveryStorePaths } from './TeamRuntimeRecoveryStorePaths';

function emptyState(teamName: string, nowIso: string): RuntimeRecoveryTeamState {
  return {
    schemaVersion: 1,
    teamName,
    jobs: [],
    circuits: [],
    processedSignalIds: [],
    updatedAt: nowIso,
  };
}

const JOB_STATUSES = new Set([
  'pending',
  'claimed',
  'awaiting_outcome',
  'completed',
  'superseded',
  'failed_retryable',
  'failed_terminal',
  'outcome_unknown',
  'cancelled',
]);
const CIRCUIT_STATUSES = new Set(['open', 'half_open', 'closed']);
const SIGNAL_SOURCES = new Set([
  'lead_stream',
  'agent_error_mailbox',
  'member_runtime_advisory',
  'legacy_message_scan',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isOptionalString(value: unknown): boolean {
  return value == null || typeof value === 'string';
}

function isRuntimeFailureSignal(value: unknown, teamName: string): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    SIGNAL_SOURCES.has(String(value.source)) &&
    (value.phase === 'sdk_retrying' || value.phase === 'terminal') &&
    isDateString(value.observedAt) &&
    isNonEmptyString(value.contextId) &&
    value.teamName === teamName &&
    isNonEmptyString(value.memberName) &&
    (value.targetKind === 'lead' || value.targetKind === 'member') &&
    typeof value.detail === 'string' &&
    value.detail.length <= 8_192 &&
    isOptionalString(value.runId) &&
    isOptionalString(value.runtimeSessionId) &&
    isOptionalString(value.providerId) &&
    isOptionalString(value.providerBackendId) &&
    isOptionalString(value.model) &&
    isOptionalString(value.sourceMessageId) &&
    isOptionalString(value.failedMessageId) &&
    isOptionalString(value.causedByRecoveryMessageId) &&
    (value.statusCode == null ||
      (typeof value.statusCode === 'number' &&
        Number.isInteger(value.statusCode) &&
        value.statusCode >= 100 &&
        value.statusCode <= 599)) &&
    (value.retryAfterMs == null ||
      (typeof value.retryAfterMs === 'number' &&
        Number.isFinite(value.retryAfterMs) &&
        value.retryAfterMs >= 0)) &&
    isOptionalString(value.resetAt) &&
    (value.innerRecoveryAttempts == null ||
      (typeof value.innerRecoveryAttempts === 'number' &&
        Number.isInteger(value.innerRecoveryAttempts) &&
        value.innerRecoveryAttempts >= 0)) &&
    (value.taskRefs == null ||
      (Array.isArray(value.taskRefs) &&
        value.taskRefs.every(
          (taskRef) =>
            isRecord(taskRef) &&
            isNonEmptyString(taskRef.taskId) &&
            isOptionalString(taskRef.displayId) &&
            isOptionalString(taskRef.teamName)
        )))
  );
}

function isRuntimeRecoveryJob(value: unknown, teamName: string): boolean {
  if (!isRecord(value)) return false;
  const status = typeof value.status === 'string' ? value.status : '';
  return (
    isNonEmptyString(value.id) &&
    JOB_STATUSES.has(status) &&
    isRuntimeFailureSignal(value.signal, teamName) &&
    isNonEmptyString(value.reasonCode) &&
    isNonEmptyString(value.normalizedDetailHash) &&
    isNonEmptyString(value.circuitKey) &&
    typeof value.attempt === 'number' &&
    Number.isInteger(value.attempt) &&
    value.attempt >= 0 &&
    value.attempt <= 5 &&
    isDateString(value.nextAttemptAt) &&
    isDateString(value.expiresAt) &&
    isDateString(value.createdAt) &&
    isDateString(value.updatedAt) &&
    isOptionalString(value.claimedBy) &&
    (value.claimedAt == null || isDateString(value.claimedAt)) &&
    isOptionalString(value.recoveryMessageId) &&
    isOptionalString(value.lastError) &&
    (value.outcomeDeadlineAt == null || isDateString(value.outcomeDeadlineAt)) &&
    (status !== 'claimed' ||
      (isNonEmptyString(value.claimedBy) && isDateString(value.claimedAt))) &&
    (status !== 'awaiting_outcome' ||
      (isNonEmptyString(value.recoveryMessageId) && isDateString(value.outcomeDeadlineAt)))
  );
}

function isRuntimeRecoveryCircuit(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.key) &&
    CIRCUIT_STATUSES.has(String(value.status)) &&
    typeof value.consecutiveFailures === 'number' &&
    Number.isInteger(value.consecutiveFailures) &&
    value.consecutiveFailures >= 0 &&
    isDateString(value.nextProbeAt) &&
    isOptionalString(value.activeProbeJobId) &&
    isDateString(value.updatedAt)
  );
}

function isRuntimeRecoveryTeamState(value: unknown): value is RuntimeRecoveryTeamState {
  if (!isRecord(value)) return false;
  const row = value as Partial<RuntimeRecoveryTeamState>;
  return (
    row.schemaVersion === 1 &&
    isNonEmptyString(row.teamName) &&
    Array.isArray(row.jobs) &&
    row.jobs.every((job) => isRuntimeRecoveryJob(job, row.teamName!)) &&
    Array.isArray(row.circuits) &&
    row.circuits.every(isRuntimeRecoveryCircuit) &&
    Array.isArray(row.processedSignalIds) &&
    row.processedSignalIds.every(isNonEmptyString) &&
    isDateString(row.updatedAt)
  );
}

async function quarantine(filePath: string): Promise<void> {
  await renamePathWithRetry(filePath, `${filePath}.invalid.${Date.now()}`).catch(() => undefined);
}

export class JsonTeamRuntimeRecoveryRepository implements RuntimeRecoveryRepositoryPort {
  constructor(
    private readonly paths: TeamRuntimeRecoveryStorePaths,
    private readonly now: () => Date = () => new Date()
  ) {}

  async read(teamName: string): Promise<RuntimeRecoveryTeamState> {
    return this.readUnlocked(teamName, true);
  }

  async update<T>(
    teamName: string,
    updater: (state: RuntimeRecoveryTeamState) => {
      state: RuntimeRecoveryTeamState;
      result: T;
    }
  ): Promise<T> {
    const statePath = this.paths.getStatePath(teamName);
    return withFileLock(statePath, async () => {
      const current = await this.readUnlocked(teamName, true);
      const updated = updater(structuredClone(current));
      const nextState: RuntimeRecoveryTeamState = {
        ...updated.state,
        schemaVersion: 1,
        teamName,
      };
      if (!isRuntimeRecoveryTeamState(nextState)) {
        throw new Error(`Invalid runtime recovery state for team "${teamName}"`);
      }
      await mkdir(dirname(statePath), { recursive: true });
      await atomicWriteAsync(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
      return updated.result;
    });
  }

  async listTeamNames(): Promise<string[]> {
    const entries = await readdir(this.paths.getTeamsBasePath(), { withFileTypes: true }).catch(
      () => []
    );
    const teamNames: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await readFile(this.paths.getStatePath(entry.name), 'utf8');
        teamNames.push(entry.name);
      } catch {
        // No recovery state for this team.
      }
    }
    return teamNames.sort();
  }

  private async readUnlocked(
    teamName: string,
    quarantineInvalid: boolean
  ): Promise<RuntimeRecoveryTeamState> {
    const statePath = this.paths.getStatePath(teamName);
    try {
      const parsed: unknown = JSON.parse(await readFile(statePath, 'utf8'));
      if (isRuntimeRecoveryTeamState(parsed) && parsed.teamName === teamName) {
        return parsed;
      }
      if (quarantineInvalid) await quarantine(statePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && quarantineInvalid) {
        await quarantine(statePath);
      }
    }
    return emptyState(teamName, this.now().toISOString());
  }
}
