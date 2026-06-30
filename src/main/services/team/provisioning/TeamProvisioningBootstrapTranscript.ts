import { encodePath, extractBaseDir, getProjectsBasePath } from '@main/utils/pathDecoder';
import { isPathWithinRoot, validateFileName } from '@main/utils/pathValidation';
import { hasUnsafeProvisionedButNotAliveRuntimeEvidence } from '@shared/utils/teamLaunchFailureReason';
import * as fs from 'fs';
import * as path from 'path';

import {
  parseBootstrapRuntimeProofDetail,
  validateBootstrapRuntimeProofEnvelope,
} from '../bootstrap/BootstrapProofValidation';
import {
  buildProcessBootstrapPendingDiagnostic,
  buildProcessBootstrapTimeoutDiagnostic,
  deriveProcessTransportProjectionPhase,
  type ProcessBootstrapTransportEvent,
  type ProcessBootstrapTransportSummary,
  sanitizeProcessRuntimeEventFilePrefix,
  summarizeProcessBootstrapTransportEvents,
} from '../ProcessBootstrapTransportEvidence';
import { createPersistedLaunchSnapshot } from '../TeamLaunchStateEvaluator';

import {
  deriveMemberLaunchState,
  isAutoClearableLaunchFailureReason,
  isNeverSpawnedDuringLaunchReason,
  isProvisionedButNotAliveFailureReason,
} from './TeamProvisioningLaunchFailurePolicy';
import {
  matchesMemberNameOrBase,
  matchesObservedMemberNameForExpected,
  matchesTeamMemberIdentity,
} from './TeamProvisioningMemberIdentity';
import { isPersistedOpenCodeSecondaryLaneMember } from './TeamProvisioningOpenCodeDiagnosticsPolicy';
import { isBootstrapMemberEvidenceCurrentForMember } from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';
import {
  extractBootstrapFailureReason,
  extractTranscriptMessageText,
  getBootstrapTranscriptSuccessSourceFromNormalized,
} from './TeamProvisioningPromptBuilders';

import type {
  InboxMessage,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchPhase,
  PersistedTeamLaunchSnapshot,
  TeamConfig,
} from '@shared/types';

export type BootstrapTranscriptSuccessSource = 'member_briefing' | 'assistant_text';

export const BOOTSTRAP_FAILURE_TAIL_BYTES = 128 * 1024;
export const BOOTSTRAP_TRANSCRIPT_MTIME_SLACK_MS = 5_000;
export const BOOTSTRAP_TRANSCRIPT_OUTCOME_CACHE_MAX_ENTRIES = 2_048;
export const PERSISTED_BOOTSTRAP_TRANSCRIPT_OUTCOME_LOOKUP_CACHE_TTL_MS = 10_000;
export const BOOTSTRAP_RUNTIME_PROOF_TAIL_BYTES = 256 * 1024;
export const BOOTSTRAP_RUNTIME_EVENT_MAX_LINES = 256;
export const BOOTSTRAP_RUNTIME_EVENT_MAX_LINE_BYTES = 16 * 1024;

export type BootstrapTranscriptOutcome =
  | {
      kind: 'success';
      observedAt: string;
      source: BootstrapTranscriptSuccessSource;
    }
  | {
      kind: 'failure';
      observedAt: string;
      reason: string;
    };

export interface BootstrapTranscriptOutcomeCacheEntry {
  mtimeMs: number;
  size: number;
  outcome: BootstrapTranscriptOutcome | null;
}

export interface BootstrapTranscriptOutcomeLookupCacheEntry {
  expiresAtMs: number;
  outcome: BootstrapTranscriptOutcome | null;
}

interface BootstrapTranscriptOutcomeCandidate {
  text: string;
  normalizedText: string;
  observedAt: string;
  parsedAgentName: string | null;
  parsedLine: ParsedBootstrapTranscriptTailLine;
}

export interface ParsedBootstrapTranscriptTailLine {
  rawTimestamp: string | null;
  timestampMs: number;
  text: string | null;
  normalizedText: string | null;
  parsedAgentName: string | null;
  bootstrapFailureReason?: string | null;
  bootstrapContextCandidateByTeam?: Map<string, boolean>;
  bootstrapContextMemberMatchByName?: Map<string, boolean>;
  bootstrapSuccessSourceByTeamMember?: Map<string, BootstrapTranscriptSuccessSource | null>;
}

export interface ParsedBootstrapTranscriptTailCacheEntry {
  mtimeMs: number;
  size: number;
  lines: ParsedBootstrapTranscriptTailLine[];
}

export type LeadInboxLaunchReconcileMessage = Pick<
  InboxMessage,
  'from' | 'text' | 'timestamp' | 'messageId'
>;

export interface BootstrapRuntimeMemberLike {
  name?: string;
  agentId?: string;
  tmuxPaneId?: string;
  backendType?: string;
  bootstrapExpectedAfter?: string;
  bootstrapProofToken?: string;
  bootstrapRunId?: string;
  bootstrapProofMode?: string;
  bootstrapContextHash?: string;
  bootstrapBriefingHash?: string;
  bootstrapRuntimeEventsPath?: string;
  runtimePid?: number;
}

export type BootstrapTranscriptRegularFileReader = (
  filePath: string,
  opts: { timeoutMs: number; maxBytes: number }
) => Promise<string | null>;

export type MergeRuntimeDiagnostics = (
  previous: string[] | undefined,
  incoming: unknown,
  fallback?: string
) => string[] | undefined;

function setBoundedMapEntry<Key, Value>(
  map: Map<Key, Value>,
  key: Key,
  value: Value,
  maxEntries = BOOTSTRAP_TRANSCRIPT_OUTCOME_CACHE_MAX_ENTRIES
): void {
  if (!map.has(key) && map.size >= maxEntries) {
    const oldest = map.keys().next();
    if (!oldest.done) {
      map.delete(oldest.value);
    }
  }
  map.set(key, value);
}

function isConfirmedBootstrapStaleRuntimeDiagnostic(reason?: string): boolean {
  const text = reason?.trim();
  return text === 'persisted runtime pid is not alive';
}

export function isBootstrapProofClearableLaunchFailureReason(reason?: string): boolean {
  return (
    isAutoClearableLaunchFailureReason(reason) ||
    isProvisionedButNotAliveFailureReason(reason) ||
    isConfirmedBootstrapStaleRuntimeDiagnostic(reason)
  );
}

export function shouldClearRuntimeDiagnosticAfterBootstrapConfirmation(reason?: string): boolean {
  return (
    isBootstrapProofClearableLaunchFailureReason(reason) ||
    isConfirmedBootstrapStaleRuntimeDiagnostic(reason)
  );
}

export function isProcessBootstrapTransportDiagnostic(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value.startsWith('Bootstrap transport ') ||
      value.includes('Last transport stage:') ||
      value.startsWith('bootstrap submit ') ||
      value.startsWith('runtime failed') ||
      value.startsWith('runtime exited'))
  );
}

