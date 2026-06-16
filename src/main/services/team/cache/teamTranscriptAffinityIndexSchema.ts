import {
  type PersistedTeamTranscriptAffinityEntry,
  type PersistedTeamTranscriptAffinityIndex,
  TEAM_TRANSCRIPT_AFFINITY_INDEX_SCHEMA_VERSION,
  type TeamTranscriptAffinityFileSignature,
  type TeamTranscriptAffinityMatchSource,
  type TeamTranscriptAffinityVerdict,
} from './teamTranscriptAffinityIndexTypes';

function isIsoString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isValidFileName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > '.jsonl'.length &&
    value.endsWith('.jsonl') &&
    !value.includes('/') &&
    !value.includes('\\')
  );
}

function sessionIdFromFileName(fileName: string): string {
  return fileName.slice(0, -'.jsonl'.length);
}

function normalizeVerdict(value: unknown): TeamTranscriptAffinityVerdict | null {
  return value === 'belongs' || value === 'does_not_belong' ? value : null;
}

function normalizeMatchSource(value: unknown): TeamTranscriptAffinityMatchSource | null {
  return value === 'nested_team_name' || value === 'text_team_mention' || value === 'none'
    ? value
    : null;
}

function normalizeSignature(value: unknown): TeamTranscriptAffinityFileSignature | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const raw = value as Record<string, unknown>;
  if (!isFiniteNonNegativeNumber(raw.size) || !isFiniteNonNegativeNumber(raw.mtimeMs)) {
    return null;
  }
  if (raw.ctimeMs != null && !isFiniteNonNegativeNumber(raw.ctimeMs)) {
    return null;
  }

  return {
    size: raw.size,
    mtimeMs: raw.mtimeMs,
    ...(raw.ctimeMs != null ? { ctimeMs: raw.ctimeMs } : {}),
  };
}

export function normalizeTeamTranscriptAffinityEntry(
  fileName: string,
  value: unknown
): PersistedTeamTranscriptAffinityEntry | null {
  if (!isValidFileName(fileName) || !value || typeof value !== 'object') {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const verdict = normalizeVerdict(raw.verdict);
  const signature = normalizeSignature(raw.signature);
  const matchSource = normalizeMatchSource(raw.matchSource);
  const expectedSessionId = sessionIdFromFileName(fileName);

  if (
    raw.fileName !== fileName ||
    raw.sessionId !== expectedSessionId ||
    !signature ||
    !verdict ||
    typeof raw.headWindowFull !== 'boolean' ||
    !Number.isInteger(raw.inspectedLineCount) ||
    !isFiniteNonNegativeNumber(raw.inspectedLineCount) ||
    !matchSource ||
    !isIsoString(raw.writtenAt)
  ) {
    return null;
  }

  return {
    fileName,
    sessionId: expectedSessionId,
    signature,
    verdict,
    headWindowFull: raw.headWindowFull,
    inspectedLineCount: raw.inspectedLineCount,
    matchSource,
    writtenAt: raw.writtenAt,
  };
}

export function normalizeTeamTranscriptAffinityIndex(
  value: unknown
): PersistedTeamTranscriptAffinityIndex | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const raw = value as Record<string, unknown>;
  if (
    raw.version !== TEAM_TRANSCRIPT_AFFINITY_INDEX_SCHEMA_VERSION ||
    typeof raw.teamName !== 'string' ||
    raw.teamName.length === 0 ||
    typeof raw.projectId !== 'string' ||
    raw.projectId.length === 0 ||
    typeof raw.projectDir !== 'string' ||
    raw.projectDir.length === 0 ||
    !isIsoString(raw.writtenAt) ||
    !raw.entries ||
    typeof raw.entries !== 'object'
  ) {
    return null;
  }

  const entries: Record<string, PersistedTeamTranscriptAffinityEntry> = {};
  for (const [fileName, entry] of Object.entries(raw.entries as Record<string, unknown>)) {
    const normalized = normalizeTeamTranscriptAffinityEntry(fileName, entry);
    if (normalized) {
      entries[fileName] = normalized;
    }
  }

  return {
    version: TEAM_TRANSCRIPT_AFFINITY_INDEX_SCHEMA_VERSION,
    teamName: raw.teamName,
    projectId: raw.projectId,
    projectDir: raw.projectDir,
    writtenAt: raw.writtenAt,
    entries,
  };
}

export function toTeamTranscriptAffinityIndex(
  value: PersistedTeamTranscriptAffinityIndex
): PersistedTeamTranscriptAffinityIndex {
  const entries: Record<string, PersistedTeamTranscriptAffinityEntry> = {};
  for (const [fileName, entry] of Object.entries(value.entries)) {
    const normalized = normalizeTeamTranscriptAffinityEntry(fileName, entry);
    if (normalized) {
      entries[fileName] = normalized;
    }
  }

  return {
    version: TEAM_TRANSCRIPT_AFFINITY_INDEX_SCHEMA_VERSION,
    teamName: value.teamName,
    projectId: value.projectId,
    projectDir: value.projectDir,
    writtenAt: value.writtenAt,
    entries,
  };
}
