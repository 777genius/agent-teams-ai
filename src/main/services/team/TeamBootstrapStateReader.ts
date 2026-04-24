import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { createPersistedLaunchSnapshot } from './TeamLaunchStateEvaluator';

import type {
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  TeamProvisioningProgress,
  TeamRuntimeState,
} from '@shared/types';

const TEAM_BOOTSTRAP_STATE_FILE = 'bootstrap-state.json';
const TEAM_BOOTSTRAP_JOURNAL_FILE = 'bootstrap-journal.jsonl';
const TEAM_BOOTSTRAP_LOCK_DIR = '.bootstrap.lock';
const TEAM_BOOTSTRAP_LOCK_METADATA_FILE = 'metadata.json';
const MAX_BOOTSTRAP_STATE_BYTES = 256 * 1024;
const MAX_BOOTSTRAP_JOURNAL_BYTES = 256 * 1024;
const MAX_BOOTSTRAP_LOCK_METADATA_BYTES = 64 * 1024;
const ACTIVE_BOOTSTRAP_STUCK_CLASSIFICATION_MS = 3 * 60 * 1000;
const TERMINAL_BOOTSTRAP_ONLY_PENDING_GRACE_MS = 5 * 60 * 1000;

interface RawBootstrapMemberState {
  name?: unknown;
  status?: unknown;
  lastAttemptAt?: unknown;
  lastObservedAt?: unknown;
  failureReason?: unknown;
}

interface RawBootstrapState {
  version?: unknown;
  runId?: unknown;
  teamName?: unknown;
  startedAt?: unknown;
  ownerPid?: unknown;
  updatedAt?: unknown;
  phase?: unknown;
  realTaskSubmissionState?: unknown;
  members?: unknown;
  terminal?: unknown;
}

type RawBootstrapJournalRecord =
  | { ts?: unknown; type?: 'phase'; phase?: unknown }
  | { ts?: unknown; type?: 'lock'; action?: unknown; ownerPid?: unknown; detail?: unknown }
  | { ts?: unknown; type?: 'member'; name?: unknown; action?: unknown; detail?: unknown }
  | { ts?: unknown; type?: 'terminal'; status?: unknown; reason?: unknown }
  | { ts?: unknown; type?: 'real_task'; state?: unknown; detail?: unknown };

interface RawBootstrapLockMetadata {
  pid?: unknown;
  runId?: unknown;
  requestHash?: unknown;
  ownerStartedAt?: unknown;
  createdAt?: unknown;
  nonce?: unknown;
}

interface BootstrapStateInspection {
  raw: RawBootstrapState | null;
  issue?: string;
}

interface BootstrapJournalInspection {
  warnings?: string[];
  issue?: string;
  lastPhase?: BootstrapRuntimePhase;
}

interface BootstrapLockMetadata {
  pid: number;
  runId: string;
  ownerStartedAt?: number;
}

type BootstrapRuntimePhase =
  | 'validating_spec'
  | 'loading_existing_state'
  | 'acquiring_bootstrap_lock'
  | 'creating_team'
  | 'spawning_members'
  | 'auditing_truth'
  | 'completed'
  | 'failed'
  | 'canceled';

interface ComparableStat {
  dev?: number;
  ino?: number;
  size: number;
  mode?: number;
  mtimeMs?: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function sameFiniteNumber(a: unknown, b: unknown): boolean {
  return isFiniteNumber(a) && isFiniteNumber(b) && a === b;
}

function didValidatedFileChange(expected: ComparableStat, actual: ComparableStat): boolean {
  const comparableIdentity =
    isFiniteNumber(expected.dev) &&
    isFiniteNumber(actual.dev) &&
    isFiniteNumber(expected.ino) &&
    isFiniteNumber(actual.ino);
  if (comparableIdentity) {
    return expected.dev !== actual.dev || expected.ino !== actual.ino;
  }

  if (sameFiniteNumber(expected.dev, actual.dev) && sameFiniteNumber(expected.ino, actual.ino)) {
    return false;
  }

  return (
    expected.size !== actual.size ||
    expected.mode !== actual.mode ||
    expected.mtimeMs !== actual.mtimeMs
  );
}

async function readBoundRegularUtf8File(
  targetPath: string,
  maxBytes: number,
  messages: {
    notRegular: string;
    oversized: string;
    invalid: string;
  }
): Promise<{ contents: string } | { issue: string } | null> {
  try {
    const validated = await fs.promises.lstat(targetPath);
    if (validated.isSymbolicLink() || !validated.isFile()) {
      return { issue: messages.notRegular };
    }
    if (validated.size > maxBytes) {
      return { issue: messages.oversized };
    }

    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(targetPath, 'r');
    } catch {
      return { issue: messages.invalid };
    }
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || didValidatedFileChange(validated, opened)) {
        return { issue: messages.invalid };
      }
      if (opened.size > maxBytes) {
        return { issue: messages.oversized };
      }
      return {
        contents: await handle.readFile({ encoding: 'utf8' }),
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return null;
    }
    return { issue: messages.invalid };
  }
}