function isNormalizedBootstrapTranscriptContextCandidateText(
  normalizedText: string,
  normalizedTeamName: string
): boolean {
  if (!normalizedText || !normalizedTeamName) {
    return false;
  }
  if (!normalizedText.includes(normalizedTeamName)) {
    return false;
  }
  return (
    normalizedText.includes('bootstrap') ||
    normalizedText.includes('bootstrapping') ||
    normalizedText.includes('member briefing') ||
    normalizedText.includes('task briefing')
  );
}

function isNormalizedBootstrapTranscriptContextMemberText(
  normalizedText: string,
  normalizedMemberName: string
): boolean {
  return !!normalizedMemberName && normalizedText.includes(normalizedMemberName);
}

function getCachedBootstrapContextCandidateForLine(
  line: ParsedBootstrapTranscriptTailLine,
  normalizedText: string,
  normalizedTeamName: string
): boolean {
  let candidateByTeam = line.bootstrapContextCandidateByTeam;
  if (!candidateByTeam) {
    candidateByTeam = new Map<string, boolean>();
    line.bootstrapContextCandidateByTeam = candidateByTeam;
  }
  const cached = candidateByTeam.get(normalizedTeamName);
  if (cached !== undefined) {
    return cached;
  }
  const value = isNormalizedBootstrapTranscriptContextCandidateText(
    normalizedText,
    normalizedTeamName
  );
  candidateByTeam.set(normalizedTeamName, value);
  return value;
}

function getCachedBootstrapContextMemberMatchForLine(
  line: ParsedBootstrapTranscriptTailLine,
  normalizedText: string,
  normalizedMemberName: string
): boolean {
  let matchByName = line.bootstrapContextMemberMatchByName;
  if (!matchByName) {
    matchByName = new Map<string, boolean>();
    line.bootstrapContextMemberMatchByName = matchByName;
  }
  const cached = matchByName.get(normalizedMemberName);
  if (cached !== undefined) {
    return cached;
  }
  const value = isNormalizedBootstrapTranscriptContextMemberText(
    normalizedText,
    normalizedMemberName
  );
  matchByName.set(normalizedMemberName, value);
  return value;
}

function getCachedBootstrapSuccessSourceForLine(
  line: ParsedBootstrapTranscriptTailLine,
  normalizedText: string,
  normalizedTeamName: string,
  normalizedMemberName: string
): BootstrapTranscriptSuccessSource | null {
  let sourceByTeamMember = line.bootstrapSuccessSourceByTeamMember;
  if (!sourceByTeamMember) {
    sourceByTeamMember = new Map<string, BootstrapTranscriptSuccessSource | null>();
    line.bootstrapSuccessSourceByTeamMember = sourceByTeamMember;
  }
  const cacheKey = `${normalizedTeamName}\0${normalizedMemberName}`;
  if (sourceByTeamMember.has(cacheKey)) {
    return sourceByTeamMember.get(cacheKey) ?? null;
  }
  const source = getBootstrapTranscriptSuccessSourceFromNormalized(
    normalizedText,
    normalizedTeamName,
    normalizedMemberName
  );
  sourceByTeamMember.set(cacheKey, source);
  return source;
}

function normalizeSafePathSegment(value: string): string | null {
  const trimmed = value.trim();
  return validateFileName(trimmed).valid ? trimmed : null;
}

function getSafeTeamDirectory(teamsBasePath: string, teamName: string): string | null {
  const safeTeamName = normalizeSafePathSegment(teamName);
  if (!safeTeamName) {
    return null;
  }
  const teamDir = path.join(teamsBasePath, safeTeamName);
  if (!isPathWithinRoot(teamDir, teamsBasePath)) {
    return null;
  }
  const realTeamsBasePath =
    realpathIfExists(path.resolve(teamsBasePath)) ?? path.resolve(teamsBasePath);
  const realTeamDir = realpathIfExists(teamDir);
  if (realTeamDir && !isPathWithinRoot(realTeamDir, realTeamsBasePath)) {
    return null;
  }
  return teamDir;
}

function getSafeTeamInboxPath(input: {
  teamsBasePath: string;
  teamName: string;
  leadName: string;
}): string | null {
  const teamDir = getSafeTeamDirectory(input.teamsBasePath, input.teamName);
  const safeLeadName = normalizeSafePathSegment(input.leadName);
  if (!teamDir || !safeLeadName) {
    return null;
  }
  const inboxDir = path.join(teamDir, 'inboxes');
  const inboxPath = path.join(inboxDir, `${safeLeadName}.json`);
  if (!isPathWithinRoot(inboxDir, teamDir) || !isPathWithinRoot(inboxPath, inboxDir)) {
    return null;
  }
  const realTeamDir = realpathIfExists(teamDir) ?? path.resolve(teamDir);
  const realInboxDir = realpathIfExists(inboxDir);
  if (realInboxDir && !isPathWithinRoot(realInboxDir, realTeamDir)) {
    return null;
  }
  const realInboxPath = realpathIfExists(inboxPath);
  if (
    realInboxPath &&
    (!isPathWithinRoot(realInboxPath, realInboxDir ?? path.resolve(inboxDir)) ||
      !isPathWithinRoot(realInboxPath, realTeamDir))
  ) {
    return null;
  }
  return inboxPath;
}

export async function readLeadInboxMessagesForLaunchReconcile(input: {
  teamName: string;
  leadName: string;
  teamsBasePath: string;
  readRegularFileUtf8: BootstrapTranscriptRegularFileReader;
  timeoutMs: number;
  maxBytes: number;
}): Promise<LeadInboxLaunchReconcileMessage[]> {
  const inboxPath = getSafeTeamInboxPath(input);
  if (!inboxPath) {
    return [];
  }
  try {
    const raw = await input.readRegularFileUtf8(inboxPath, {
      timeoutMs: input.timeoutMs,
      maxBytes: input.maxBytes,
    });
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((item): LeadInboxLaunchReconcileMessage[] => {
      if (!item || typeof item !== 'object') {
        return [];
      }
      const row = item as Partial<InboxMessage>;
      return typeof row.from === 'string' &&
        typeof row.text === 'string' &&
        typeof row.timestamp === 'string'
        ? [
            {
              from: row.from,
              text: row.text,
              timestamp: row.timestamp,
              messageId: row.messageId,
            },
          ]
        : [];
    });
  } catch {
    return [];
  }
}

export async function hasBootstrapTranscriptLaunchReconcileOutcome(input: {
  snapshot: PersistedTeamLaunchSnapshot;
  expectedMembers: readonly string[];
  findBootstrapRuntimeProofObservedAt: (
    teamName: string,
    memberName: string,
    member: Pick<
      PersistedTeamLaunchMemberState,
      'firstSpawnAcceptedAt' | 'launchState' | 'hardFailureReason'
    >
  ) => Promise<string | null>;
  findBootstrapTranscriptOutcome: (
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ) => Promise<BootstrapTranscriptOutcome | null>;
}): Promise<boolean> {
  for (const expected of input.expectedMembers) {
    const current = input.snapshot.members[expected];
    if (!current || current.bootstrapConfirmed) {
      continue;
    }
    const acceptedAtMs =
      current.firstSpawnAcceptedAt != null ? Date.parse(current.firstSpawnAcceptedAt) : NaN;
    if (
      current.launchState !== 'failed_to_start' ||
      isBootstrapProofClearableLaunchFailureReason(
        current.hardFailureReason ?? current.runtimeDiagnostic
      )
    ) {
      const runtimeProofObservedAt = await input.findBootstrapRuntimeProofObservedAt(
        input.snapshot.teamName,
        expected,
        current
      );
      if (runtimeProofObservedAt) {
        return true;
      }
    }
    const transcriptOutcome = await input.findBootstrapTranscriptOutcome(
      input.snapshot.teamName,
      expected,
      Number.isFinite(acceptedAtMs) ? acceptedAtMs : null
    );
    if (
      transcriptOutcome &&
      (transcriptOutcome.kind !== 'success' || !isPersistedOpenCodeSecondaryLaneMember(current))
    ) {
      return true;
    }
  }
  return false;
}

