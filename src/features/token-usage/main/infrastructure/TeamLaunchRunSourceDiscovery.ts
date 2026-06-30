import { encodePath, getProjectsBasePath } from '@main/utils/pathDecoder';
import {
  inferProviderBillingMode,
  normalizeProviderBillingMode,
} from '@shared/utils/providerBillingMode';
import { createHash } from 'crypto';
import { readdir, readFile, stat } from 'fs/promises';
import path from 'path';

import type {
  TokenUsageBillingMode,
  TokenUsageRunDto,
  TokenUsageRuntimeKind,
} from '../../contracts';
import type { TokenUsageRunSourceDiscoveryPort } from '../../core/application';
import type {
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  TeamConfig,
  TeamMember,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';

const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_LAUNCH_STATE_BYTES = 512 * 1024;
const MAX_TEAM_META_BYTES = 256 * 1024;
const MAX_RUNTIME_TRACE_BYTES = 2 * 1024 * 1024;

type UnknownRecord = Record<string, unknown>;

interface TeamLaunchIdentityMetadata {
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  billingMode?: TokenUsageBillingMode;
  selectedModel?: string;
  resolvedLaunchModel?: string;
  catalogId?: string;
}

interface TeamMetadata {
  providerId?: TeamProviderId;
  providerBackendId?: TeamProviderBackendId;
  billingMode?: TokenUsageBillingMode;
  model?: string;
  createdAt?: string;
  launchIdentity?: TeamLaunchIdentityMetadata;
}

interface DiscoveredTeamMember extends TeamMember {
  isActive?: boolean;
  runtimePid?: number;
}

interface DiscoveredTeamConfig extends TeamConfig {
  createdAt?: string;
  configUpdatedAt?: string;
  members?: DiscoveredTeamMember[];
}

interface RuntimeSessionRecord {
  agentName: string;
  agentId?: string;
  runId: string;
  cwd?: string;
  startedAt: string;
  lastSeenAt: string;
}

export class TeamLaunchRunSourceDiscovery implements TokenUsageRunSourceDiscoveryPort {
  constructor(private readonly teamsBasePath: string) {}

  async discoverAppRuns(): Promise<TokenUsageRunDto[]> {
    const entries = await readdir(this.teamsBasePath, { withFileTypes: true }).catch(() => []);
    const runs: TokenUsageRunDto[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const teamName = entry.name;
      const teamDir = path.join(this.teamsBasePath, teamName);
      const [config, launchState, teamMeta] = await Promise.all([
        readTeamConfig(path.join(teamDir, 'config.json')),
        readLaunchState(path.join(teamDir, 'launch-state.json')),
        readTeamMetadata(path.join(teamDir, 'team.meta.json')),
      ]);
      if (config?.deletedAt) continue;
      const runtimeSessions = await readRuntimeSessionRecords(path.join(teamDir, 'runtime'));
      if (!config && !launchState && runtimeSessions.length === 0) continue;
      runs.push(...buildRunsForTeam(teamName, config, launchState, teamMeta, runtimeSessions));
    }
    return runs;
  }
}

async function readTeamConfig(filePath: string): Promise<DiscoveredTeamConfig | null> {
  const configStat = await stat(filePath).catch(() => null);
  const parsed = await readBoundJson(filePath, MAX_CONFIG_BYTES);
  const record = asRecord(parsed);
  const name = readString(record?.name);
  if (!name) return null;
  const members = Array.isArray(record?.members)
    ? record.members.map(normalizeTeamMember).filter((member): member is TeamMember => !!member)
    : undefined;
  return {
    name,
    description: readString(record?.description),
    color: readString(record?.color),
    language: readString(record?.language),
    members,
    projectPath: readString(record?.projectPath),
    projectPathHistory: readStringArray(record?.projectPathHistory),
    leadSessionId: readString(record?.leadSessionId),
    sessionHistory: readStringArray(record?.sessionHistory),
    deletedAt: readString(record?.deletedAt),
    createdAt: readIsoTimestamp(record?.createdAt),
    configUpdatedAt: configStat?.isFile() ? configStat.mtime.toISOString() : undefined,
  };
}

async function readLaunchState(filePath: string): Promise<PersistedTeamLaunchSnapshot | null> {
  const parsed = await readBoundJson(filePath, MAX_LAUNCH_STATE_BYTES);
  const record = asRecord(parsed);
  const teamName = readString(record?.teamName);
  const updatedAt = readString(record?.updatedAt);
  const members = asRecord(record?.members);
  if (!teamName || !updatedAt || !members) return null;
  return parsed as PersistedTeamLaunchSnapshot;
}

async function readTeamMetadata(filePath: string): Promise<TeamMetadata | null> {
  const parsed = await readBoundJson(filePath, MAX_TEAM_META_BYTES);
  const record = asRecord(parsed);
  if (!record) return null;
  return {
    providerId: normalizeProviderId(record.providerId),
    providerBackendId: normalizeProviderBackendId(record.providerBackendId),
    billingMode: normalizeProviderBillingMode(record.billingMode),
    model: readString(record.model),
    createdAt: readIsoTimestamp(record.createdAt),
    launchIdentity: normalizeLaunchIdentity(record.launchIdentity),
  };
}

async function readRuntimeSessionRecords(runtimeDir: string): Promise<RuntimeSessionRecord[]> {
  const entries = await readdir(runtimeDir, { withFileTypes: true }).catch(() => []);
  const records: RuntimeSessionRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.runtime.jsonl')) continue;
    const record = await readRuntimeSessionRecord(path.join(runtimeDir, entry.name));
    if (record) records.push(record);
  }
  return records;
}

