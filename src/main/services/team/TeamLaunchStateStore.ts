import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';
import { normalizePersistedLaunchSnapshot } from './TeamLaunchStateEvaluator';
import {
  createPersistedLaunchSummaryProjection,
  TEAM_LAUNCH_SUMMARY_FILE,
} from './TeamLaunchSummaryProjection';

import type { PersistedTeamLaunchSnapshot } from '@shared/types';

const logger = createLogger('Service:TeamLaunchStateStore');
const TEAM_LAUNCH_STATE_FILE = 'launch-state.json';
const MAX_LAUNCH_STATE_BYTES = 256 * 1024;
const publicationQueueByTeam = new Map<string, Promise<void>>();

type JsonRecord = Record<string, unknown>;

const LAUNCH_STATE_KNOWN_FIELDS = [
  'version',
  'teamName',
  'updatedAt',
  'leadSessionId',
  'launchPhase',
  'expectedMembers',
  'bootstrapExpectedMembers',
  'members',
  'summary',
  'teamLaunchState',
] as const;
const LAUNCH_MEMBER_KNOWN_FIELDS = [
  'name',
  'providerId',
  'providerBackendId',
  'billingMode',
  'model',
  'effort',
  'cwd',
  'selectedFastMode',
  'resolvedFastMode',
  'laneId',
  'laneKind',
  'laneOwnerProviderId',
  'launchIdentity',
  'launchState',
  'skippedForLaunch',
  'skipReason',
  'skippedAt',
  'agentToolAccepted',
  'runtimeAlive',
  'bootstrapConfirmed',
  'hardFailure',
  'hardFailureReason',
  'pendingPermissionRequestIds',
  'runtimePid',
  'runtimeRunId',
  'runtimeSessionId',
  'bootstrapEvidenceSource',
  'bootstrapMode',
  'appManagedBootstrapCandidate',
  'livenessKind',
  'pidSource',
  'runtimeDiagnostic',
  'runtimeDiagnosticSeverity',
  'bootstrapStalled',
  'runtimeLastSeenAt',
  'firstSpawnAcceptedAt',
  'lastHeartbeatAt',
  'lastRuntimeAliveAt',
  'lastEvaluatedAt',
  'sources',
  'diagnostics',
] as const;
const LAUNCH_MEMBER_SOURCE_KNOWN_FIELDS = [
  'inboxHeartbeat',
  'nativeHeartbeat',
  'processAlive',
  'configRegistered',
  'configDrift',
  'hardFailureSignal',
  'duplicateRespawnBlocked',
] as const;
const APP_BOOTSTRAP_CANDIDATE_KNOWN_FIELDS = [
  'schemaVersion',
  'source',
  'teamName',
  'memberName',
  'runId',
  'laneId',
  'runtimeSessionId',
  'messageID',
  'contextHash',
  'briefingHash',
  'injectionVerifiedAt',
  'candidateAt',
  'model',
  'agent',
] as const;
const LAUNCH_IDENTITY_KNOWN_FIELDS = [
  'providerId',
  'providerBackendId',
  'billingMode',
  'selectedModel',
  'selectedModelKind',
  'resolvedLaunchModel',
  'catalogId',
  'catalogSource',
  'catalogFetchedAt',
  'selectedEffort',
  'resolvedEffort',
  'selectedFastMode',
  'resolvedFastMode',
  'fastResolutionReason',
] as const;
const LAUNCH_SUMMARY_KNOWN_FIELDS = [
  'confirmedCount',
  'pendingCount',
  'failedCount',
  'skippedCount',
  'runtimeAlivePendingCount',
  'shellOnlyPendingCount',
  'runtimeProcessPendingCount',
  'runtimeCandidatePendingCount',
  'noRuntimePendingCount',
  'permissionPendingCount',
] as const;
const LAUNCH_SUMMARY_PROJECTION_KNOWN_FIELDS = [
  'version',
  'teamName',
  'updatedAt',
  'launchPhase',
  'mixedAware',
  'partialLaunchFailure',
  'expectedMemberCount',
  'confirmedMemberCount',
  'missingMembers',
  'skippedMembers',
  'teamLaunchState',
  'launchUpdatedAt',
  ...LAUNCH_SUMMARY_KNOWN_FIELDS,
] as const;

function isJsonRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value);
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}

function isProviderId(value: unknown): boolean {
  return value === 'anthropic' || value === 'codex' || value === 'gemini' || value === 'opencode';
}