function isBootstrapPhaseTerminal(phase: BootstrapRuntimePhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'canceled';
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'EPERM';
  }
}

function classifyBootstrapOwnerState(raw: RawBootstrapState): {
  ownerDead: boolean;
  stale: boolean;
  failureReason?: string;
} {
  const phase = typeof raw.phase === 'string' ? (raw.phase as BootstrapRuntimePhase) : null;
  if (!phase || isBootstrapPhaseTerminal(phase)) {
    return { ownerDead: false, stale: false };
  }

  const ownerPid = typeof raw.ownerPid === 'number' ? raw.ownerPid : null;
  if (ownerPid === null || isProcessAlive(ownerPid)) {
    return { ownerDead: false, stale: false };
  }

  const updatedAtMs =
    typeof raw.updatedAt === 'number'
      ? raw.updatedAt
      : typeof raw.updatedAt === 'string'
        ? Date.parse(raw.updatedAt)
        : NaN;
  const stale =
    Number.isFinite(updatedAtMs) &&
    Date.now() - updatedAtMs >= ACTIVE_BOOTSTRAP_STUCK_CLASSIFICATION_MS;

  return {
    ownerDead: true,
    stale,
    failureReason: stale
      ? `bootstrap owner pid ${ownerPid} is gone and persisted bootstrap state is stale`
      : `bootstrap owner pid ${ownerPid} is gone before bootstrap reached a terminal state`,
  };
}

async function inspectBootstrapState(teamName: string): Promise<BootstrapStateInspection> {
  const targetPath = getTeamBootstrapStatePath(teamName);
  const file = await readBoundRegularUtf8File(targetPath, MAX_BOOTSTRAP_STATE_BYTES, {
    notRegular:
      'Persisted deterministic bootstrap state is unreadable because bootstrap-state.json is a symlink or not a regular file.',
    oversized:
      'Persisted deterministic bootstrap state is unreadable because bootstrap-state.json is oversized.',
    invalid:
      'Persisted deterministic bootstrap state is unreadable because bootstrap-state.json is invalid, truncated, inaccessible, or changed while being read.',
  });
  if (!file) {
    return { raw: null };
  }
  if ('issue' in file) {
    return {
      raw: null,
      issue: file.issue,
    };
  }
  try {
    const raw = JSON.parse(file.contents) as RawBootstrapState;
    if (raw.version !== 1) {
      return {
        raw: null,
        issue:
          'Persisted deterministic bootstrap state is unreadable because bootstrap-state.json has an unsupported schema version.',
      };
    }
    return { raw };
  } catch {
    return {
      raw: null,
      issue:
        'Persisted deterministic bootstrap state is unreadable because bootstrap-state.json is invalid, truncated, inaccessible, or changed while being read.',
    };
  }
}

async function readRawBootstrapState(teamName: string): Promise<RawBootstrapState | null> {
  return (await inspectBootstrapState(teamName)).raw;
}