export function resolveBootstrapRuntimeMember(
  runtimeMembers: readonly BootstrapRuntimeMemberLike[],
  memberName: string
): BootstrapRuntimeMemberLike | undefined {
  return runtimeMembers.find((member) => {
    const candidateName = typeof member.name === 'string' ? member.name.trim() : '';
    return candidateName.length > 0 && matchesMemberNameOrBase(candidateName, memberName);
  });
}

function getSafeTeamRuntimeEventsDir(teamsBasePath: string, teamName: string): string | null {
  const teamDir = getSafeTeamDirectory(teamsBasePath, teamName);
  if (!teamDir) {
    return null;
  }
  const runtimeDir = path.join(teamDir, 'runtime');
  if (!isPathWithinRoot(runtimeDir, teamDir)) {
    return null;
  }
  const realTeamDir = realpathIfExists(teamDir) ?? path.resolve(teamDir);
  const realRuntimeDir = realpathIfExists(runtimeDir);
  if (realRuntimeDir && !isPathWithinRoot(realRuntimeDir, realTeamDir)) {
    return null;
  }
  return runtimeDir;
}

function realpathIfExists(inputPath: string): string | null {
  try {
    return fs.realpathSync.native(inputPath);
  } catch {
    return null;
  }
}

export function isContainedTeamRuntimeEventsPath(input: {
  teamsBasePath: string;
  teamName: string;
  candidatePath: string;
}): boolean {
  if (!input.candidatePath.trim()) {
    return false;
  }
  const runtimeDir = getSafeTeamRuntimeEventsDir(input.teamsBasePath, input.teamName);
  if (!runtimeDir) {
    return false;
  }
  const resolvedRuntimeDir = path.resolve(runtimeDir);
  const resolvedCandidate = path.resolve(input.candidatePath);
  if (!isPathWithinRoot(resolvedCandidate, resolvedRuntimeDir)) {
    return false;
  }

  const teamDir = path.dirname(resolvedRuntimeDir);
  const realTeamDir = realpathIfExists(teamDir) ?? teamDir;
  const realRuntimeDir = realpathIfExists(resolvedRuntimeDir);
  if (realRuntimeDir && !isPathWithinRoot(realRuntimeDir, realTeamDir)) {
    return false;
  }
  const realCandidate = realpathIfExists(resolvedCandidate);
  if (realCandidate) {
    return (
      isPathWithinRoot(realCandidate, realRuntimeDir ?? resolvedRuntimeDir) &&
      isPathWithinRoot(realCandidate, realTeamDir)
    );
  }
  return true;
}

export function getBootstrapRuntimeEventsPath(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
  runtimeMember: BootstrapRuntimeMemberLike | undefined;
}): string | null {
  const configuredPath = input.runtimeMember?.bootstrapRuntimeEventsPath?.trim();
  if (
    configuredPath &&
    isContainedTeamRuntimeEventsPath({
      teamsBasePath: input.teamsBasePath,
      teamName: input.teamName,
      candidatePath: configuredPath,
    })
  ) {
    return configuredPath;
  }
  const filePrefix = sanitizeProcessRuntimeEventFilePrefix(
    input.runtimeMember?.name ?? input.memberName
  );
  const runtimeDir = getSafeTeamRuntimeEventsDir(input.teamsBasePath, input.teamName);
  return runtimeDir ? path.join(runtimeDir, `${filePrefix}.runtime.jsonl`) : null;
}

export async function readRuntimeBootstrapProofEvents(
  eventsPath: string
): Promise<Record<string, unknown>[]> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    const pathStat = await fs.promises.lstat(eventsPath);
    if (!pathStat.isFile()) {
      return [];
    }
    handle = await fs.promises.open(eventsPath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0) {
      return [];
    }
    const start = Math.max(0, stat.size - BOOTSTRAP_RUNTIME_PROOF_TAIL_BYTES);
    const buffer = Buffer.alloc(stat.size - start);
    if (buffer.length === 0) {
      return [];
    }
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) {
      lines.shift();
    }
    if (lines.length > BOOTSTRAP_RUNTIME_EVENT_MAX_LINES) {
      lines.splice(0, lines.length - BOOTSTRAP_RUNTIME_EVENT_MAX_LINES);
    }
    const events: Record<string, unknown>[] = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > BOOTSTRAP_RUNTIME_EVENT_MAX_LINE_BYTES) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as unknown;
        if (
          parsed &&
          typeof parsed === 'object' &&
          (parsed as { version?: unknown }).version === 1 &&
          typeof (parsed as { type?: unknown }).type === 'string' &&
          typeof (parsed as { timestamp?: unknown }).timestamp === 'string'
        ) {
          events.push(parsed as Record<string, unknown>);
        }
      } catch {
        // Ignore partial lines from concurrently written runtime event files.
      }
    }
    return events;
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function isRuntimeBootstrapProofEventValid(input: {
  event: Record<string, unknown>;
  detail: Record<string, unknown>;
  teamName: string;
  memberName: string;
  runtimeMember?: BootstrapRuntimeMemberLike;
  boundaryMs: number;
}): boolean {
  const { event, detail, teamName, memberName, runtimeMember, boundaryMs } = input;
  if (
    !validateBootstrapRuntimeProofEnvelope({
      event,
      detail,
      expected: {
        teamName,
        boundaryMs,
        proofToken: runtimeMember?.bootstrapProofToken?.trim(),
        proofMode: runtimeMember?.bootstrapProofMode?.trim(),
        contextHash: runtimeMember?.bootstrapContextHash?.trim(),
        briefingHash: runtimeMember?.bootstrapBriefingHash?.trim(),
        runId: runtimeMember?.bootstrapRunId?.trim(),
      },
    })
  ) {
    return false;
  }
  const eventAgentName = typeof event.agentName === 'string' ? event.agentName.trim() : '';
  const eventAgentId = typeof event.agentId === 'string' ? event.agentId.trim() : '';
  const runtimeName = runtimeMember?.name?.trim() ?? '';
  const runtimeAgentId = runtimeMember?.agentId?.trim() ?? '';
  return (
    (eventAgentName.length > 0 &&
      (matchesMemberNameOrBase(eventAgentName, memberName) ||
        (runtimeName.length > 0 && matchesTeamMemberIdentity(eventAgentName, runtimeName)))) ||
    (eventAgentId.length > 0 && runtimeAgentId.length > 0 && eventAgentId === runtimeAgentId)
  );
}