function isProviderBackendId(value: unknown): boolean {
  return (
    value === 'auto' ||
    value === 'adapter' ||
    value === 'api' ||
    value === 'cli-sdk' ||
    value === 'codex-native' ||
    value === 'opencode-cli'
  );
}

function isEffort(value: unknown): boolean {
  return (
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'ultra'
  );
}

function isFastMode(value: unknown): boolean {
  return value === 'inherit' || value === 'on' || value === 'off';
}

function isLaunchPhase(value: unknown): boolean {
  return value === 'active' || value === 'finished' || value === 'reconciled';
}

function isTeamLaunchState(value: unknown): boolean {
  return (
    value === 'partial_failure' ||
    value === 'partial_skipped' ||
    value === 'partial_pending' ||
    value === 'clean_success'
  );
}

function isLaunchIdentity(value: unknown): boolean {
  if (!isJsonRecord(value)) return false;
  return (
    isProviderId(value.providerId) &&
    (value.providerBackendId === null || isProviderBackendId(value.providerBackendId)) &&
    (value.billingMode === undefined ||
      value.billingMode === 'api' ||
      value.billingMode === 'subscription' ||
      value.billingMode === 'free' ||
      value.billingMode === 'unknown') &&
    (value.selectedModel === null || typeof value.selectedModel === 'string') &&
    (value.selectedModelKind === 'default' || value.selectedModelKind === 'explicit') &&
    (value.resolvedLaunchModel === null || typeof value.resolvedLaunchModel === 'string') &&
    (value.catalogId === null || typeof value.catalogId === 'string') &&
    (value.catalogSource === 'anthropic-models-api' ||
      value.catalogSource === 'anthropic-compatible-api' ||
      value.catalogSource === 'app-server' ||
      value.catalogSource === 'static-fallback' ||
      value.catalogSource === 'runtime' ||
      value.catalogSource === 'unavailable') &&
    (value.catalogFetchedAt === null || typeof value.catalogFetchedAt === 'string') &&
    (value.selectedEffort === null || isEffort(value.selectedEffort)) &&
    (value.resolvedEffort === null || isEffort(value.resolvedEffort)) &&
    (value.selectedFastMode === undefined ||
      value.selectedFastMode === null ||
      isFastMode(value.selectedFastMode)) &&
    (value.resolvedFastMode === undefined ||
      value.resolvedFastMode === null ||
      typeof value.resolvedFastMode === 'boolean') &&
    (value.fastResolutionReason === undefined ||
      value.fastResolutionReason === null ||
      typeof value.fastResolutionReason === 'string')
  );
}

function isAppManagedBootstrapCandidate(value: unknown): boolean {
  if (!isJsonRecord(value)) return false;
  return (
    value.schemaVersion === 1 &&
    value.source === 'app_managed_bootstrap' &&
    typeof value.teamName === 'string' &&
    typeof value.memberName === 'string' &&
    typeof value.runId === 'string' &&
    typeof value.laneId === 'string' &&
    typeof value.runtimeSessionId === 'string' &&
    typeof value.messageID === 'string' &&
    typeof value.contextHash === 'string' &&
    typeof value.briefingHash === 'string' &&
    typeof value.injectionVerifiedAt === 'string' &&
    typeof value.candidateAt === 'string' &&
    isOptionalString(value.model) &&
    isOptionalString(value.agent)
  );
}

function isLaunchMemberSources(value: unknown): boolean {
  if (!isJsonRecord(value)) return false;
  return LAUNCH_MEMBER_SOURCE_KNOWN_FIELDS.every((field) => isOptionalBoolean(value[field]));
}