function getBootstrapProgressProjection(
  phase: BootstrapRuntimePhase,
  memberCount: number
): { state: Exclude<TeamProvisioningProgress['state'], 'idle'>; message: string } | null {
  switch (phase) {
    case 'validating_spec':
      return {
        state: 'validating',
        message: 'Validating deterministic bootstrap spec',
      };
    case 'loading_existing_state':
      return {
        state: 'configuring',
        message: 'Loading existing team state',
      };
    case 'acquiring_bootstrap_lock':
      return {
        state: 'configuring',
        message: 'Acquiring deterministic bootstrap lock',
      };
    case 'creating_team':
      return {
        state: 'assembling',
        message: 'Creating team config',
      };
    case 'spawning_members':
      return {
        state: 'assembling',
        message:
          memberCount > 0
            ? `Spawning teammate runtimes (${memberCount})`
            : 'Spawning teammate runtimes',
      };
    case 'auditing_truth':
      return {
        state: 'finalizing',
        message: 'Auditing registered teammates and bootstrap truth',
      };
    case 'completed':
      return {
        state: 'ready',
        message: 'Deterministic bootstrap completed',
      };
    case 'failed':
      return {
        state: 'failed',
        message: 'Deterministic bootstrap failed',
      };
    case 'canceled':
      return {
        state: 'cancelled',
        message: 'Deterministic bootstrap cancelled',
      };
    default:
      return null;
  }
}

function toIso(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  return fallback;
}

function normalizeBootstrapMemberState(
  memberName: string,
  raw: RawBootstrapMemberState,
  updatedAt: string
): PersistedTeamLaunchMemberState {
  const status = typeof raw.status === 'string' ? raw.status : 'pending';
  const hardFailure = status === 'failed';
  const bootstrapConfirmed = status === 'bootstrap_confirmed';
  const bootstrapReportedRuntimeAlive = status === 'runtime_alive';
  const runtimeAlive = bootstrapConfirmed;
  const agentToolAccepted =
    bootstrapConfirmed ||
    bootstrapReportedRuntimeAlive ||
    status === 'registered' ||
    status === 'spawn_started' ||
    hardFailure;

  return {
    name: memberName,
    launchState: hardFailure
      ? 'failed_to_start'
      : bootstrapConfirmed
        ? 'confirmed_alive'
        : agentToolAccepted
          ? 'runtime_pending_bootstrap'
          : 'starting',
    agentToolAccepted,
    runtimeAlive,
    bootstrapConfirmed,
    hardFailure,
    hardFailureReason:
      typeof raw.failureReason === 'string' && raw.failureReason.trim().length > 0
        ? raw.failureReason.trim()
        : undefined,
    firstSpawnAcceptedAt: agentToolAccepted ? toIso(raw.lastAttemptAt, updatedAt) : undefined,
    lastHeartbeatAt: bootstrapConfirmed ? toIso(raw.lastObservedAt, updatedAt) : undefined,
    lastRuntimeAliveAt: runtimeAlive ? toIso(raw.lastObservedAt, updatedAt) : undefined,
    lastEvaluatedAt: toIso(raw.lastObservedAt, updatedAt),
    sources: {
      configRegistered:
        status === 'registered' ||
        status === 'runtime_alive' ||
        status === 'bootstrap_confirmed' ||
        hardFailure,
      processAlive: runtimeAlive || undefined,
      hardFailureSignal: hardFailure || undefined,
    },
    diagnostics: hardFailure
      ? [
          typeof raw.failureReason === 'string' && raw.failureReason.trim().length > 0
            ? raw.failureReason.trim()
            : 'deterministic bootstrap failed',
        ]
      : bootstrapConfirmed
        ? ['late heartbeat received']
        : bootstrapReportedRuntimeAlive
          ? ['runtime alive reported by bootstrap state', 'waiting for strict live verification']
          : agentToolAccepted
            ? ['spawn accepted']
            : undefined,
  };
}

export function getTeamBootstrapStatePath(teamName: string): string {
  return path.join(getTeamsBasePath(), teamName, TEAM_BOOTSTRAP_STATE_FILE);
}

function getTeamBootstrapJournalPath(teamName: string): string {
  return path.join(getTeamsBasePath(), teamName, TEAM_BOOTSTRAP_JOURNAL_FILE);
}

function getTeamBootstrapLockMetadataPath(teamName: string): string {
  return path.join(
    getTeamsBasePath(),
    teamName,
    TEAM_BOOTSTRAP_LOCK_DIR,
    TEAM_BOOTSTRAP_LOCK_METADATA_FILE
  );
}