export async function findBootstrapRuntimeProofObservedAt(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
  member: Pick<
    PersistedTeamLaunchMemberState,
    'firstSpawnAcceptedAt' | 'launchState' | 'hardFailureReason'
  >;
  runtimeMembers: readonly BootstrapRuntimeMemberLike[];
}): Promise<string | null> {
  const runtimeMember = resolveBootstrapRuntimeMember(input.runtimeMembers, input.memberName);
  const boundaryText = input.member.firstSpawnAcceptedAt ?? runtimeMember?.bootstrapExpectedAfter;
  const boundaryMs = boundaryText ? Date.parse(boundaryText) : Number.NaN;
  if (!runtimeMember?.bootstrapProofToken && !Number.isFinite(boundaryMs)) {
    return null;
  }
  const eventsPath = getBootstrapRuntimeEventsPath({
    teamsBasePath: input.teamsBasePath,
    teamName: input.teamName,
    memberName: input.memberName,
    runtimeMember,
  });
  if (!eventsPath) {
    return null;
  }
  const events = await readRuntimeBootstrapProofEvents(eventsPath);
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    const detail = parseBootstrapRuntimeProofDetail(event.detail);
    if (
      !isRuntimeBootstrapProofEventValid({
        event,
        detail,
        teamName: input.teamName,
        memberName: input.memberName,
        runtimeMember,
        boundaryMs,
      })
    ) {
      continue;
    }
    const timestamp = typeof event.timestamp === 'string' ? event.timestamp : '';
    const timestampMs = Date.parse(timestamp);
    if (Number.isFinite(timestampMs) && timestampMs >= latestMs) {
      latest = timestamp;
      latestMs = timestampMs;
    }
  }
  return latest;
}

export function isRuntimeBootstrapTransportEventCurrent(input: {
  event: Record<string, unknown>;
  teamName: string;
  memberName: string;
  runtimeMember?: BootstrapRuntimeMemberLike;
  expectedPid?: number;
  expectedBootstrapRunId?: string;
  boundaryMs: number;
}): boolean {
  const { event, teamName, memberName, runtimeMember, expectedPid, expectedBootstrapRunId } = input;
  const eventTeamName = typeof event.teamName === 'string' ? event.teamName.trim() : '';
  if (eventTeamName && eventTeamName !== teamName) {
    return false;
  }
  const eventAgentId = typeof event.agentId === 'string' ? event.agentId.trim() : '';
  const expectedAgentId = runtimeMember?.agentId?.trim() ?? '';
  if (eventAgentId && expectedAgentId && eventAgentId !== expectedAgentId) {
    return false;
  }
  const eventAgentName = typeof event.agentName === 'string' ? event.agentName.trim() : '';
  const runtimeName = runtimeMember?.name?.trim() ?? '';
  if (
    eventAgentName &&
    !matchesMemberNameOrBase(eventAgentName, memberName) &&
    !(runtimeName && matchesTeamMemberIdentity(eventAgentName, runtimeName))
  ) {
    return false;
  }
  const eventBootstrapRunId =
    typeof event.bootstrapRunId === 'string' ? event.bootstrapRunId.trim() : '';
  if (
    expectedBootstrapRunId &&
    eventBootstrapRunId &&
    eventBootstrapRunId !== expectedBootstrapRunId
  ) {
    return false;
  }
  const eventPid = typeof event.pid === 'number' && Number.isFinite(event.pid) ? event.pid : NaN;
  if (typeof expectedPid === 'number' && expectedPid > 0 && eventPid !== expectedPid) {
    return false;
  }
  if (Number.isFinite(input.boundaryMs)) {
    const timestamp = typeof event.timestamp === 'string' ? event.timestamp : '';
    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs) || timestampMs < input.boundaryMs) {
      return false;
    }
  }
  return true;
}

export async function readProcessBootstrapTransportSummary(input: {
  teamsBasePath: string;
  teamName: string;
  memberName: string;
  member: PersistedTeamLaunchMemberState;
  runtimeMembers: readonly BootstrapRuntimeMemberLike[];
}): Promise<ProcessBootstrapTransportSummary | null> {
  const runtimeMember = resolveBootstrapRuntimeMember(input.runtimeMembers, input.memberName);
  const memberRecord = input.member as unknown as Record<string, unknown>;
  const runtimeBackendType =
    runtimeMember?.backendType?.trim() ||
    (typeof memberRecord.backendType === 'string' ? memberRecord.backendType.trim() : '');
  const processPaneId =
    runtimeMember?.tmuxPaneId?.trim() ||
    (typeof memberRecord.tmuxPaneId === 'string' ? memberRecord.tmuxPaneId.trim() : '');
  if (runtimeBackendType !== 'process' && !processPaneId?.startsWith('process:')) {
    return null;
  }
  const boundaryText = input.member.firstSpawnAcceptedAt ?? runtimeMember?.bootstrapExpectedAfter;
  const boundaryMs = boundaryText ? Date.parse(boundaryText) : Number.NaN;
  const expectedPid =
    typeof input.member.runtimePid === 'number' && input.member.runtimePid > 0
      ? input.member.runtimePid
      : typeof runtimeMember?.runtimePid === 'number' && runtimeMember.runtimePid > 0
        ? runtimeMember.runtimePid
        : undefined;
  const expectedBootstrapRunId =
    runtimeMember?.bootstrapRunId?.trim() ||
    (typeof input.member.runtimeRunId === 'string' ? input.member.runtimeRunId.trim() : '') ||
    (typeof memberRecord.bootstrapRunId === 'string' ? memberRecord.bootstrapRunId.trim() : '');
  if (!expectedBootstrapRunId && !Number.isFinite(boundaryMs) && !expectedPid) {
    return null;
  }

  const eventsPath = getBootstrapRuntimeEventsPath({
    teamsBasePath: input.teamsBasePath,
    teamName: input.teamName,
    memberName: input.memberName,
    runtimeMember,
  });
  if (!eventsPath) {
    return null;
  }
  const events = await readRuntimeBootstrapProofEvents(eventsPath);
  const currentEvents = events.filter((event) =>
    isRuntimeBootstrapTransportEventCurrent({
      event,
      teamName: input.teamName,
      memberName: input.memberName,
      runtimeMember,
      expectedPid,
      expectedBootstrapRunId,
      boundaryMs,
    })
  );
  return summarizeProcessBootstrapTransportEvents(
    currentEvents as ProcessBootstrapTransportEvent[]
  );
}

