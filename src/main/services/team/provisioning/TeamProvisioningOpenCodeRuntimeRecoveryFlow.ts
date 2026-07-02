import { buildPlannedMemberLaneIdentity } from '@features/team-runtime-lanes';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { isLeadMember } from '@shared/utils/leadDetection';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import {
  type OpenCodeMemberDirectory,
  type OpenCodeMemberIdentityResolution,
} from '../opencode/delivery/OpenCodeMemberMessageDeliveryService';
import {
  type OpenCodeCommittedBootstrapSessionEvidence,
  type OpenCodeCommittedBootstrapSessionRecord,
  type OpenCodeRuntimeLaneIndex,
  readCommittedOpenCodeBootstrapSessionEvidence,
  readOpenCodeRuntimeLaneIndex,
  setOpenCodeRuntimeActiveRunManifest,
  upsertOpenCodeRuntimeLaneIndexEntry,
} from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';

import {
  isRecoverableOpenCodeRuntimeEvidence,
  isRecoverablePersistedOpenCodeRuntimeCandidate,
} from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';

import type { TeamRuntimeMemberLaunchEvidence } from '../runtime';
import type {
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  TeamConfig,
  TeamMember,
} from '@shared/types';

type OpenCodeRuntimeRecoveryLogger = Pick<Console, 'info' | 'warn'>;

export interface OpenCodeRuntimeLaneRecoveryPorts {
  teamsBasePath: string;
  logger: OpenCodeRuntimeRecoveryLogger;
  canDeliverToOpenCodeRuntimeForTeam(teamName: string): boolean;
  canAttemptCommittedOpenCodeSessionRecovery(teamName: string): boolean;
  cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(teamName: string): void;
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  tryRecoverMissingOpenCodeSecondaryLaneFromRuntime(input: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
    persistedMember: PersistedTeamLaunchMemberState;
  }): Promise<TeamRuntimeMemberLaunchEvidence | null>;
  tryRecoverActiveOpenCodeSecondaryLaneFromRuntime(input: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
  }): Promise<TeamRuntimeMemberLaunchEvidence | null>;
  readOpenCodeMemberDirectory(teamName: string): Promise<OpenCodeMemberDirectory>;
  resolveOpenCodeMemberIdentityFromDirectory(
    teamName: string,
    memberName: string,
    directory: OpenCodeMemberDirectory
  ): OpenCodeMemberIdentityResolution;
  readConfigForObservation(teamName: string): Promise<TeamConfig | null>;
  readTeamMeta(teamName: string): Promise<OpenCodeMemberDirectory['teamMeta']>;
  readMetaMembers(teamName: string): Promise<TeamMember[]>;
  readPersistedTeamProjectPath(teamName: string): string | null;
  isOpenCodeRuntimeLaneIndexActive(teamName: string, laneId: string): Promise<boolean>;
  readOpenCodeRuntimeLaneIndex?: (
    teamsBasePath: string,
    teamName: string
  ) => Promise<OpenCodeRuntimeLaneIndex>;
  readCommittedOpenCodeBootstrapSessionEvidence?: (input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
  }) => Promise<OpenCodeCommittedBootstrapSessionEvidence>;
  upsertOpenCodeRuntimeLaneIndexEntry?: typeof upsertOpenCodeRuntimeLaneIndexEntry;
  setOpenCodeRuntimeActiveRunManifest?: typeof setOpenCodeRuntimeActiveRunManifest;
}

export interface OpenCodeRuntimeLaneIdResolutionPorts {
  getRuntimeAdapterRun(teamName: string): { runId: string; providerId: string } | undefined;
  getSecondaryRuntimeRuns(teamName: string): readonly { runId: string; laneId: string }[];
  getTrackedRunId(teamName: string): string | null;
  getRun(runId: string): { mixedSecondaryLanes?: readonly { laneId: string; member: { name: string } }[] } | null;
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
}