async function readBootstrapLockMetadata(teamName: string): Promise<BootstrapLockMetadata | null> {
  const targetPath = getTeamBootstrapLockMetadataPath(teamName);
  const file = await readBoundRegularUtf8File(targetPath, MAX_BOOTSTRAP_LOCK_METADATA_BYTES, {
    notRegular: '',
    oversized: '',
    invalid: '',
  });
  if (!file || 'issue' in file) {
    return null;
  }
  try {
    const raw = JSON.parse(file.contents) as RawBootstrapLockMetadata;
    if (
      typeof raw.pid !== 'number' ||
      !Number.isFinite(raw.pid) ||
      raw.pid <= 0 ||
      typeof raw.runId !== 'string' ||
      raw.runId.trim().length === 0
    ) {
      return null;
    }
    return {
      pid: raw.pid,
      runId: raw.runId.trim(),
      ownerStartedAt:
        typeof raw.ownerStartedAt === 'number' && Number.isFinite(raw.ownerStartedAt)
          ? raw.ownerStartedAt
          : undefined,
    };
  } catch {
    return null;
  }
}

async function readBootstrapJournalWarnings(teamName: string): Promise<string[] | undefined> {
  const inspection = await inspectBootstrapJournal(teamName);
  const warnings = [inspection.issue, ...(inspection.warnings ?? [])].filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0
  );
  return warnings.length > 0 ? warnings : undefined;
}

async function inspectBootstrapJournal(teamName: string): Promise<BootstrapJournalInspection> {
  const targetPath = getTeamBootstrapJournalPath(teamName);
  const file = await readBoundRegularUtf8File(targetPath, MAX_BOOTSTRAP_JOURNAL_BYTES, {
    notRegular:
      'Persisted deterministic bootstrap journal is unreadable because bootstrap-journal.jsonl is a symlink or not a regular file.',
    oversized:
      'Persisted deterministic bootstrap journal is unreadable because bootstrap-journal.jsonl is oversized.',
    invalid:
      'Persisted deterministic bootstrap journal is unreadable because bootstrap-journal.jsonl is invalid, truncated, inaccessible, or changed while being read.',
  });
  if (!file) {
    return {};
  }
  if ('issue' in file) {
    return {
      issue: file.issue,
    };
  }
  try {
    const raw = file.contents;
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-3);

    const records = lines
      .map((line) => {
        try {
          return JSON.parse(line) as RawBootstrapJournalRecord;
        } catch {
          return null;
        }
      })
      .filter((record): record is RawBootstrapJournalRecord => Boolean(record));

    const messages = records
      .map((record) => {
        if (record.type === 'phase' && typeof record.phase === 'string') {
          return `bootstrap phase: ${record.phase}`;
        }
        if (record.type === 'lock' && typeof record.action === 'string') {
          const owner = typeof record.ownerPid === 'number' ? ` (pid ${record.ownerPid})` : '';
          return `bootstrap lock ${record.action}${owner}`;
        }
        if (
          record.type === 'member' &&
          typeof record.name === 'string' &&
          typeof record.action === 'string'
        ) {
          return typeof record.detail === 'string' && record.detail.trim().length > 0
            ? `${record.name}: ${record.action} (${record.detail.trim()})`
            : `${record.name}: ${record.action}`;
        }
        if (record.type === 'terminal' && typeof record.status === 'string') {
          return typeof record.reason === 'string' && record.reason.trim().length > 0
            ? `bootstrap ${record.status}: ${record.reason.trim()}`
            : `bootstrap ${record.status}`;
        }
        if (record.type === 'real_task' && typeof record.state === 'string') {
          return typeof record.detail === 'string' && record.detail.trim().length > 0
            ? `first task ${record.state}: ${record.detail.trim()}`
            : `first task ${record.state}`;
        }
        return null;
      })
      .filter((item): item is string => Boolean(item));

    if (lines.length > 0 && messages.length === 0) {
      return {
        issue:
          'Persisted deterministic bootstrap journal is unreadable because bootstrap-journal.jsonl is invalid, truncated, inaccessible, or changed while being read.',
      };
    }

    const lastPhaseRecord = [...records]
      .reverse()
      .find(
        (record): record is Extract<RawBootstrapJournalRecord, { type?: 'phase' }> =>
          record.type === 'phase' && typeof record.phase === 'string'
      );

    return {
      ...(lastPhaseRecord?.phase
        ? { lastPhase: lastPhaseRecord.phase as BootstrapRuntimePhase }
        : {}),
      warnings:
        messages.length > 0
          ? [`Recent deterministic bootstrap events: ${messages.join(' | ')}`]
          : undefined,
    };
  } catch {
    return {
      issue:
        'Persisted deterministic bootstrap journal is unreadable because bootstrap-journal.jsonl is invalid, truncated, inaccessible, or changed while being read.',
    };
  }
}