export function applyProcessBootstrapTransportOverlay(input: {
  member: PersistedTeamLaunchMemberState;
  summary: ProcessBootstrapTransportSummary | null;
  launchPhase: PersistedTeamLaunchPhase;
  finalTimeoutReached?: boolean;
  nowIso: () => string;
  mergeRuntimeDiagnostics: MergeRuntimeDiagnostics;
}): PersistedTeamLaunchMemberState {
  const { member, summary } = input;
  if (
    !summary ||
    member.bootstrapConfirmed ||
    member.launchState === 'confirmed_alive' ||
    member.launchState === 'skipped_for_launch' ||
    member.launchState === 'runtime_pending_permission' ||
    member.skippedForLaunch === true
  ) {
    return member;
  }
  const existingFailure = member.hardFailureReason ?? member.runtimeDiagnostic;
  if (
    member.launchState === 'failed_to_start' &&
    member.hardFailure === true &&
    !isAutoClearableLaunchFailureReason(existingFailure)
  ) {
    return member;
  }

  const projectionPhase = deriveProcessTransportProjectionPhase({
    launchPhase: input.launchPhase,
    finalTimeoutReached: input.finalTimeoutReached,
  });
  const base: PersistedTeamLaunchMemberState = {
    ...member,
    agentToolAccepted: true,
    lastEvaluatedAt: input.nowIso(),
  };

  if (summary.terminalFailure) {
    const reason = summary.terminalFailure.reason;
    return {
      ...base,
      launchState: 'failed_to_start',
      bootstrapConfirmed: false,
      hardFailure: true,
      hardFailureReason: reason,
      runtimeDiagnostic: reason,
      runtimeDiagnosticSeverity: 'error',
      diagnostics: input.mergeRuntimeDiagnostics(base.diagnostics, [reason, summary.lastStage]),
      sources: {
        ...(base.sources ?? {}),
        hardFailureSignal: true,
      },
    };
  }

  if (!summary.hasProgress) {
    return member;
  }

  if (projectionPhase === 'final') {
    const reason = buildProcessBootstrapTimeoutDiagnostic(summary);
    return {
      ...base,
      launchState: 'failed_to_start',
      bootstrapConfirmed: false,
      hardFailure: true,
      hardFailureReason: reason,
      runtimeDiagnostic: reason,
      runtimeDiagnosticSeverity: 'error',
      diagnostics: input.mergeRuntimeDiagnostics(base.diagnostics, [reason, summary.lastStage]),
      sources: {
        ...(base.sources ?? {}),
        hardFailureSignal: true,
      },
    };
  }

  const runtimeDiagnostic = buildProcessBootstrapPendingDiagnostic(summary);
  return {
    ...base,
    launchState: 'runtime_pending_bootstrap',
    bootstrapConfirmed: false,
    hardFailure: false,
    hardFailureReason: undefined,
    runtimeDiagnostic,
    runtimeDiagnosticSeverity: summary.submitted ? 'info' : 'warning',
    diagnostics: input.mergeRuntimeDiagnostics(base.diagnostics, [
      runtimeDiagnostic,
      summary.lastStage,
    ]),
    sources: {
      ...(base.sources ?? {}),
      hardFailureSignal: undefined,
    },
  };
}

export async function applyBootstrapTranscriptEvidenceOverlay(input: {
  snapshot: PersistedTeamLaunchSnapshot | null;
  expectedMembers: readonly string[];
  findBootstrapRuntimeProofObservedAt: (
    teamName: string,
    memberName: string,
    member: Pick<
      PersistedTeamLaunchMemberState,
      'firstSpawnAcceptedAt' | 'launchState' | 'hardFailureReason'
    >
  ) => Promise<string | null>;
  findBootstrapTranscriptOutcome: (
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ) => Promise<BootstrapTranscriptOutcome | null>;
  nowIso: () => string;
}): Promise<PersistedTeamLaunchSnapshot | null> {
  const { snapshot } = input;
  if (!snapshot) {
    return null;
  }

  let changed = false;
  const nextMembers: Record<string, PersistedTeamLaunchMemberState> = { ...snapshot.members };
  for (const expected of input.expectedMembers) {
    const current = nextMembers[expected];
    if (!current || current.bootstrapConfirmed || isPersistedOpenCodeSecondaryLaneMember(current)) {
      continue;
    }
    const failureReason = current.hardFailureReason ?? current.runtimeDiagnostic;
    const provisionedButNotAliveFailure = isProvisionedButNotAliveFailureReason(failureReason);
    if (provisionedButNotAliveFailure && hasUnsafeProvisionedButNotAliveRuntimeEvidence(current)) {
      continue;
    }
    const canClearFailedBootstrap =
      current.launchState !== 'failed_to_start' ||
      isBootstrapProofClearableLaunchFailureReason(failureReason);
    if (!canClearFailedBootstrap) {
      continue;
    }

    const acceptedAtMs =
      current.firstSpawnAcceptedAt != null ? Date.parse(current.firstSpawnAcceptedAt) : NaN;
    const runtimeProofObservedAt = await input.findBootstrapRuntimeProofObservedAt(
      snapshot.teamName,
      expected,
      current
    );
    const transcriptOutcome = await input.findBootstrapTranscriptOutcome(
      snapshot.teamName,
      expected,
      Number.isFinite(acceptedAtMs) ? acceptedAtMs : null
    );
    const observedAt =
      runtimeProofObservedAt ??
      (transcriptOutcome?.kind === 'success' ? transcriptOutcome.observedAt : null);
    if (!observedAt) {
      continue;
    }

    const nextMember: PersistedTeamLaunchMemberState = {
      ...current,
      agentToolAccepted: true,
      bootstrapConfirmed: true,
      runtimeAlive: runtimeProofObservedAt
        ? true
        : current.runtimeAlive === true || provisionedButNotAliveFailure,
      hardFailure: false,
      hardFailureReason: undefined,
      lastHeartbeatAt: current.lastHeartbeatAt ?? observedAt,
      lastRuntimeAliveAt: runtimeProofObservedAt
        ? (current.lastRuntimeAliveAt ?? observedAt)
        : current.lastRuntimeAliveAt,
      lastEvaluatedAt: input.nowIso(),
      sources: {
        ...(current.sources ?? {}),
        hardFailureSignal: undefined,
      },
      diagnostics: undefined,
    };
    nextMember.launchState = deriveMemberLaunchState(nextMember);
    nextMembers[expected] = nextMember;
    changed = true;
  }

  if (!changed) {
    return snapshot;
  }

  return createPersistedLaunchSnapshot({
    teamName: snapshot.teamName,
    expectedMembers: snapshot.expectedMembers,
    bootstrapExpectedMembers: snapshot.bootstrapExpectedMembers,
    leadSessionId: snapshot.leadSessionId,
    launchPhase: snapshot.launchPhase,
    members: nextMembers,
    updatedAt: input.nowIso(),
  });
}

export function needsBootstrapAcceptanceReconcile(input: {
  snapshot: PersistedTeamLaunchSnapshot | null;
  bootstrapSnapshot: PersistedTeamLaunchSnapshot | null;
  expectedMembers: readonly string[];
}): boolean {
  if (!input.snapshot || !input.bootstrapSnapshot) {
    return false;
  }
  for (const expected of input.expectedMembers) {
    const current = input.snapshot.members[expected];
    const bootstrapMember = input.bootstrapSnapshot.members[expected];
    if (!current || !bootstrapMember) {
      continue;
    }
    if (
      bootstrapMember.bootstrapConfirmed === true &&
      !isPersistedOpenCodeSecondaryLaneMember(current) &&
      isBootstrapMemberEvidenceCurrentForMember(current, bootstrapMember, 'confirmation')
    ) {
      const currentConfirmed =
        current.bootstrapConfirmed === true || current.launchState === 'confirmed_alive';
      const failureReason = current.hardFailureReason ?? current.runtimeDiagnostic;
      const hasAutoClearableFailure =
        (current.launchState === 'failed_to_start' || current.hardFailure === true) &&
        isBootstrapProofClearableLaunchFailureReason(failureReason);
      if (!currentConfirmed || hasAutoClearableFailure) {
        return true;
      }
    }
    const bootstrapProvesSpawnAcceptance =
      (bootstrapMember.agentToolAccepted === true ||
        typeof bootstrapMember.firstSpawnAcceptedAt === 'string') &&
      isBootstrapMemberEvidenceCurrentForMember(current, bootstrapMember, 'acceptance');
    if (!bootstrapProvesSpawnAcceptance) {
      continue;
    }
    const currentProvesSpawnAcceptance =
      current.agentToolAccepted === true || typeof current.firstSpawnAcceptedAt === 'string';
    if (!currentProvesSpawnAcceptance) {
      return true;
    }
    if (isNeverSpawnedDuringLaunchReason(current.hardFailureReason)) {
      return true;
    }
  }
  return false;
}