export function buildOpenCodeRecoveryMember(input: {
  canonicalMemberName: string;
  configMember?: TeamMember;
  metaMember?: TeamMember;
  persistedMember?: Pick<PersistedTeamLaunchMemberState, 'model' | 'effort' | 'cwd'>;
}): TeamMember {
  return {
    ...(input.configMember ?? {}),
    ...(input.metaMember ?? {}),
    name: input.canonicalMemberName,
    providerId: 'opencode',
    model: input.metaMember?.model ?? input.configMember?.model ?? input.persistedMember?.model,
    role: input.metaMember?.role ?? input.configMember?.role,
    workflow: input.metaMember?.workflow ?? input.configMember?.workflow,
    effort: input.metaMember?.effort ?? input.configMember?.effort ?? input.persistedMember?.effort,
    cwd: input.metaMember?.cwd ?? input.configMember?.cwd ?? input.persistedMember?.cwd,
    isolation: input.metaMember?.isolation ?? input.configMember?.isolation,
  };
}

export function findOpenCodePersistedRecoveryMember(
  snapshot: PersistedTeamLaunchSnapshot | null | undefined,
  input: { memberName: string; laneId: string }
): PersistedTeamLaunchMemberState | null {
  return (
    snapshot?.members?.[input.memberName] ??
    Object.values(snapshot?.members ?? {}).find((member) => member.laneId === input.laneId) ??
    null
  );
}

export function selectCommittedOpenCodeRecoverySession(
  evidence: OpenCodeCommittedBootstrapSessionEvidence | null | undefined,
  memberName: string
): OpenCodeCommittedBootstrapSessionRecord | null {
  if (!evidence?.committed || evidence.sessions.length === 0) {
    return null;
  }
  const expectedMemberName = memberName.trim().toLowerCase();
  return (
    evidence.sessions.find(
      (session) => session.memberName.trim().toLowerCase() === expectedMemberName
    ) ?? null
  );
}

export function buildCommittedOpenCodeRecoveryDiagnostics(input: {
  committedSessionEvidence: Pick<OpenCodeCommittedBootstrapSessionEvidence, 'diagnostics'>;
  runtimeEvidence: Pick<TeamRuntimeMemberLaunchEvidence, 'diagnostics'>;
}): string[] {
  return Array.from(
    new Set([
      'Recovered missing OpenCode runtime lane index from committed session evidence.',
      ...input.committedSessionEvidence.diagnostics,
      ...(input.runtimeEvidence.diagnostics ?? []),
    ])
  );
}

export function getConfiguredOpenCodeRecoveryMemberNames(directory: OpenCodeMemberDirectory): string[] {
  const configuredNames = new Set<string>();
  for (const member of directory.config?.members ?? []) {
    if (member.name?.trim()) {
      configuredNames.add(member.name.trim());
    }
  }
  for (const member of directory.metaMembers) {
    if (member.name?.trim()) {
      configuredNames.add(member.name.trim());
    }
  }
  return [...configuredNames];
}

export function planOpenCodeDeliveryWatchdogRuntimeRecovery(input: {
  canDeliverToTeamRuntime: boolean;
  canAttemptCommittedSessionRecovery: boolean;
  allowCommittedSessionRecoveryWithoutTeamRuntime?: boolean;
}):
  | { proceed: true; recoverPersistedMembers: boolean; recoverCommittedSessions: boolean }
  | { proceed: false; cleanupStoppedLanes: boolean } {
  if (!input.canDeliverToTeamRuntime && !input.allowCommittedSessionRecoveryWithoutTeamRuntime) {
    return { proceed: false, cleanupStoppedLanes: true };
  }
  if (!input.canDeliverToTeamRuntime && !input.canAttemptCommittedSessionRecovery) {
    return { proceed: false, cleanupStoppedLanes: true };
  }
  return {
    proceed: true,
    recoverPersistedMembers: input.canDeliverToTeamRuntime,
    recoverCommittedSessions:
      input.canDeliverToTeamRuntime || input.allowCommittedSessionRecoveryWithoutTeamRuntime === true,
  };
}