async function readDegradedBootstrapRuntimeState(
  teamName: string,
  stateIssue: string
): Promise<TeamRuntimeState | null> {
  const lockMetadata = await readBootstrapLockMetadata(teamName);
  if (!lockMetadata) {
    return null;
  }

  const journalInspection = await inspectBootstrapJournal(teamName);
  const warnings = [
    stateIssue,
    journalInspection.issue,
    ...(journalInspection.warnings ?? []),
  ].filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  const ownerAlive = isProcessAlive(lockMetadata.pid);
  const now = new Date().toISOString();
  const degradedProjection =
    ownerAlive && journalInspection.lastPhase
      ? getBootstrapProgressProjection(journalInspection.lastPhase, 0)
      : null;
  const projectedState =
    degradedProjection &&
    degradedProjection.state !== 'ready' &&
    degradedProjection.state !== 'failed' &&
    degradedProjection.state !== 'cancelled'
      ? degradedProjection.state
      : 'configuring';
  const projectedMessage =
    degradedProjection &&
    degradedProjection.state !== 'ready' &&
    degradedProjection.state !== 'failed' &&
    degradedProjection.state !== 'cancelled'
      ? `${degradedProjection.message} (degraded recovery)`
      : 'Deterministic bootstrap recovery is degraded because persisted bootstrap state is unreadable';

  return {
    teamName,
    isAlive: false,
    runId: lockMetadata.runId,
    progress: {
      runId: lockMetadata.runId,
      teamName,
      state: ownerAlive ? projectedState : 'failed',
      message: ownerAlive
        ? projectedMessage
        : 'Deterministic bootstrap recovery failed because persisted bootstrap state is unreadable and the bootstrap owner is gone',
      messageSeverity: 'warning',
      error: ownerAlive
        ? stateIssue
        : `${stateIssue} Bootstrap owner pid ${lockMetadata.pid} is not alive.`,
      warnings: warnings.length > 0 ? warnings : undefined,
      startedAt:
        typeof lockMetadata.ownerStartedAt === 'number' &&
        Number.isFinite(lockMetadata.ownerStartedAt)
          ? new Date(lockMetadata.ownerStartedAt).toISOString()
          : now,
      updatedAt: now,
      pid: lockMetadata.pid,
    },
  };
}

export async function readBootstrapLaunchSnapshot(
  teamName: string
): Promise<PersistedTeamLaunchSnapshot | null> {
  const raw = await readRawBootstrapState(teamName);
  if (!raw) {
    return null;
  }
  try {
    const updatedAt = toIso(raw.updatedAt, new Date().toISOString());
    const rawMembers = Array.isArray(raw.members) ? raw.members : [];
    const members: Record<string, PersistedTeamLaunchMemberState> = {};
    const expectedMembers: string[] = [];

    for (const item of rawMembers) {
      if (!item || typeof item !== 'object') continue;
      const rawMember = item as RawBootstrapMemberState;
      const memberName = typeof rawMember.name === 'string' ? rawMember.name.trim() : '';
      if (!memberName || memberName === 'team-lead' || memberName === 'user') continue;
      expectedMembers.push(memberName);
      members[memberName] = normalizeBootstrapMemberState(memberName, rawMember, updatedAt);
    }

    const terminal =
      raw.terminal && typeof raw.terminal === 'object'
        ? (raw.terminal as Record<string, unknown>)
        : null;
    const terminalStatus = typeof terminal?.status === 'string' ? terminal.status : undefined;
    const phase = typeof raw.phase === 'string' ? raw.phase : undefined;
    const ownerState = classifyBootstrapOwnerState(raw);
    const launchPhase =
      terminalStatus === 'completed' ||
      terminalStatus === 'partial_success' ||
      terminalStatus === 'failed' ||
      terminalStatus === 'canceled' ||
      ownerState.ownerDead ||
      phase === 'completed' ||
      phase === 'failed' ||
      phase === 'canceled'
        ? 'finished'
        : 'active';

    if (ownerState.ownerDead) {
      const diagnostics = ownerState.failureReason ? [ownerState.failureReason] : undefined;
      for (const memberName of expectedMembers) {
        const entry = members[memberName];
        if (
          !entry ||
          entry.launchState === 'confirmed_alive' ||
          entry.launchState === 'failed_to_start'
        ) {
          continue;
        }
        members[memberName] = {
          ...entry,
          launchState: 'failed_to_start',
          hardFailure: true,
          hardFailureReason: ownerState.failureReason,
          diagnostics: diagnostics ?? entry.diagnostics,
          sources: {
            ...entry.sources,
            hardFailureSignal: true,
          },
        };
      }
    }

    return createPersistedLaunchSnapshot({
      teamName:
        typeof raw.teamName === 'string' && raw.teamName.trim().length > 0
          ? raw.teamName.trim()
          : teamName,
      expectedMembers,
      launchPhase,
      members,
      updatedAt,
    });
  } catch {
    return null;
  }
}