function isLaunchMember(value: unknown): boolean {
  if (!isJsonRecord(value)) return false;
  return (
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    (value.providerId === undefined || isProviderId(value.providerId)) &&
    (value.providerBackendId === undefined || isProviderBackendId(value.providerBackendId)) &&
    (value.billingMode === undefined ||
      value.billingMode === 'api' ||
      value.billingMode === 'subscription' ||
      value.billingMode === 'free' ||
      value.billingMode === 'unknown') &&
    isOptionalString(value.model) &&
    (value.effort === undefined || isEffort(value.effort)) &&
    isOptionalString(value.cwd) &&
    (value.selectedFastMode === undefined || isFastMode(value.selectedFastMode)) &&
    isOptionalBoolean(value.resolvedFastMode) &&
    isOptionalString(value.laneId) &&
    (value.laneKind === undefined ||
      value.laneKind === 'primary' ||
      value.laneKind === 'secondary') &&
    (value.laneOwnerProviderId === undefined || isProviderId(value.laneOwnerProviderId)) &&
    (value.launchIdentity === undefined || isLaunchIdentity(value.launchIdentity)) &&
    (value.launchState === 'starting' ||
      value.launchState === 'runtime_pending_bootstrap' ||
      value.launchState === 'runtime_pending_permission' ||
      value.launchState === 'confirmed_alive' ||
      value.launchState === 'failed_to_start' ||
      value.launchState === 'skipped_for_launch') &&
    isOptionalBoolean(value.skippedForLaunch) &&
    isOptionalString(value.skipReason) &&
    isOptionalString(value.skippedAt) &&
    typeof value.agentToolAccepted === 'boolean' &&
    typeof value.runtimeAlive === 'boolean' &&
    typeof value.bootstrapConfirmed === 'boolean' &&
    typeof value.hardFailure === 'boolean' &&
    isOptionalString(value.hardFailureReason) &&
    isOptionalStringArray(value.pendingPermissionRequestIds) &&
    isOptionalNonNegativeInteger(value.runtimePid) &&
    isOptionalString(value.runtimeRunId) &&
    isOptionalString(value.runtimeSessionId) &&
    (value.bootstrapEvidenceSource === undefined ||
      value.bootstrapEvidenceSource === 'runtime_bootstrap_checkin' ||
      value.bootstrapEvidenceSource === 'app_managed_bootstrap') &&
    (value.bootstrapMode === undefined ||
      value.bootstrapMode === 'model_tool_checkin' ||
      value.bootstrapMode === 'app_managed_context') &&
    (value.appManagedBootstrapCandidate === undefined ||
      isAppManagedBootstrapCandidate(value.appManagedBootstrapCandidate)) &&
    (value.livenessKind === undefined ||
      value.livenessKind === 'confirmed_bootstrap' ||
      value.livenessKind === 'runtime_process' ||
      value.livenessKind === 'runtime_process_candidate' ||
      value.livenessKind === 'permission_blocked' ||
      value.livenessKind === 'shell_only' ||
      value.livenessKind === 'registered_only' ||
      value.livenessKind === 'stale_metadata' ||
      value.livenessKind === 'not_found') &&
    (value.pidSource === undefined ||
      value.pidSource === 'lead_process' ||
      value.pidSource === 'tmux_pane' ||
      value.pidSource === 'tmux_child' ||
      value.pidSource === 'agent_process_table' ||
      value.pidSource === 'opencode_bridge' ||
      value.pidSource === 'runtime_bootstrap' ||
      value.pidSource === 'persisted_metadata') &&
    isOptionalString(value.runtimeDiagnostic) &&
    (value.runtimeDiagnosticSeverity === undefined ||
      value.runtimeDiagnosticSeverity === 'info' ||
      value.runtimeDiagnosticSeverity === 'warning' ||
      value.runtimeDiagnosticSeverity === 'error') &&
    isOptionalBoolean(value.bootstrapStalled) &&
    isOptionalString(value.runtimeLastSeenAt) &&
    isOptionalString(value.firstSpawnAcceptedAt) &&
    isOptionalString(value.lastHeartbeatAt) &&
    isOptionalString(value.lastRuntimeAliveAt) &&
    typeof value.lastEvaluatedAt === 'string' &&
    value.lastEvaluatedAt.trim().length > 0 &&
    (value.sources === undefined || isLaunchMemberSources(value.sources)) &&
    isOptionalStringArray(value.diagnostics)
  );
}

function isLaunchSummary(value: unknown): boolean {
  if (!isJsonRecord(value)) return false;
  return (
    isNonNegativeInteger(value.confirmedCount) &&
    isNonNegativeInteger(value.pendingCount) &&
    isNonNegativeInteger(value.failedCount) &&
    isOptionalNonNegativeInteger(value.skippedCount) &&
    isNonNegativeInteger(value.runtimeAlivePendingCount) &&
    isOptionalNonNegativeInteger(value.shellOnlyPendingCount) &&
    isOptionalNonNegativeInteger(value.runtimeProcessPendingCount) &&
    isOptionalNonNegativeInteger(value.runtimeCandidatePendingCount) &&
    isOptionalNonNegativeInteger(value.noRuntimePendingCount) &&
    isOptionalNonNegativeInteger(value.permissionPendingCount)
  );
}