async function readRuntimeSessionRecord(filePath: string): Promise<RuntimeSessionRecord | null> {
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile() || fileStat.size > MAX_RUNTIME_TRACE_BYTES) return null;

  let session: RuntimeSessionRecord | null = null;
  let lastSeenAt: string | undefined;
  const lines = (await readFile(filePath, 'utf8')).split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const record = safeParseRuntimeRecord(line);
    if (!record) continue;

    const timestamp = readIsoTimestamp(record.timestamp);
    if (timestamp) {
      lastSeenAt = latestIso([lastSeenAt, timestamp]) ?? timestamp;
    }

    if (session || record.type !== 'cli_started') continue;
    const runId = readString(record.runId);
    const agentName = readString(record.agentName);
    if (!runId || !agentName || !timestamp) continue;

    session = {
      agentName,
      agentId: readString(record.agentId),
      runId,
      cwd: readString(record.cwd),
      startedAt: timestamp,
      lastSeenAt: timestamp,
    };
  }

  return session
    ? {
        ...session,
        lastSeenAt: lastSeenAt ?? session.startedAt,
      }
    : null;
}

function safeParseRuntimeRecord(line: string): UnknownRecord | null {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

async function readBoundJson(filePath: string, maxBytes: number): Promise<unknown | null> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile() || fileStat.size > maxBytes) return null;
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function buildRunsForTeam(
  teamName: string,
  config: DiscoveredTeamConfig | null,
  launchState: PersistedTeamLaunchSnapshot | null,
  teamMeta: TeamMetadata | null,
  runtimeSessions: readonly RuntimeSessionRecord[]
): TokenUsageRunDto[] {
  const fallbackIso =
    launchState?.updatedAt ??
    config?.createdAt ??
    teamMeta?.createdAt ??
    config?.configUpdatedAt ??
    new Date(0).toISOString();
  const projectPath = config?.projectPath;
  const commandId = buildTeamLaunchCommandId(teamName);
  const commandInvocationId = buildTeamLaunchInvocationId(teamName, launchState, config);
  const commandHash = hashOptional(`${teamName}:${projectPath ?? ''}`);
  const runs: TokenUsageRunDto[] = [];
  const configMembers = new Map(
    (config?.members ?? []).map((member) => [member.name.trim().toLowerCase(), member])
  );
  const leadMember = findTeamLeadMember(config?.members ?? []);

  const leadSessionId = config?.leadSessionId ?? launchState?.leadSessionId;
  if (leadSessionId) {
    const providerId =
      leadMember?.providerId ??
      teamMeta?.launchIdentity?.providerId ??
      teamMeta?.providerId ??
      'anthropic';
    const providerBackendId =
      leadMember?.providerBackendId ??
      teamMeta?.launchIdentity?.providerBackendId ??
      teamMeta?.providerBackendId;
    const model = resolveRunModel(
      leadMember?.model ??
        teamMeta?.model ??
        teamMeta?.launchIdentity?.resolvedLaunchModel ??
        teamMeta?.launchIdentity?.selectedModel ??
        teamMeta?.launchIdentity?.catalogId,
      providerId,
      teamMeta
    );
    const leadStartedAt = readIsoTimestamp(leadMember?.joinedAt) ?? fallbackIso;
    const leadActive = resolveConfigMemberActive(leadMember);
    const leadEndedAt =
      leadActive === true
        ? undefined
        : !launchState || isTerminalLaunchSnapshot(launchState) || leadActive === false
          ? leadStartedAt
          : undefined;
    runs.push({
      appRunId: `team:${teamName}:lead:${leadSessionId}`,
      teamName,
      agentId: leadMember?.agentId ?? `${teamName}:team-lead`,
      agentName: 'team-lead',
      runtimeKind: runtimeKindFromProvider(providerId),
      providerId,
      providerBackendId,
      billingMode: inferProviderBillingMode({
        providerId,
        providerBackendId,
        explicitBillingMode: teamMeta?.launchIdentity?.billingMode ?? teamMeta?.billingMode,
        model,
      }),
      model,
      workspacePathHash: hashOptional(leadMember?.cwd ?? projectPath),
      workspaceLabel: workspaceLabelForPath(leadMember?.cwd ?? projectPath),
      commandId,
      commandInvocationId,
      commandHash,
      startedAt: leadStartedAt,
      endedAt: leadEndedAt,
      status: statusFromLifecycle({
        hardFailure: false,
        active: leadActive,
        endedAt: leadEndedAt,
        launchState,
      }),
      source: 'team_launch_state',
      sources: [
        {
          id: `team:${teamName}:lead:${leadSessionId}:source`,
          appRunId: `team:${teamName}:lead:${leadSessionId}`,
          sourceType: 'cli_log',
          nativeSessionId: leadSessionId,
          nativeLogPath: resolveClaudeNativeLogPath(leadMember?.cwd ?? projectPath, leadSessionId),
          discoveredAt: fallbackIso,
        },
      ],
    });
  }

  const launchMembers = Object.values(launchState?.members ?? {});
  for (const memberState of launchMembers) {
    const memberName = memberState.name?.trim();
    if (!memberName) continue;
    const configMember = configMembers.get(memberName.toLowerCase());
    if (!hasMemberRunEvidence(memberState)) continue;
    runs.push(
      buildMemberRun(
        teamName,
        memberState,
        configMember,
        projectPath,
        fallbackIso,
        commandId,
        commandInvocationId,
        commandHash,
        teamMeta
      )
    );
  }

  for (const runtimeSession of runtimeSessions) {
    if (runtimeSession.agentName.trim().toLowerCase() === 'team-lead') continue;
    const configMember = configMembers.get(runtimeSession.agentName.trim().toLowerCase());
    runs.push(
      buildRuntimeSessionRun(
        teamName,
        runtimeSession,
        configMember,
        projectPath,
        fallbackIso,
        commandId,
        commandInvocationId,
        commandHash,
        teamMeta
      )
    );
  }

  return dedupeRuns(runs);
}