export async function readBootstrapRealTaskSubmissionState(
  teamName: string
): Promise<'not_submitted' | 'submitted' | 'unknown' | null> {
  const raw = await readRawBootstrapState(teamName);
  if (!raw) {
    return null;
  }
  const state = raw.realTaskSubmissionState;
  return state === 'not_submitted' || state === 'submitted' || state === 'unknown' ? state : null;
}

export async function readBootstrapRuntimeState(
  teamName: string
): Promise<TeamRuntimeState | null> {
  const inspection = await inspectBootstrapState(teamName);
  const raw = inspection.raw;
  if (!raw) {
    return inspection.issue ? readDegradedBootstrapRuntimeState(teamName, inspection.issue) : null;
  }

  try {
    const journalWarnings = await readBootstrapJournalWarnings(teamName);
    const phase = typeof raw.phase === 'string' ? (raw.phase as BootstrapRuntimePhase) : null;
    if (!phase) {
      return null;
    }
    const ownerState = classifyBootstrapOwnerState(raw);
    if (ownerState.ownerDead) {
      const startedAt = toIso(raw.startedAt, new Date().toISOString());
      const updatedAt = toIso(raw.updatedAt, startedAt);
      return {
        teamName:
          typeof raw.teamName === 'string' && raw.teamName.trim().length > 0
            ? raw.teamName.trim()
            : teamName,
        isAlive: false,
        runId: typeof raw.runId === 'string' ? raw.runId : null,
        progress: {
          runId: typeof raw.runId === 'string' ? raw.runId : teamName,
          teamName:
            typeof raw.teamName === 'string' && raw.teamName.trim().length > 0
              ? raw.teamName.trim()
              : teamName,
          state: 'failed',
          message: ownerState.stale
            ? 'Deterministic bootstrap became stuck after owner process exited'
            : 'Deterministic bootstrap owner exited before bootstrap completed',
          error: ownerState.failureReason,
          warnings: journalWarnings,
          startedAt,
          updatedAt,
          ...(typeof raw.ownerPid === 'number' ? { pid: raw.ownerPid } : {}),
        },
      };
    }
    const activePhases: BootstrapRuntimePhase[] = [
      'validating_spec',
      'loading_existing_state',
      'acquiring_bootstrap_lock',
      'creating_team',
      'spawning_members',
      'auditing_truth',
    ];
    if (!activePhases.includes(phase)) {
      return null;
    }
    const projection = getBootstrapProgressProjection(
      phase,
      Array.isArray(raw.members) ? raw.members.length : 0
    );
    if (!projection) {
      return null;
    }

    const startedAt = toIso(raw.startedAt, new Date().toISOString());
    const updatedAt = toIso(raw.updatedAt, startedAt);
    const runId = typeof raw.runId === 'string' && raw.runId.trim().length > 0 ? raw.runId : null;
    const pid =
      typeof raw.ownerPid === 'number' && Number.isFinite(raw.ownerPid) && raw.ownerPid > 0
        ? raw.ownerPid
        : undefined;

    const progress: TeamProvisioningProgress = {
      runId: runId ?? `bootstrap:${teamName}`,
      teamName:
        typeof raw.teamName === 'string' && raw.teamName.trim().length > 0
          ? raw.teamName.trim()
          : teamName,
      state: projection.state,
      message: projection.message,
      warnings: journalWarnings,
      startedAt,
      updatedAt,
      ...(pid ? { pid } : {}),
    };

    return {
      teamName:
        typeof raw.teamName === 'string' && raw.teamName.trim().length > 0
          ? raw.teamName.trim()
          : teamName,
      isAlive: false,
      runId,
      progress,
    };
  } catch {
    return null;
  }
}

