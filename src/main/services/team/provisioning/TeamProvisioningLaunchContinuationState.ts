import * as fs from 'fs';

import { getTeamBootstrapStatePath } from '../TeamBootstrapStateReader';

import type {
  DurableLaunchContinuationEvidence,
  DurableLaunchContinuationEvidenceRead,
  DurableLaunchContinuationMemberEvidence,
} from './TeamProvisioningLaunchContinuationEvidence';

const MAX_BOOTSTRAP_STATE_BYTES = 256 * 1024;

async function readContinuationStateFile(
  teamName: string
): Promise<
  { kind: 'absent' } | { kind: 'invalid'; reason: string } | { kind: 'raw'; raw: string }
> {
  const filePath = getTeamBootstrapStatePath(teamName);
  let validated: fs.Stats;
  try {
    validated = await fs.promises.lstat(filePath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'invalid', reason: 'bootstrap continuation state is inaccessible' };
  }
  if (validated.isSymbolicLink() || !validated.isFile()) {
    return { kind: 'invalid', reason: 'bootstrap continuation state is not a regular file' };
  }
  if (validated.size > MAX_BOOTSTRAP_STATE_BYTES) {
    return { kind: 'invalid', reason: 'bootstrap continuation state is oversized' };
  }

  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY);
  } catch {
    return { kind: 'invalid', reason: 'bootstrap continuation state changed while opening' };
  }
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.size > MAX_BOOTSTRAP_STATE_BYTES ||
      (Number.isFinite(validated.dev) &&
        Number.isFinite(validated.ino) &&
        (opened.dev !== validated.dev || opened.ino !== validated.ino))
    ) {
      return { kind: 'invalid', reason: 'bootstrap continuation state changed while reading' };
    }
    return { kind: 'raw', raw: await handle.readFile({ encoding: 'utf8' }) };
  } catch {
    return { kind: 'invalid', reason: 'bootstrap continuation state is unreadable' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseMember(value: unknown): DurableLaunchContinuationMemberEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = nonEmptyString(record.name);
  const outcome = record.outcome;
  const observedAt = nonEmptyString(record.observedAt);
  if (
    !name ||
    !observedAt ||
    (outcome !== 'bootstrap_confirmed' && outcome !== 'failed' && outcome !== 'missing')
  ) {
    return null;
  }
  if (outcome === 'bootstrap_confirmed') {
    const runtimeRunId = nonEmptyString(record.runtimeRunId);
    return runtimeRunId ? { name, outcome, observedAt, runtimeRunId } : null;
  }
  if (!record.cleanup || typeof record.cleanup !== 'object' || Array.isArray(record.cleanup)) {
    return null;
  }
  const cleanup = record.cleanup as Record<string, unknown>;
  const cleanupRunId = nonEmptyString(cleanup.runId);
  const cleanupObservedAt = nonEmptyString(cleanup.observedAt);
  if (cleanup.status !== 'confirmed' || !cleanupRunId || !cleanupObservedAt) return null;
  return {
    name,
    outcome,
    observedAt,
    cleanup: { status: 'confirmed', runId: cleanupRunId, observedAt: cleanupObservedAt },
  };
}

function parseMarkedState(raw: Record<string, unknown>): DurableLaunchContinuationEvidenceRead {
  const marker = raw.launchContinuation;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
    return { kind: 'invalid', reason: 'the marked bootstrap state has no continuation evidence' };
  }
  const evidence = marker as Record<string, unknown>;
  const terminal =
    raw.terminal && typeof raw.terminal === 'object' && !Array.isArray(raw.terminal)
      ? (raw.terminal as Record<string, unknown>)
      : null;
  const sourceRunId = nonEmptyString(evidence.sourceRunId);
  const rawRunId = nonEmptyString(raw.runId);
  const teamName = nonEmptyString(evidence.teamName);
  const evidenceId = nonEmptyString(evidence.evidenceId);
  const updatedAt = nonEmptyString(evidence.updatedAt);
  const rawUpdatedAt = nonEmptyString(raw.updatedAt);
  const rosterFingerprint = nonEmptyString(evidence.rosterFingerprint);
  const rawRosterFingerprint = nonEmptyString(raw.launchRosterFingerprint);
  const rawTeamName = nonEmptyString(raw.teamName);
  const terminalStatus = terminal?.status;
  const terminalEvidenceId = nonEmptyString(terminal?.continuationEvidenceId);
  const rawMembers = Array.isArray(evidence.members) ? evidence.members : null;
  if (evidence.version !== 1 || raw.version !== 1) {
    return { kind: 'invalid', reason: 'the continuation proof version is unsupported' };
  }
  if (!sourceRunId || sourceRunId !== rawRunId) {
    return { kind: 'invalid', reason: 'the continuation proof has a stale run binding' };
  }
  if (!teamName || teamName !== rawTeamName) {
    return { kind: 'invalid', reason: 'the continuation proof has a stale team binding' };
  }
  if (!evidenceId || terminalEvidenceId !== evidenceId) {
    return { kind: 'invalid', reason: 'the continuation proof has an ambiguous terminal binding' };
  }
  if (!updatedAt || updatedAt !== rawUpdatedAt) {
    return { kind: 'invalid', reason: 'the continuation proof has a stale update binding' };
  }
  if (!rosterFingerprint?.startsWith('sha256:') || rosterFingerprint !== rawRosterFingerprint) {
    return { kind: 'invalid', reason: 'the continuation proof has a stale roster binding' };
  }
  if (terminalStatus !== 'partial_success' && terminalStatus !== 'completed') {
    return { kind: 'invalid', reason: 'the continuation proof has no exact terminal outcome' };
  }
  if (!rawMembers) {
    return { kind: 'invalid', reason: 'the continuation proof has no member outcomes' };
  }
  const members = rawMembers.map(parseMember);
  if (members.some((member) => member === null)) {
    return { kind: 'invalid', reason: 'a continuation member outcome is unknown or malformed' };
  }
  const bootstrapMembers = Array.isArray(raw.members)
    ? raw.members.flatMap((member) => {
        if (!member || typeof member !== 'object' || Array.isArray(member)) return [];
        const record = member as Record<string, unknown>;
        const name = nonEmptyString(record.name);
        const status = nonEmptyString(record.status);
        return name && status ? [{ name, status }] : [];
      })
    : [];
  const outcomeByName = new Map(
    (members as DurableLaunchContinuationMemberEvidence[]).map((member) => [
      member.name,
      member.outcome,
    ])
  );
  if (
    bootstrapMembers.length !== members.length ||
    new Set(bootstrapMembers.map((member) => member.name)).size !== bootstrapMembers.length ||
    bootstrapMembers.some((member) => outcomeByName.get(member.name) !== member.status)
  ) {
    return {
      kind: 'invalid',
      reason: 'continuation evidence conflicts with the durable bootstrap member outcomes',
    };
  }
  return {
    kind: 'evidence',
    evidence: {
      version: 1,
      sourceRunId,
      teamName,
      evidenceId,
      updatedAt,
      rosterFingerprint: rosterFingerprint as `sha256:${string}`,
      terminalStatus,
      members: members as DurableLaunchContinuationEvidence['members'],
    },
  };
}

export async function readDurableLaunchContinuationEvidence(
  teamName: string
): Promise<DurableLaunchContinuationEvidenceRead> {
  const file = await readContinuationStateFile(teamName);
  if (file.kind !== 'raw') return file;
  let raw: unknown;
  try {
    raw = JSON.parse(file.raw) as unknown;
  } catch {
    return { kind: 'invalid', reason: 'bootstrap continuation state is unreadable' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'invalid', reason: 'bootstrap continuation state is malformed' };
  }
  const record = raw as Record<string, unknown>;
  if (record.launchRosterFingerprint === undefined && record.launchContinuation === undefined) {
    return { kind: 'absent' };
  }
  return parseMarkedState(record);
}