function hasMemberRunEvidence(memberState: PersistedTeamLaunchMemberState): boolean {
  return Boolean(
    memberState.runtimeSessionId ||
    memberState.firstSpawnAcceptedAt ||
    memberState.lastRuntimeAliveAt ||
    memberState.lastHeartbeatAt ||
    memberState.runtimeLastSeenAt
  );
}

function buildMemberRun(
  teamName: string,
  memberState: PersistedTeamLaunchMemberState,
  configMember: DiscoveredTeamMember | undefined,
  projectPath: string | undefined,
  fallbackIso: string,
  commandId: string,
  commandInvocationId: string,
  commandHash: string | undefined,
  teamMeta: TeamMetadata | null
): TokenUsageRunDto {
  const providerId = memberState.providerId ?? configMember?.providerId;
  const providerBackendId = memberState.providerBackendId ?? configMember?.providerBackendId;
  const runtimeKind = runtimeKindFromProvider(providerId);
  const model = resolveRunModel(memberState.model ?? configMember?.model, providerId, teamMeta);
  const configMemberActive = resolveConfigMemberActive(configMember);
  const nativeSessionId = memberState.runtimeSessionId;
  const launchId = memberState.runtimeRunId ?? nativeSessionId ?? 'current';
  const appRunId = `team:${teamName}:member:${memberState.name}:${launchId}`;
  const startedAt =
    memberState.firstSpawnAcceptedAt ??
    memberState.lastEvaluatedAt ??
    readIsoTimestamp(configMember?.joinedAt) ??
    fallbackIso;
  const latestRuntimeEvidenceAt = latestIso([
    memberState.lastRuntimeAliveAt,
    memberState.lastHeartbeatAt,
    memberState.runtimeLastSeenAt,
    memberState.firstSpawnAcceptedAt,
    readIsoTimestamp(configMember?.joinedAt),
  ]);
  const endedAt =
    memberState.runtimeAlive || configMemberActive === true
      ? undefined
      : (latestRuntimeEvidenceAt ?? startedAt);
  return {
    appRunId,
    teamName,
    agentId: configMember?.agentId ?? `${teamName}:${memberState.name}`,
    agentName: memberState.name,
    runtimeKind,
    providerId,
    providerBackendId,
    billingMode: inferProviderBillingMode({
      providerId,
      providerBackendId,
      explicitBillingMode:
        memberState.billingMode ??
        memberState.launchIdentity?.billingMode ??
        (configMember?.providerId == null ||
        configMember.providerId === teamMeta?.launchIdentity?.providerId
          ? (teamMeta?.launchIdentity?.billingMode ?? teamMeta?.billingMode)
          : undefined),
      model,
    }),
    model,
    workspacePathHash: hashOptional(memberState.cwd ?? configMember?.cwd ?? projectPath),
    workspaceLabel: workspaceLabelForPath(memberState.cwd ?? configMember?.cwd ?? projectPath),
    commandId,
    commandInvocationId,
    commandHash,
    startedAt,
    endedAt,
    status: statusFromLifecycle({
      hardFailure: memberState.hardFailure,
      active: memberState.runtimeAlive || configMemberActive,
      endedAt,
      launchState: null,
    }),
    source: 'team_launch_state',
    sources: nativeSessionId
      ? [
          {
            id: `${appRunId}:session:${nativeSessionId}`,
            appRunId,
            sourceType:
              runtimeKind === 'codex' || runtimeKind === 'opencode' ? 'runtime_trace' : 'cli_log',
            nativeSessionId,
            nativeLogPath: resolveClaudeNativeLogPath(
              memberState.cwd ?? configMember?.cwd ?? projectPath,
              nativeSessionId
            ),
            discoveredAt: memberState.lastEvaluatedAt ?? fallbackIso,
          },
        ]
      : [],
  };
}