export async function clearBootstrapState(teamName: string): Promise<void> {
  try {
    await fs.promises.rm(getTeamBootstrapStatePath(teamName), { force: true });
  } catch {
    // best-effort
  }
}

function isLaunchSnapshotLike(value: unknown): value is PersistedTeamLaunchSnapshot {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    Array.isArray((value as PersistedTeamLaunchSnapshot).expectedMembers) &&
    typeof (value as PersistedTeamLaunchSnapshot).members === 'object' &&
    (value as PersistedTeamLaunchSnapshot).members !== null
  );
}

function getLaunchSnapshotRichness(snapshot: PersistedTeamLaunchSnapshot): number {
  const persistedMemberCount = getPersistedLaunchMemberNames(snapshot).length;
  let metadataScore = 0;
  for (const member of Object.values(snapshot.members)) {
    if (!member || typeof member !== 'object') continue;
    if (member.providerId) metadataScore += 3;
    if (member.providerBackendId) metadataScore += 3;
    if (member.selectedFastMode) metadataScore += 2;
    if (typeof member.resolvedFastMode === 'boolean') metadataScore += 2;
    if (member.laneId) metadataScore += 4;
    if (member.laneKind) metadataScore += 4;
    if (member.laneOwnerProviderId) metadataScore += 3;
    if (member.launchIdentity) metadataScore += 6;
  }
  return (
    persistedMemberCount * 10 +
    Object.keys(snapshot.members).length * 5 +
    metadataScore +
    (snapshot.bootstrapExpectedMembers?.length ? 20 : 0)
  );
}

function getPersistedLaunchMemberNames(snapshot: PersistedTeamLaunchSnapshot): string[] {
  return Array.from(new Set([...snapshot.expectedMembers, ...Object.keys(snapshot.members)]));
}

export function shouldIgnoreTerminalBootstrapOnlyPendingSnapshot(
  snapshot: Pick<PersistedTeamLaunchSnapshot, 'launchPhase' | 'teamLaunchState' | 'updatedAt'>,
  nowMs: number = Date.now()
): boolean {
  if (snapshot.launchPhase !== 'finished' || snapshot.teamLaunchState !== 'partial_pending') {
    return false;
  }

  const updatedAtMs = Date.parse(snapshot.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return false;
  }

  return nowMs - updatedAtMs >= TERMINAL_BOOTSTRAP_ONLY_PENDING_GRACE_MS;
}

export function choosePreferredLaunchSnapshot<T extends { updatedAt?: string }>(
  bootstrapSnapshot: T | null,
  launchSnapshot: T | null
): T | null {
  if (!bootstrapSnapshot) return launchSnapshot;
  if (
    !launchSnapshot &&
    isLaunchSnapshotLike(bootstrapSnapshot) &&
    shouldIgnoreTerminalBootstrapOnlyPendingSnapshot(bootstrapSnapshot)
  ) {
    return null;
  }
  if (!launchSnapshot) return bootstrapSnapshot;

  if (isLaunchSnapshotLike(bootstrapSnapshot) && isLaunchSnapshotLike(launchSnapshot)) {
    const bootstrapRichness = getLaunchSnapshotRichness(bootstrapSnapshot);
    const launchRichness = getLaunchSnapshotRichness(launchSnapshot);
    const bootstrapMemberCount = getPersistedLaunchMemberNames(bootstrapSnapshot).length;
    const launchMemberCount = getPersistedLaunchMemberNames(launchSnapshot).length;
    if (launchRichness > bootstrapRichness && launchMemberCount >= bootstrapMemberCount) {
      return launchSnapshot as T;
    }
    if (bootstrapRichness > launchRichness && bootstrapMemberCount >= launchMemberCount) {
      return bootstrapSnapshot as T;
    }
  }

  const bootstrapMs = Date.parse(bootstrapSnapshot.updatedAt ?? '');
  const launchMs = Date.parse(launchSnapshot.updatedAt ?? '');
  if (Number.isFinite(bootstrapMs) && Number.isFinite(launchMs)) {
    return bootstrapMs >= launchMs ? bootstrapSnapshot : launchSnapshot;
  }
  return bootstrapSnapshot;
}