export async function tryRecoverOpenCodeRuntimeLaneBeforeDelivery(
  input: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
  },
  ports: OpenCodeRuntimeLaneRecoveryPorts
): Promise<boolean> {
  if (!ports.canDeliverToOpenCodeRuntimeForTeam(input.teamName)) {
    ports.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(input.teamName);
    return false;
  }
  const snapshot = await ports.readLaunchState(input.teamName).catch(() => null);
  const persistedMember = findOpenCodePersistedRecoveryMember(snapshot, {
    memberName: input.member.name,
    laneId: input.laneId,
  });
  if (!persistedMember || !isRecoverablePersistedOpenCodeRuntimeCandidate(persistedMember)) {
    return false;
  }
  const runtimeEvidence = await ports.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime({
    teamName: input.teamName,
    laneId: input.laneId,
    member: input.member,
    projectPath: input.projectPath,
    previousLaunchState: snapshot,
    persistedMember,
  });
  if (!runtimeEvidence) {
    return false;
  }
  ports.logger.info(
    `[${input.teamName}] Recovered OpenCode lane ${input.laneId} before message delivery.`
  );
  return true;
}

export async function tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(
  input: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
    previousLaunchState?: PersistedTeamLaunchSnapshot | null;
  },
  ports: OpenCodeRuntimeLaneRecoveryPorts
): Promise<boolean> {
  if (!ports.canAttemptCommittedOpenCodeSessionRecovery(input.teamName)) {
    ports.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(input.teamName);
    return false;
  }
  const readLaneIndex = ports.readOpenCodeRuntimeLaneIndex ?? readOpenCodeRuntimeLaneIndex;
  const currentLaneIndex = await readLaneIndex(ports.teamsBasePath, input.teamName).catch(() => null);
  const currentEntry = currentLaneIndex?.lanes[input.laneId];
  if (currentEntry?.state === 'active') {
    return true;
  }
  if (currentEntry?.state === 'degraded' || currentEntry?.state === 'stopped') {
    return false;
  }

  const readCommittedEvidence =
    ports.readCommittedOpenCodeBootstrapSessionEvidence ??
    readCommittedOpenCodeBootstrapSessionEvidence;
  const committedSessionEvidence = await readCommittedEvidence({
    teamsBasePath: ports.teamsBasePath,
    teamName: input.teamName,
    laneId: input.laneId,
  }).catch(() => null);
  const matchingSession = selectCommittedOpenCodeRecoverySession(
    committedSessionEvidence,
    input.member.name
  );
  if (!committedSessionEvidence || !matchingSession) {
    return false;
  }

  const runtimeEvidence = await ports.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime({
    teamName: input.teamName,
    laneId: input.laneId,
    member: input.member,
    projectPath: input.projectPath,
    previousLaunchState: input.previousLaunchState ?? null,
  });
  if (!isRecoverableOpenCodeRuntimeEvidence(runtimeEvidence)) {
    return false;
  }

  const diagnostics = buildCommittedOpenCodeRecoveryDiagnostics({
    committedSessionEvidence,
    runtimeEvidence,
  });
  const upsertLaneIndex =
    ports.upsertOpenCodeRuntimeLaneIndexEntry ?? upsertOpenCodeRuntimeLaneIndexEntry;
  await upsertLaneIndex({
    teamsBasePath: ports.teamsBasePath,
    teamName: input.teamName,
    laneId: input.laneId,
    state: 'active',
    diagnostics,
  }).catch((error: unknown) => {
    ports.logger.warn(
      `[${input.teamName}] Failed to recover missing OpenCode lane index ${input.laneId} from committed session evidence: ${getErrorMessage(error)}`
    );
  });
  const setActiveManifest =
    ports.setOpenCodeRuntimeActiveRunManifest ?? setOpenCodeRuntimeActiveRunManifest;
  await setActiveManifest({
    teamsBasePath: ports.teamsBasePath,
    teamName: input.teamName,
    laneId: input.laneId,
    runId: committedSessionEvidence.activeRunId ?? matchingSession.runId ?? null,
  }).catch((error: unknown) => {
    ports.logger.warn(
      `[${input.teamName}] Failed to materialize committed-session recovered OpenCode lane manifest ${input.laneId}: ${getErrorMessage(error)}`
    );
  });
  ports.logger.info(
    `[${input.teamName}] Recovered OpenCode lane ${input.laneId} from committed session evidence before message delivery.`
  );
  return true;
}