export function needsConfirmedBootstrapDiagnosticReconcile(
  snapshot: PersistedTeamLaunchSnapshot | null
): boolean {
  if (!snapshot) {
    return false;
  }
  for (const member of Object.values(snapshot.members)) {
    if (
      member?.bootstrapConfirmed !== true ||
      member.hardFailure === true ||
      isPersistedOpenCodeSecondaryLaneMember(member)
    ) {
      continue;
    }
    if (
      member.livenessKind === 'stale_metadata' ||
      member.livenessKind === 'registered_only' ||
      member.pidSource === 'persisted_metadata' ||
      shouldClearRuntimeDiagnosticAfterBootstrapConfirmation(member.runtimeDiagnostic)
    ) {
      return true;
    }
  }
  return false;
}

export function cleanConfirmedBootstrapRuntimeDiagnostics(input: {
  snapshot: PersistedTeamLaunchSnapshot | null;
  expectedMembers: readonly string[];
  nowIso: () => string;
}): PersistedTeamLaunchSnapshot | null {
  const { snapshot } = input;
  if (!snapshot) {
    return null;
  }

  let changed = false;
  const updatedAt = input.nowIso();
  const members: Record<string, PersistedTeamLaunchMemberState> = { ...snapshot.members };
  for (const memberName of input.expectedMembers) {
    const current = members[memberName];
    if (
      !current ||
      current.bootstrapConfirmed !== true ||
      current.hardFailure === true ||
      isPersistedOpenCodeSecondaryLaneMember(current)
    ) {
      continue;
    }

    const hasConfirmedBootstrapStaleRuntimeState =
      current.livenessKind === 'stale_metadata' ||
      current.livenessKind === 'registered_only' ||
      current.pidSource === 'persisted_metadata' ||
      shouldClearRuntimeDiagnosticAfterBootstrapConfirmation(current.runtimeDiagnostic) ||
      current.bootstrapStalled === true;
    if (!hasConfirmedBootstrapStaleRuntimeState) {
      continue;
    }

    const next: PersistedTeamLaunchMemberState = {
      ...current,
      livenessKind:
        current.livenessKind === 'stale_metadata' ||
        current.livenessKind === 'registered_only' ||
        current.livenessKind == null
          ? 'confirmed_bootstrap'
          : current.livenessKind,
      pidSource:
        current.pidSource === 'persisted_metadata' || current.pidSource == null
          ? 'runtime_bootstrap'
          : current.pidSource,
      bootstrapStalled: undefined,
      diagnostics: undefined,
      lastEvaluatedAt: updatedAt,
    };
    if (shouldClearRuntimeDiagnosticAfterBootstrapConfirmation(next.runtimeDiagnostic)) {
      next.runtimeDiagnostic = undefined;
      next.runtimeDiagnosticSeverity = undefined;
    } else if (!next.runtimeDiagnostic) {
      next.runtimeDiagnosticSeverity = undefined;
    }
    next.launchState = deriveMemberLaunchState(next);
    members[memberName] = next;
    changed = true;
  }

  if (!changed) {
    return snapshot;
  }

  return createPersistedLaunchSnapshot({
    teamName: snapshot.teamName,
    expectedMembers: snapshot.expectedMembers,
    bootstrapExpectedMembers: snapshot.bootstrapExpectedMembers,
    leadSessionId: snapshot.leadSessionId,
    launchPhase: snapshot.launchPhase,
    members,
    updatedAt,
  });
}

export function cloneBootstrapTranscriptOutcome(
  outcome: BootstrapTranscriptOutcome | null
): BootstrapTranscriptOutcome | null {
  return outcome ? { ...outcome } : null;
}

export function buildBootstrapTranscriptOutcomeLookupCacheKey(
  teamName: string,
  memberName: string,
  sinceMs: number | null
): string {
  return [teamName.trim().toLowerCase(), memberName.trim().toLowerCase(), sinceMs ?? ''].join('\0');
}

export function getPersistedBootstrapTranscriptOutcomeLookupCacheEntry(input: {
  cache: Map<string, BootstrapTranscriptOutcomeLookupCacheEntry>;
  cacheKey: string;
  nowMs?: number;
}): BootstrapTranscriptOutcome | null | undefined {
  const cached = input.cache.get(input.cacheKey);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAtMs <= (input.nowMs ?? Date.now())) {
    input.cache.delete(input.cacheKey);
    return undefined;
  }
  return cached.outcome;
}

export function setPersistedBootstrapTranscriptOutcomeLookupCacheEntry(input: {
  cache: Map<string, BootstrapTranscriptOutcomeLookupCacheEntry>;
  cacheKey: string;
  outcome: BootstrapTranscriptOutcome | null;
  nowMs?: number;
  maxEntries?: number;
  ttlMs?: number;
}): void {
  setBoundedMapEntry(
    input.cache,
    input.cacheKey,
    {
      expiresAtMs:
        (input.nowMs ?? Date.now()) +
        (input.ttlMs ?? PERSISTED_BOOTSTRAP_TRANSCRIPT_OUTCOME_LOOKUP_CACHE_TTL_MS),
      outcome: cloneBootstrapTranscriptOutcome(input.outcome),
    },
    input.maxEntries
  );
}