function buildRuntimeSessionRun(
  teamName: string,
  runtimeSession: RuntimeSessionRecord,
  configMember: DiscoveredTeamMember | undefined,
  projectPath: string | undefined,
  fallbackIso: string,
  commandId: string,
  commandInvocationId: string,
  commandHash: string | undefined,
  teamMeta: TeamMetadata | null
): TokenUsageRunDto {
  const providerId =
    configMember?.providerId ?? teamMeta?.launchIdentity?.providerId ?? teamMeta?.providerId;
  const providerBackendId =
    configMember?.providerBackendId ??
    teamMeta?.launchIdentity?.providerBackendId ??
    teamMeta?.providerBackendId;
  const model = resolveRunModel(
    configMember?.model ??
      teamMeta?.launchIdentity?.resolvedLaunchModel ??
      teamMeta?.launchIdentity?.selectedModel ??
      teamMeta?.model,
    providerId,
    teamMeta
  );
  const runtimeKind = runtimeKindFromProvider(providerId);
  const appRunId = `team:${teamName}:member:${runtimeSession.agentName}:${runtimeSession.runId}`;
  const startedAt = runtimeSession.startedAt || fallbackIso;
  const configMemberActive = resolveConfigMemberActive(configMember);
  const endedAt = configMemberActive === true ? undefined : runtimeSession.lastSeenAt || startedAt;

  return {
    appRunId,
    teamName,
    agentId:
      runtimeSession.agentId ?? configMember?.agentId ?? `${teamName}:${runtimeSession.agentName}`,
    agentName: runtimeSession.agentName,
    runtimeKind,
    providerId,
    providerBackendId,
    billingMode: inferProviderBillingMode({
      providerId,
      providerBackendId,
      explicitBillingMode:
        configMember?.providerId == null ||
        configMember.providerId === teamMeta?.launchIdentity?.providerId
          ? (teamMeta?.launchIdentity?.billingMode ?? teamMeta?.billingMode)
          : undefined,
      model,
    }),
    model,
    workspacePathHash: hashOptional(runtimeSession.cwd ?? configMember?.cwd ?? projectPath),
    workspaceLabel: workspaceLabelForPath(runtimeSession.cwd ?? configMember?.cwd ?? projectPath),
    commandId,
    commandInvocationId,
    commandHash,
    startedAt,
    endedAt,
    status: statusFromLifecycle({
      hardFailure: false,
      active: configMemberActive,
      endedAt,
      launchState: null,
    }),
    source: 'team_launch_state',
    sources: [
      {
        id: `${appRunId}:session:${runtimeSession.runId}`,
        appRunId,
        sourceType:
          runtimeKind === 'codex' || runtimeKind === 'opencode' ? 'runtime_trace' : 'cli_log',
        nativeSessionId: runtimeSession.runId,
        nativeLogPath: resolveClaudeNativeLogPath(
          runtimeSession.cwd ?? configMember?.cwd ?? projectPath,
          runtimeSession.runId
        ),
        discoveredAt: runtimeSession.lastSeenAt || fallbackIso,
      },
    ],
  };
}