export async function tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(
  input: { teamName: string; memberName: string },
  ports: OpenCodeRuntimeLaneRecoveryPorts
): Promise<boolean> {
  const directory = await ports.readOpenCodeMemberDirectory(input.teamName).catch(() => null);
  if (!directory) {
    return false;
  }
  const identity = ports.resolveOpenCodeMemberIdentityFromDirectory(
    input.teamName,
    input.memberName,
    directory
  );
  if (!identity.ok) {
    return false;
  }
  const readLaneIndex = ports.readOpenCodeRuntimeLaneIndex ?? readOpenCodeRuntimeLaneIndex;
  const laneIndex = await readLaneIndex(ports.teamsBasePath, input.teamName).catch(() => null);
  const currentEntry = laneIndex?.lanes[identity.laneId];
  if (currentEntry?.state === 'active') {
    return true;
  }
  if (currentEntry?.state === 'degraded' || currentEntry?.state === 'stopped') {
    return false;
  }
  const previousLaunchState = await ports.readLaunchState(input.teamName).catch(() => null);
  const projectPath =
    identity.memberRuntimeCwd ??
    directory.config?.projectPath?.trim() ??
    ports.readPersistedTeamProjectPath(input.teamName);
  return tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(
    {
      teamName: input.teamName,
      laneId: identity.laneId,
      member: buildOpenCodeRecoveryMember({
        canonicalMemberName: identity.canonicalMemberName,
        configMember: identity.configMember,
        metaMember: identity.metaMember,
      }),
      projectPath,
      previousLaunchState,
    },
    ports
  );
}

export async function tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(
  input: { teamName: string; memberName: string; laneId: string },
  ports: OpenCodeRuntimeLaneRecoveryPorts
): Promise<boolean> {
  const recovered = await tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(
    {
      teamName: input.teamName,
      memberName: input.memberName,
    },
    ports
  ).catch(() => false);
  if (!recovered) {
    return false;
  }
  return ports.isOpenCodeRuntimeLaneIndexActive(input.teamName, input.laneId).catch(() => false);
}