export async function findBootstrapTranscriptOutcome(input: {
  teamName: string;
  memberName: string;
  sinceMs: number | null;
  lookupCache: Map<string, BootstrapTranscriptOutcomeLookupCacheEntry>;
  lookupCacheEnabled: boolean;
  findMemberLogs: (
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ) => Promise<readonly { filePath?: string | null }[]>;
  readRecentBootstrapTranscriptOutcome: (
    filePath: string,
    sinceMs: number | null,
    memberName: string,
    teamName: string,
    options?: { allowAnonymousFailure?: boolean; contextMemberNames?: readonly string[] }
  ) => Promise<BootstrapTranscriptOutcome | null>;
  readBootstrapTranscriptOutcomesInProjectRoot: (
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ) => Promise<BootstrapTranscriptOutcome[]>;
  maxCacheEntries?: number;
  lookupCacheTtlMs?: number;
}): Promise<BootstrapTranscriptOutcome | null> {
  const lookupCacheKey = buildBootstrapTranscriptOutcomeLookupCacheKey(
    input.teamName,
    input.memberName,
    input.sinceMs
  );
  if (input.lookupCacheEnabled) {
    const cachedLookup = getPersistedBootstrapTranscriptOutcomeLookupCacheEntry({
      cache: input.lookupCache,
      cacheKey: lookupCacheKey,
    });
    if (cachedLookup !== undefined) {
      return cloneBootstrapTranscriptOutcome(cachedLookup);
    }
  }

  let summaries: readonly { filePath?: string | null }[];
  try {
    summaries = await input.findMemberLogs(input.teamName, input.memberName, input.sinceMs);
  } catch {
    summaries = [];
  }

  const outcomes: BootstrapTranscriptOutcome[] = [];
  for (const summary of summaries) {
    if (!summary.filePath) continue;
    const outcome = await input.readRecentBootstrapTranscriptOutcome(
      summary.filePath,
      input.sinceMs,
      input.memberName,
      input.teamName,
      { allowAnonymousFailure: true }
    );
    if (outcome) {
      outcomes.push(outcome);
    }
  }

  outcomes.push(
    ...(await input.readBootstrapTranscriptOutcomesInProjectRoot(
      input.teamName,
      input.memberName,
      input.sinceMs
    ))
  );

  const outcome = selectLatestBootstrapTranscriptOutcome(outcomes);
  if (input.lookupCacheEnabled) {
    setPersistedBootstrapTranscriptOutcomeLookupCacheEntry({
      cache: input.lookupCache,
      cacheKey: lookupCacheKey,
      outcome,
      maxEntries: input.maxCacheEntries,
      ttlMs: input.lookupCacheTtlMs,
    });
  }
  return outcome;
}

export function buildBootstrapTranscriptOutcomeCacheKey(input: {
  filePath: string;
  sinceMs: number | null;
  memberName: string;
  teamName: string;
  allowAnonymousFailure: boolean;
  contextMemberNames: readonly string[];
}): string {
  const normalizedContextMembers = Array.from(
    new Set(input.contextMemberNames.map((name) => name.trim().toLowerCase()).filter(Boolean))
  )
    .sort()
    .join('\0');
  return [
    input.filePath,
    input.sinceMs ?? '',
    input.memberName,
    input.teamName.trim().toLowerCase(),
    input.allowAnonymousFailure ? '1' : '0',
    normalizedContextMembers,
  ].join('\0');
}

export async function readRecentBootstrapTranscriptOutcome(input: {
  filePath: string;
  sinceMs: number | null;
  memberName: string;
  teamName: string;
  options?: {
    allowAnonymousFailure?: boolean;
    contextMemberNames?: readonly string[];
  };
  outcomeCache: Map<string, BootstrapTranscriptOutcomeCacheEntry>;
  getParsedBootstrapTranscriptTail: (
    filePath: string,
    stat: { mtimeMs: number; size: number }
  ) => Promise<ParsedBootstrapTranscriptTailLine[]>;
  nowIso?: () => string;
  maxCacheEntries?: number;
}): Promise<BootstrapTranscriptOutcome | null> {
  const options = input.options ?? {};
  const normalizedMemberName = input.memberName.trim().toLowerCase();
  const normalizedTeamName = input.teamName.trim().toLowerCase();
  const contextMemberNames = Array.from(
    new Set(
      [input.memberName, ...(options.contextMemberNames ?? [])]
        .map((name) => name.trim())
        .filter(Boolean)
    )
  );
  const normalizedContextMemberNames = contextMemberNames.map((name) => name.trim().toLowerCase());
  const cacheKey = buildBootstrapTranscriptOutcomeCacheKey({
    filePath: input.filePath,
    sinceMs: input.sinceMs,
    memberName: normalizedMemberName,
    teamName: input.teamName,
    allowAnonymousFailure: options.allowAnonymousFailure === true,
    contextMemberNames,
  });
  try {
    const stat = await fs.promises.stat(input.filePath);
    if (!stat.isFile() || stat.size <= 0) {
      return null;
    }
    const cached = input.outcomeCache.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.outcome;
    }
    const parsedLines = await input.getParsedBootstrapTranscriptTail(input.filePath, stat);
    const shouldCollectBootstrapContext = options.allowAnonymousFailure !== true;
    const bootstrapContextMembers = new Set<string>();
    const candidates: BootstrapTranscriptOutcomeCandidate[] = [];
    for (const parsedLine of parsedLines) {
      const { timestampMs, parsedAgentName, text, rawTimestamp, normalizedText } = parsedLine;
      if (input.sinceMs != null && (!Number.isFinite(timestampMs) || timestampMs < input.sinceMs)) {
        continue;
      }
      if (
        parsedAgentName &&
        !matchesObservedMemberNameForExpected(parsedAgentName, normalizedMemberName)
      ) {
        continue;
      }
      if (!text) {
        continue;
      }
      const lineNormalizedText = normalizedText ?? '';
      if (shouldCollectBootstrapContext) {
        const isBootstrapContextLine = getCachedBootstrapContextCandidateForLine(
          parsedLine,
          lineNormalizedText,
          normalizedTeamName
        );
        if (isBootstrapContextLine) {
          for (const contextMemberName of normalizedContextMemberNames) {
            if (
              getCachedBootstrapContextMemberMatchForLine(
                parsedLine,
                lineNormalizedText,
                contextMemberName
              )
            ) {
              bootstrapContextMembers.add(contextMemberName);
            }
          }
        }
      }
      candidates.push({
        text,
        normalizedText: lineNormalizedText,
        observedAt:
          rawTimestamp && rawTimestamp.length > 0
            ? rawTimestamp
            : (input.nowIso ?? (() => new Date().toISOString()))(),
        parsedAgentName,
        parsedLine,
      });
    }
    const hasUnambiguousMatchingBootstrapContext =
      shouldCollectBootstrapContext &&
      bootstrapContextMembers.size === 1 &&
      bootstrapContextMembers.has(normalizedMemberName);
    let outcome: BootstrapTranscriptOutcome | null = null;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index];
      if (!candidate) continue;
      const cachedLine = candidate.parsedLine;
      if (cachedLine.bootstrapFailureReason === undefined) {
        cachedLine.bootstrapFailureReason = extractBootstrapFailureReason(candidate.text);
      }
      const reason = cachedLine.bootstrapFailureReason;
      if (reason) {
        if (
          !candidate.parsedAgentName &&
          options.allowAnonymousFailure !== true &&
          !hasUnambiguousMatchingBootstrapContext
        ) {
          continue;
        }
        outcome = { kind: 'failure', observedAt: candidate.observedAt, reason };
        break;
      }
      const successSource = getCachedBootstrapSuccessSourceForLine(
        cachedLine,
        candidate.normalizedText,
        normalizedTeamName,
        normalizedMemberName
      );
      if (successSource) {
        outcome = { kind: 'success', observedAt: candidate.observedAt, source: successSource };
        break;
      }
    }
    setBoundedMapEntry(
      input.outcomeCache,
      cacheKey,
      {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        outcome,
      },
      input.maxCacheEntries
    );
    return outcome;
  } catch {
    return null;
  }
}