function replaceKnownFields(
  existing: JsonRecord | null,
  replacement: JsonRecord,
  knownFields: readonly string[]
): JsonRecord {
  const merged = { ...(existing ?? {}) };
  for (const field of knownFields) {
    delete merged[field];
  }
  return Object.assign(merged, replacement);
}

function mergeNestedKnownRecord(
  existing: JsonRecord | null,
  replacement: JsonRecord,
  field: string,
  knownFields: readonly string[]
): void {
  if (isJsonRecord(replacement[field])) {
    replacement[field] = replaceKnownFields(
      isJsonRecord(existing?.[field]) ? existing[field] : null,
      replacement[field],
      knownFields
    );
  }
}

function mergeLaunchMember(existing: JsonRecord | null, replacement: JsonRecord): JsonRecord {
  const merged = replaceKnownFields(existing, replacement, LAUNCH_MEMBER_KNOWN_FIELDS);
  mergeNestedKnownRecord(existing, merged, 'sources', LAUNCH_MEMBER_SOURCE_KNOWN_FIELDS);
  mergeNestedKnownRecord(existing, merged, 'launchIdentity', LAUNCH_IDENTITY_KNOWN_FIELDS);
  mergeNestedKnownRecord(
    existing,
    merged,
    'appManagedBootstrapCandidate',
    APP_BOOTSTRAP_CANDIDATE_KNOWN_FIELDS
  );
  return merged;
}

function mergeLaunchState(
  existing: JsonRecord | null,
  snapshot: PersistedTeamLaunchSnapshot
): JsonRecord {
  const replacement = { ...(snapshot as unknown as JsonRecord) };
  const existingMembers = isJsonRecord(existing?.members) ? existing.members : {};
  const replacementMembers = isJsonRecord(replacement.members) ? replacement.members : {};
  replacement.members = Object.fromEntries(
    Object.entries(replacementMembers).map(([name, member]) => [
      name,
      mergeLaunchMember(
        isJsonRecord(existingMembers[name]) ? existingMembers[name] : null,
        member as JsonRecord
      ),
    ])
  );
  mergeNestedKnownRecord(existing, replacement, 'summary', LAUNCH_SUMMARY_KNOWN_FIELDS);
  return replaceKnownFields(existing, replacement, LAUNCH_STATE_KNOWN_FIELDS);
}

function isSupportedLaunchStateDocument(teamName: string, document: JsonRecord): boolean {
  if (
    document.teamName !== teamName ||
    typeof document.updatedAt !== 'string' ||
    document.updatedAt.trim().length === 0 ||
    !isOptionalString(document.leadSessionId) ||
    !isLaunchPhase(document.launchPhase) ||
    !isStringArray(document.expectedMembers) ||
    document.expectedMembers.some((member) => !member.trim()) ||
    !isOptionalStringArray(document.bootstrapExpectedMembers) ||
    (Array.isArray(document.bootstrapExpectedMembers) &&
      document.bootstrapExpectedMembers.some((member) => !member.trim())) ||
    !isJsonRecord(document.members) ||
    !isLaunchSummary(document.summary) ||
    !isTeamLaunchState(document.teamLaunchState)
  ) {
    return false;
  }
  return Object.entries(document.members).every(
    ([memberName, member]) =>
      memberName.trim().length > 0 &&
      isLaunchMember(member) &&
      (member as JsonRecord).name === memberName
  );
}

function isSupportedLaunchSummaryDocument(teamName: string, document: JsonRecord): boolean {
  return (
    document.teamName === teamName &&
    typeof document.updatedAt === 'string' &&
    document.updatedAt.trim().length > 0 &&
    (document.launchPhase === undefined || isLaunchPhase(document.launchPhase)) &&
    (document.mixedAware === undefined || document.mixedAware === true) &&
    (document.partialLaunchFailure === undefined || document.partialLaunchFailure === true) &&
    isOptionalNonNegativeInteger(document.expectedMemberCount) &&
    isOptionalNonNegativeInteger(document.confirmedMemberCount) &&
    isOptionalStringArray(document.missingMembers) &&
    isOptionalStringArray(document.skippedMembers) &&
    (document.teamLaunchState === undefined || isTeamLaunchState(document.teamLaunchState)) &&
    isOptionalString(document.launchUpdatedAt) &&
    LAUNCH_SUMMARY_KNOWN_FIELDS.every((field) => isOptionalNonNegativeInteger(document[field]))
  );
}