export async function tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog(
  teamName: string,
  options: { allowCommittedSessionRecoveryWithoutTeamRuntime?: boolean },
  ports: OpenCodeRuntimeLaneRecoveryPorts
): Promise<string[]> {
  const canDeliverToTeamRuntime = ports.canDeliverToOpenCodeRuntimeForTeam(teamName);
  const recoveryPlan = planOpenCodeDeliveryWatchdogRuntimeRecovery({
    canDeliverToTeamRuntime,
    canAttemptCommittedSessionRecovery: ports.canAttemptCommittedOpenCodeSessionRecovery(teamName),
    allowCommittedSessionRecoveryWithoutTeamRuntime:
      options.allowCommittedSessionRecoveryWithoutTeamRuntime,
  });
  if (!recoveryPlan.proceed) {
    if (recoveryPlan.cleanupStoppedLanes) {
      ports.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(teamName);
    }
    return [];
  }

  const snapshot = await ports.readLaunchState(teamName).catch(() => null);
  const candidates = recoveryPlan.recoverPersistedMembers
    ? Object.values(snapshot?.members ?? {}).filter(isRecoverablePersistedOpenCodeRuntimeCandidate)
    : [];

  const readLaneIndex = ports.readOpenCodeRuntimeLaneIndex ?? readOpenCodeRuntimeLaneIndex;
  const [config, teamMeta, metaMembers, currentLaneIndex] = await Promise.all([
    ports.readConfigForObservation(teamName).catch(() => null),
    ports.readTeamMeta(teamName).catch(() => null),
    ports.readMetaMembers(teamName).catch(() => []),
    readLaneIndex(ports.teamsBasePath, teamName).catch(() => null),
  ]);
  const projectPath = config?.projectPath?.trim() || ports.readPersistedTeamProjectPath(teamName);
  const leadMember = config?.members?.find((member) => isLeadMember(member));
  const leadProviderId =
    normalizeOptionalTeamProviderId(teamMeta?.launchIdentity?.providerId) ??
    normalizeOptionalTeamProviderId(teamMeta?.providerId) ??
    normalizeOptionalTeamProviderId(leadMember?.providerId);
  const recoveredLaneIds: string[] = [];
  for (const persistedMember of candidates) {
    const memberName = persistedMember.name.trim();
    const configMember = config?.members?.find(
      (member) => member.name?.trim().toLowerCase() === memberName.toLowerCase()
    );
    const metaMember = metaMembers.find(
      (member) => member.name?.trim().toLowerCase() === memberName.toLowerCase()
    );
    if (metaMember?.removedAt != null || configMember?.removedAt != null) {
      continue;
    }
    const laneIdentity = buildPlannedMemberLaneIdentity({
      leadProviderId,
      member: {
        name: memberName,
        providerId: 'opencode',
      },
    });
    if (laneIdentity.laneId !== persistedMember.laneId) {
      continue;
    }
    if (currentLaneIndex?.lanes[laneIdentity.laneId]) {
      continue;
    }
    const recovered = await tryRecoverOpenCodeRuntimeLaneBeforeDelivery(
      {
        teamName,
        laneId: laneIdentity.laneId,
        member: buildOpenCodeRecoveryMember({
          canonicalMemberName: memberName,
          configMember,
          metaMember,
          persistedMember,
        }),
        projectPath,
      },
      ports
    );
    if (recovered) {
      recoveredLaneIds.push(laneIdentity.laneId);
    }
  }
  if (!recoveryPlan.recoverCommittedSessions) {
    return [...new Set(recoveredLaneIds)];
  }

  const directory: OpenCodeMemberDirectory = { config, teamMeta, metaMembers };
  for (const memberName of getConfiguredOpenCodeRecoveryMemberNames(directory)) {
    const identity = ports.resolveOpenCodeMemberIdentityFromDirectory(teamName, memberName, directory);
    if (!identity.ok) {
      continue;
    }
    if (currentLaneIndex?.lanes[identity.laneId] || recoveredLaneIds.includes(identity.laneId)) {
      continue;
    }
    const recovered = await tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(
      {
        teamName,
        laneId: identity.laneId,
        member: buildOpenCodeRecoveryMember({
          canonicalMemberName: identity.canonicalMemberName,
          configMember: identity.configMember,
          metaMember: identity.metaMember,
        }),
        projectPath:
          identity.memberRuntimeCwd ??
          config?.projectPath?.trim() ??
          ports.readPersistedTeamProjectPath(teamName),
        previousLaunchState: snapshot,
      },
      ports
    );
    if (recovered) {
      recoveredLaneIds.push(identity.laneId);
    }
  }
  return [...new Set(recoveredLaneIds)];
}

export async function resolveOpenCodeRuntimeLaneId(
  params: { teamName: string; runId: string; memberName?: string },
  ports: OpenCodeRuntimeLaneIdResolutionPorts
): Promise<string> {
  const runtimeRun = ports.getRuntimeAdapterRun(params.teamName);
  if (runtimeRun?.providerId === 'opencode' && runtimeRun.runId === params.runId) {
    return 'primary';
  }

  for (const lane of ports.getSecondaryRuntimeRuns(params.teamName)) {
    if (lane.runId === params.runId) {
      return lane.laneId;
    }
  }

  if (params.memberName) {
    const trackedRunId = ports.getTrackedRunId(params.teamName);
    const trackedRun = trackedRunId ? ports.getRun(trackedRunId) : null;
    const plannedLane = trackedRun?.mixedSecondaryLanes?.find(
      (lane) => lane.member.name.trim() === params.memberName
    );
    if (plannedLane) {
      return plannedLane.laneId;
    }

    const persisted = await ports.readLaunchState(params.teamName).catch(() => null);
    const persistedMember = persisted?.members?.[params.memberName];
    if (
      persistedMember?.laneOwnerProviderId === 'opencode' &&
      typeof persistedMember.laneId === 'string' &&
      persistedMember.laneId.trim().length > 0
    ) {
      return persistedMember.laneId.trim();
    }
  }

  return 'primary';
}