export async function getParsedBootstrapTranscriptTail(input: {
  filePath: string;
  stat: { mtimeMs: number; size: number };
  cache: Map<string, ParsedBootstrapTranscriptTailCacheEntry>;
  tailBytes?: number;
  maxCacheEntries?: number;
}): Promise<ParsedBootstrapTranscriptTailLine[]> {
  const cached = input.cache.get(input.filePath);
  if (cached && cached.mtimeMs === input.stat.mtimeMs && cached.size === input.stat.size) {
    return cached.lines;
  }
  const lines: ParsedBootstrapTranscriptTailLine[] = [];
  const start = Math.max(0, input.stat.size - (input.tailBytes ?? BOOTSTRAP_FAILURE_TAIL_BYTES));
  const length = input.stat.size - start;
  if (length > 0) {
    const handle = await fs.promises.open(input.filePath, 'r');
    let rawLines: string[];
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      rawLines = buffer.toString('utf8').split('\n');
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (start > 0) {
      rawLines.shift();
    }
    for (const rawLine of rawLines) {
      const line = rawLine?.trim();
      if (!line) continue;
      let parsed: { timestamp?: unknown; agentName?: unknown } | null = null;
      try {
        parsed = JSON.parse(line) as { timestamp?: unknown; agentName?: unknown };
      } catch {
        continue;
      }
      const rawTimestamp =
        typeof parsed.timestamp === 'string' && parsed.timestamp.trim().length > 0
          ? parsed.timestamp.trim()
          : null;
      const timestampMs =
        typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : Number.NaN;
      const parsedAgentName =
        typeof parsed.agentName === 'string' ? parsed.agentName.trim().toLowerCase() || null : null;
      const text = extractTranscriptMessageText(parsed);
      const normalizedText = text ? text.replace(/\s+/g, ' ').trim().toLowerCase() : null;
      lines.push({ rawTimestamp, timestampMs, text, normalizedText, parsedAgentName });
    }
  }
  setBoundedMapEntry(
    input.cache,
    input.filePath,
    {
      mtimeMs: input.stat.mtimeMs,
      size: input.stat.size,
      lines,
    },
    input.maxCacheEntries
  );
  return lines;
}

export async function readBootstrapTranscriptOutcomesInProjectRoot(input: {
  teamName: string;
  memberName: string;
  sinceMs: number | null;
  readConfigSnapshot: (teamName: string) => Promise<TeamConfig | null>;
  readMetaMembers: (teamName: string) => Promise<readonly { name?: unknown; cwd?: unknown }[]>;
  readRecentBootstrapTranscriptOutcome: (
    filePath: string,
    sinceMs: number | null,
    memberName: string,
    teamName: string,
    options?: { allowAnonymousFailure?: boolean; contextMemberNames?: readonly string[] }
  ) => Promise<BootstrapTranscriptOutcome | null>;
  mtimeSlackMs?: number;
}): Promise<BootstrapTranscriptOutcome[]> {
  let config: TeamConfig | null;
  try {
    config = await input.readConfigSnapshot(input.teamName);
  } catch {
    return [];
  }
  const outcomes: BootstrapTranscriptOutcome[] = [];
  const metaMembers = await input.readMetaMembers(input.teamName).catch(() => []);
  const projectDirs = collectBootstrapTranscriptProjectDirs({
    memberName: input.memberName,
    config,
    metaMembers,
  });
  const contextMemberNames = [
    input.memberName,
    ...((config?.members ?? [])
      .map((member) => member.name?.trim())
      .filter((name): name is string => Boolean(name)) ?? []),
  ];
  for (const projectDir of projectDirs) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }

    const jsonlFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of jsonlFiles) {
      if (config?.leadSessionId && entry.name === `${config.leadSessionId}.jsonl`) {
        continue;
      }
      const candidatePath = path.join(projectDir, entry.name);
      if (input.sinceMs != null) {
        try {
          const candidateStat = await fs.promises.stat(candidatePath);
          if (
            candidateStat.mtimeMs <
            input.sinceMs - (input.mtimeSlackMs ?? BOOTSTRAP_TRANSCRIPT_MTIME_SLACK_MS)
          ) {
            continue;
          }
        } catch {
          continue;
        }
      }
      const outcome = await input.readRecentBootstrapTranscriptOutcome(
        candidatePath,
        input.sinceMs,
        input.memberName,
        input.teamName,
        { contextMemberNames }
      );
      if (outcome) {
        outcomes.push(outcome);
      }
    }
  }

  return outcomes;
}

export function collectBootstrapTranscriptProjectDirs(input: {
  memberName: string;
  config: TeamConfig | null;
  metaMembers: readonly { name?: unknown; cwd?: unknown }[];
  projectsBasePath?: string;
}): string[] {
  const pathCandidates: string[] = [];
  const pathSeen = new Set<string>();
  const pushPath = (value: unknown): void => {
    if (typeof value !== 'string') {
      return;
    }
    let trimmed = value.trim();
    while (trimmed.endsWith('/') || trimmed.endsWith('\\')) {
      trimmed = trimmed.slice(0, -1);
    }
    if (!trimmed || pathSeen.has(trimmed)) {
      return;
    }
    pathSeen.add(trimmed);
    pathCandidates.push(trimmed);
  };

  pushPath(input.config?.projectPath);
  if (Array.isArray(input.config?.projectPathHistory)) {
    for (let index = input.config.projectPathHistory.length - 1; index >= 0; index -= 1) {
      pushPath(input.config.projectPathHistory[index]);
    }
  }

  const normalizedMemberName = input.memberName.trim().toLowerCase();
  const pushMatchingMemberCwd = (member: { name?: unknown; cwd?: unknown }): void => {
    const candidateName = typeof member.name === 'string' ? member.name.trim().toLowerCase() : '';
    if (candidateName && matchesTeamMemberIdentity(candidateName, normalizedMemberName)) {
      pushPath(member.cwd);
    }
  };
  for (const member of input.config?.members ?? []) {
    pushMatchingMemberCwd(member);
  }

  for (const member of input.metaMembers) {
    pushMatchingMemberCwd(member);
  }

  const dirs: string[] = [];
  const dirSeen = new Set<string>();
  const pushDir = (dir: string): void => {
    if (!dir || dirSeen.has(dir)) {
      return;
    }
    dirSeen.add(dir);
    dirs.push(dir);
  };
  const projectsBasePath = input.projectsBasePath ?? getProjectsBasePath();
  for (const projectPath of pathCandidates) {
    const projectId = extractBaseDir(encodePath(projectPath));
    pushDir(path.join(projectsBasePath, projectId));
    if (projectId.includes('_')) {
      pushDir(path.join(projectsBasePath, projectId.replace(/_/g, '-')));
    }
  }
  return dirs;
}

export function selectLatestBootstrapTranscriptOutcome(
  outcomes: readonly BootstrapTranscriptOutcome[]
): BootstrapTranscriptOutcome | null {
  return (
    [...outcomes].sort((left, right) => {
      const leftMs = Date.parse(left.observedAt);
      const rightMs = Date.parse(right.observedAt);
      const leftValid = Number.isFinite(leftMs);
      const rightValid = Number.isFinite(rightMs);
      if (leftValid && rightValid && leftMs !== rightMs) {
        return rightMs - leftMs;
      }
      if (leftValid !== rightValid) {
        return leftValid ? -1 : 1;
      }
      return 0;
    })[0] ?? null
  );
}