function resolveClaudeNativeLogPath(
  projectPath: string | undefined,
  sessionId: string | undefined
): string | undefined {
  if (!projectPath || !sessionId) return undefined;
  return path.join(getProjectsBasePath(), encodePath(projectPath), `${sessionId}.jsonl`);
}

function isTerminalLaunchSnapshot(launchState: PersistedTeamLaunchSnapshot): boolean {
  return (
    launchState.launchPhase === 'finished' ||
    launchState.launchPhase === 'reconciled' ||
    launchState.teamLaunchState === 'clean_success' ||
    launchState.teamLaunchState === 'partial_failure' ||
    launchState.teamLaunchState === 'partial_skipped'
  );
}

function statusFromLifecycle({
  hardFailure,
  active,
  endedAt,
  launchState,
}: {
  hardFailure: boolean | undefined;
  active: boolean | undefined;
  endedAt: string | undefined;
  launchState: PersistedTeamLaunchSnapshot | null;
}): TokenUsageRunDto['status'] {
  if (hardFailure) return 'failed';
  if (active === true) return 'running';
  if (active === false || endedAt || (launchState && isTerminalLaunchSnapshot(launchState))) {
    return 'completed';
  }
  return 'unknown';
}

function resolveConfigMemberActive(member: DiscoveredTeamMember | undefined): boolean | undefined {
  if (member?.isActive !== true) return member?.isActive;
  if (member.runtimePid == null) return true;
  return isProcessAlive(member.runtimePid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveRunModel(
  model: string | undefined,
  providerId: TeamProviderId | undefined,
  teamMeta: TeamMetadata | null
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;

  const identity = teamMeta?.launchIdentity;
  const resolved = identity?.resolvedLaunchModel?.trim();
  if (!resolved || resolved === trimmed) return trimmed;
  if (!identity) return trimmed;

  if (identity.providerId && providerId && identity.providerId !== providerId) {
    return trimmed;
  }

  const aliasCandidates = [identity.selectedModel, identity.catalogId, teamMeta?.model]
    .map((candidate) => candidate?.trim())
    .filter((candidate): candidate is string => !!candidate);
  return aliasCandidates.some((candidate) => sameModelId(candidate, trimmed)) ? resolved : trimmed;
}

function sameModelId(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function runtimeKindFromProvider(providerId: TeamProviderId | undefined): TokenUsageRuntimeKind {
  if (providerId === 'anthropic' || providerId === 'codex' || providerId === 'gemini') {
    return providerId;
  }
  if (providerId === 'opencode') return 'opencode';
  return 'unknown';
}

function buildTeamLaunchCommandId(teamName: string): string {
  return `team-launch:${teamName}`;
}

function buildTeamLaunchInvocationId(
  teamName: string,
  launchState: PersistedTeamLaunchSnapshot | null,
  config: TeamConfig | null
): string {
  const launchStart =
    earliestIso(
      Object.values(launchState?.members ?? {}).map((member) => member.firstSpawnAcceptedAt)
    ) ??
    config?.leadSessionId ??
    launchState?.leadSessionId ??
    launchState?.updatedAt ??
    'current';
  return `team-launch:${teamName}:${launchStart}`;
}

function findTeamLeadMember(
  members: readonly DiscoveredTeamMember[]
): DiscoveredTeamMember | undefined {
  return members.find((member) => {
    const normalizedName = member.name.trim().toLowerCase();
    return (
      member.agentType === 'team-lead' ||
      normalizedName === 'team-lead' ||
      normalizedName === 'lead'
    );
  });
}

function normalizeTeamMember(value: unknown): DiscoveredTeamMember | null {
  const record = asRecord(value);
  const name = readString(record?.name);
  if (!name) return null;
  return {
    name,
    agentId: readString(record?.agentId),
    agentType: readString(record?.agentType),
    role: readString(record?.role),
    workflow: readString(record?.workflow),
    isolation: record?.isolation === 'worktree' ? 'worktree' : undefined,
    providerId: normalizeProviderId(record?.providerId) ?? normalizeProviderId(record?.provider),
    providerBackendId: normalizeProviderBackendId(record?.providerBackendId),
    model: readString(record?.model),
    joinedAt: readEpochMillis(record?.joinedAt),
    cwd: readString(record?.cwd),
    isActive: readBoolean(record?.isActive),
    runtimePid: readPositiveInteger(record?.runtimePid),
  };
}

function normalizeLaunchIdentity(value: unknown): TeamLaunchIdentityMetadata | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return {
    providerId: normalizeProviderId(record.providerId),
    providerBackendId: normalizeProviderBackendId(record.providerBackendId),
    billingMode: normalizeProviderBillingMode(record.billingMode),
    selectedModel: readString(record.selectedModel),
    resolvedLaunchModel: readString(record.resolvedLaunchModel),
    catalogId: readString(record.catalogId),
  };
}

function normalizeProviderId(value: unknown): TeamProviderId | undefined {
  return value === 'anthropic' || value === 'codex' || value === 'gemini' || value === 'opencode'
    ? value
    : undefined;
}

function normalizeProviderBackendId(value: unknown): TeamProviderBackendId | undefined {
  return value === 'auto' ||
    value === 'adapter' ||
    value === 'api' ||
    value === 'cli-sdk' ||
    value === 'codex-native' ||
    value === 'opencode-cli'
    ? value
    : undefined;
}

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readEpochMillis(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0
  );
  return values.length > 0 ? values : undefined;
}

function hashOptional(value: string | undefined): string | undefined {
  return value ? createHash('sha256').update(value).digest('hex') : undefined;
}

function workspaceLabelForPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return path.basename(value.replace(/[\\/]+$/, '')) || undefined;
}

function dedupeRuns(runs: readonly TokenUsageRunDto[]): TokenUsageRunDto[] {
  return [...new Map(runs.map((run) => [run.appRunId, run])).values()];
}

function earliestIso(values: readonly (string | undefined)[]): string | undefined {
  let earliest: string | undefined;
  let earliestTime = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) continue;
    if (time < earliestTime) {
      earliest = value;
      earliestTime = time;
    }
  }
  return earliest;
}

function latestIso(values: readonly (string | undefined)[]): string | undefined {
  let latest: string | undefined;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) continue;
    if (time > latestTime) {
      latest = value;
      latestTime = time;
    }
  }
  return latest;
}