async function readVersionedDocumentForMutation(
  filePath: string,
  expectedVersion: number
): Promise<JsonRecord | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (!stat.isFile() || stat.size > MAX_LAUNCH_STATE_BYTES) {
    throw new Error('Refusing to replace unsafe or oversized launch state');
  }
  const raw = await fs.promises.readFile(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error('Refusing to replace malformed launch state', { cause: error });
  }
  if (!isJsonRecord(parsed) || parsed.version !== expectedVersion) {
    throw new Error('Refusing to replace unsupported launch state');
  }
  return parsed;
}

export function getTeamLaunchStatePath(teamName: string): string {
  return path.join(getTeamsBasePath(), teamName, TEAM_LAUNCH_STATE_FILE);
}

export function getTeamLaunchSummaryPath(teamName: string): string {
  return path.join(getTeamsBasePath(), teamName, TEAM_LAUNCH_SUMMARY_FILE);
}

async function isMissingTeamDirectoryWriteRace(
  targetPath: string,
  error: unknown
): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== 'ENOENT' && code !== 'EINVAL') {
    return false;
  }
  const targetDir = path.dirname(targetPath);
  try {
    await fs.promises.access(targetDir);
    return false;
  } catch (accessError) {
    return (accessError as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function enqueuePublication(teamName: string, operation: () => Promise<void>): Promise<void> {
  const previous = publicationQueueByTeam.get(teamName);
  const queued = (previous ?? Promise.resolve()).catch(() => undefined).then(operation);
  publicationQueueByTeam.set(teamName, queued);
  return queued.finally(() => {
    if (publicationQueueByTeam.get(teamName) === queued) {
      publicationQueueByTeam.delete(teamName);
    }
  });
}

export class TeamLaunchStateStore {
  async read(teamName: string): Promise<PersistedTeamLaunchSnapshot | null> {
    const targetPath = getTeamLaunchStatePath(teamName);
    try {
      const stat = await fs.promises.stat(targetPath);
      if (!stat.isFile() || stat.size > MAX_LAUNCH_STATE_BYTES) {
        return null;
      }
      const raw = await fs.promises.readFile(targetPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (
          record.version === 2 &&
          (typeof record.teamName !== 'string' || record.teamName.trim() !== teamName)
        ) {
          return null;
        }
      }
      return normalizePersistedLaunchSnapshot(teamName, parsed);
    } catch {
      return null;
    }
  }

  async write(teamName: string, snapshot: PersistedTeamLaunchSnapshot): Promise<void> {
    await enqueuePublication(teamName, () => this.writeNow(teamName, snapshot));
  }

  private async writeNow(teamName: string, snapshot: PersistedTeamLaunchSnapshot): Promise<void> {
    const launchStatePath = getTeamLaunchStatePath(teamName);
    const launchSummaryPath = getTeamLaunchSummaryPath(teamName);
    try {
      const [existingState, existingSummary] = await Promise.all([
        readVersionedDocumentForMutation(launchStatePath, 2),
        readVersionedDocumentForMutation(launchSummaryPath, 1),
      ]);
      if (existingState && !isSupportedLaunchStateDocument(teamName, existingState)) {
        throw new Error('Refusing to replace malformed launch state');
      }
      if (existingSummary && !isSupportedLaunchSummaryDocument(teamName, existingSummary)) {
        throw new Error('Refusing to replace malformed launch summary');
      }
      const launchSummary = createPersistedLaunchSummaryProjection(snapshot);
      await atomicWriteAsync(
        launchStatePath,
        `${JSON.stringify(mergeLaunchState(existingState, snapshot), null, 2)}\n`
      );
      await atomicWriteAsync(
        launchSummaryPath,
        `${JSON.stringify(
          replaceKnownFields(
            existingSummary,
            launchSummary as unknown as JsonRecord,
            LAUNCH_SUMMARY_PROJECTION_KNOWN_FIELDS
          ),
          null,
          2
        )}\n`
      );
    } catch (error) {
      if (await isMissingTeamDirectoryWriteRace(launchStatePath, error)) {
        return;
      }
      logger.warn(
        `[${teamName}] Failed to persist launch-state: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      throw error;
    }
  }

  async clear(teamName: string): Promise<void> {
    await enqueuePublication(teamName, async () => {
      const results = await Promise.allSettled([
        fs.promises.rm(getTeamLaunchStatePath(teamName), { force: true }),
        fs.promises.rm(getTeamLaunchSummaryPath(teamName), { force: true }),
      ]);
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, `[${teamName}] Failed to clear launch-state publication`);
      }
    });
  }
}
