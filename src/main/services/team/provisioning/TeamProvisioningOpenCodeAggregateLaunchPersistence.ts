import {
  createPersistedLaunchSnapshot,
  snapshotToMemberSpawnStatuses,
} from '../TeamLaunchStateEvaluator';

import {
  commitOpenCodeRuntimeBootstrapSessionEvidence,
  hasCommittedOpenCodeRuntimeBootstrapSessionEvidence,
  type OpenCodeRuntimeBootstrapEvidencePorts,
} from './TeamProvisioningOpenCodeBootstrapEvidence';
import {
  appendDiagnosticOnce,
  promoteCommittedOpenCodeAppManagedBootstrapEvidence,
  summarizeRuntimeLaunchResultMembers,
  toOpenCodePersistedLaunchMember,
} from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';
import { type MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberLaunchEvidence,
  TeamRuntimeMemberSpec,
} from '../runtime';
import type {
  MemberSpawnStatusEntry,
  OpenCodeBootstrapEvidenceSource,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  TeamCreateRequest,
} from '@shared/types';

export interface OpenCodeAggregatePrimaryLaneRun {
  runId: string;
  teamName: string;
  request: TeamCreateRequest;
  effectiveMembers: TeamCreateRequest['members'];
  memberSpawnStatuses: Map<string, MemberSpawnStatusEntry>;
}

export interface PersistOpenCodeRuntimeAdapterLaunchResultPorts {
  createOpenCodeRuntimeBootstrapEvidencePorts(): OpenCodeRuntimeBootstrapEvidencePorts;
  nowIso(): string;
  writeLaunchStateSnapshot(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot
  ): Promise<PersistedTeamLaunchSnapshot>;
}

export interface LaunchOpenCodeAggregatePrimaryLanePorts {
  getTeamsBasePath(): string;
  getOpenCodeRuntimeLaunchCwd(
    baseCwd: string,
    members: TeamCreateRequest['members']
  ): string;
  migrateLegacyOpenCodeRuntimeState(input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
  }): Promise<{ degraded?: boolean; diagnostics?: string[] }>;
  upsertOpenCodeRuntimeLaneIndexEntry(input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
    state: 'active' | 'degraded';
    diagnostics?: string[];
  }): Promise<void>;
  setOpenCodeRuntimeActiveRunManifest(input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
    runId: string;
  }): Promise<void>;
  persistOpenCodeRuntimeAdapterLaunchResult(
    result: TeamRuntimeLaunchResult,
    input: TeamRuntimeLaunchInput
  ): Promise<{
    snapshot: PersistedTeamLaunchSnapshot;
    result: TeamRuntimeLaunchResult;
  }>;
  syncOpenCodeRuntimeToolApprovals(input: {
    teamName: string;
    runId: string;
    laneId: string;
    cwd: string;
    members: TeamRuntimeLaunchResult['members'];
    expectedMembers: TeamRuntimeMemberSpec[];
    teamColor?: string;
    teamDisplayName?: string;
  }): void;
  setRuntimeAdapterRunByTeam(
    teamName: string,
    runtimeRun: {
      runId: string;
      providerId: 'opencode';
      cwd: string;
      members: TeamRuntimeLaunchResult['members'];
    }
  ): void;
}

export async function launchOpenCodeAggregatePrimaryLane(
  params: {
    run: OpenCodeAggregatePrimaryLaneRun;
    adapter: TeamLaunchRuntimeAdapter;
    prompt: string;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
  },
  ports: LaunchOpenCodeAggregatePrimaryLanePorts
): Promise<TeamRuntimeLaunchResult | null> {
  if (params.run.effectiveMembers.length === 0) {
    return null;
  }

  const teamName = params.run.teamName;
  const runId = params.run.runId;
  const launchCwd = ports.getOpenCodeRuntimeLaunchCwd(
    params.run.request.cwd,
    params.run.effectiveMembers
  );
  const migration = await ports.migrateLegacyOpenCodeRuntimeState({
    teamsBasePath: ports.getTeamsBasePath(),
    teamName,
    laneId: 'primary',
  });
  await ports.upsertOpenCodeRuntimeLaneIndexEntry({
    teamsBasePath: ports.getTeamsBasePath(),
    teamName,
    laneId: 'primary',
    state: migration.degraded ? 'degraded' : 'active',
    diagnostics: migration.diagnostics,
  });
  await ports.setOpenCodeRuntimeActiveRunManifest({
    teamsBasePath: ports.getTeamsBasePath(),
    teamName,
    laneId: 'primary',
    runId,
  });

  const expectedMembers: TeamRuntimeMemberSpec[] = params.run.effectiveMembers.map((member) => ({
    name: member.name,
    role: member.role,
    workflow: member.workflow,
    isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
    providerId: 'opencode',
    model: member.model ?? params.run.request.model,
    effort: member.effort ?? params.run.request.effort,
    cwd: member.cwd?.trim() || launchCwd,
  }));
  const launchInput: TeamRuntimeLaunchInput = {
    runId,
    laneId: 'primary',
    teamName,
    cwd: launchCwd,
    prompt: params.prompt,
    providerId: 'opencode',
    model: params.run.request.model,
    effort: params.run.request.effort,
    skipPermissions: params.run.request.skipPermissions !== false,
    expectedMembers,
    previousLaunchState: params.previousLaunchState,
  };
  const launchResult = await params.adapter.launch(launchInput);
  const { snapshot, result } = await ports.persistOpenCodeRuntimeAdapterLaunchResult(
    launchResult,
    launchInput
  );
  const snapshotStatuses = snapshotToMemberSpawnStatuses(snapshot);
  for (const member of expectedMembers) {
    const status = snapshotStatuses[member.name];
    if (status) {
      params.run.memberSpawnStatuses.set(member.name, status);
    }
  }
  ports.syncOpenCodeRuntimeToolApprovals({
    teamName,
    runId,
    laneId: 'primary',
    cwd: launchCwd,
    members: result.members,
    expectedMembers,
    teamColor: params.run.request.color,
    teamDisplayName: params.run.request.displayName,
  });
  if (result.teamLaunchState !== 'partial_failure') {
    ports.setRuntimeAdapterRunByTeam(teamName, {
      runId,
      providerId: 'opencode',
      cwd: launchCwd,
      members: result.members,
    });
  }
  return result;
}

export function summarizeOpenCodeAggregateLaunchState(input: {
  primaryResult: TeamRuntimeLaunchResult | null;
  lanes: readonly MixedSecondaryRuntimeLaneState[];
}): TeamRuntimeLaunchResult['teamLaunchState'] {
  const states = [
    input.primaryResult?.teamLaunchState,
    ...input.lanes.map((lane) => lane.result?.teamLaunchState),
  ].filter((state): state is TeamRuntimeLaunchResult['teamLaunchState'] => Boolean(state));
  if (states.length === 0 || states.some((state) => state === 'partial_failure')) {
    return 'partial_failure';
  }
  if (
    states.some((state) => state === 'partial_pending') ||
    input.lanes.some((lane) => !lane.result)
  ) {
    return 'partial_pending';
  }
  return 'clean_success';
}

export async function persistOpenCodeRuntimeAdapterLaunchResult(
  result: TeamRuntimeLaunchResult,
  input: TeamRuntimeLaunchInput,
  ports: PersistOpenCodeRuntimeAdapterLaunchResultPorts
): Promise<{
  snapshot: PersistedTeamLaunchSnapshot;
  result: TeamRuntimeLaunchResult;
}> {
  const committedResult = await commitOpenCodeRuntimeAdapterLaunchSessionEvidence(
    {
      teamName: input.teamName,
      laneId: input.laneId?.trim() || 'primary',
      result,
    },
    ports
  );
  const members: Record<string, PersistedTeamLaunchMemberState> = {};
  for (const member of input.expectedMembers) {
    const evidence = committedResult.members[member.name];
    members[member.name] = toOpenCodePersistedLaunchMember(member, evidence, {
      runId: committedResult.runId,
      nowIso: ports.nowIso,
    });
  }
  const snapshot = createPersistedLaunchSnapshot({
    teamName: input.teamName,
    expectedMembers: input.expectedMembers.map((member) => member.name),
    bootstrapExpectedMembers: input.expectedMembers.map((member) => member.name),
    includeLeadMembers: true,
    leadSessionId: result.leadSessionId,
    launchPhase: committedResult.launchPhase,
    members,
  });
  return {
    snapshot: await ports.writeLaunchStateSnapshot(input.teamName, snapshot),
    result: committedResult,
  };
}

export async function commitOpenCodeRuntimeAdapterLaunchSessionEvidence(
  params: {
    teamName: string;
    laneId: string;
    result: TeamRuntimeLaunchResult;
  },
  ports: Pick<
    PersistOpenCodeRuntimeAdapterLaunchResultPorts,
    'createOpenCodeRuntimeBootstrapEvidencePorts' | 'nowIso'
  >
): Promise<TeamRuntimeLaunchResult> {
  let changed = false;
  const members: Record<string, TeamRuntimeMemberLaunchEvidence> = { ...params.result.members };
  const bootstrapEvidencePorts = ports.createOpenCodeRuntimeBootstrapEvidencePorts();
  for (const [memberName, evidence] of Object.entries(params.result.members)) {
    const runtimeSessionId = evidence.sessionId?.trim();
    const confirmed =
      evidence.launchState === 'confirmed_alive' ||
      evidence.bootstrapConfirmed === true ||
      evidence.livenessKind === 'confirmed_bootstrap';
    const appManagedCandidate =
      evidence.bootstrapEvidenceSource === 'app_managed_bootstrap' &&
      evidence.bootstrapMode === 'app_managed_context'
        ? evidence.appManagedBootstrapCandidate
        : undefined;
    const appManagedCandidateMatches =
      appManagedCandidate?.source === 'app_managed_bootstrap' &&
      appManagedCandidate.teamName === params.teamName &&
      appManagedCandidate.memberName === memberName &&
      appManagedCandidate.runId === params.result.runId &&
      appManagedCandidate.laneId === params.laneId &&
      appManagedCandidate.runtimeSessionId === runtimeSessionId;
    if ((!confirmed && !appManagedCandidateMatches) || !runtimeSessionId) {
      continue;
    }
    // For app-managed bootstrap, promotion is intentionally two-phase:
    // write the candidate as runtime evidence, then verify it using the same
    // reader path used by later reconciliation/restart flows.
    const source: OpenCodeBootstrapEvidenceSource = appManagedCandidateMatches
      ? 'app_managed_bootstrap'
      : (evidence.bootstrapEvidenceSource ?? 'runtime_bootstrap_checkin');
    await commitOpenCodeRuntimeBootstrapSessionEvidence(
      {
        teamName: params.teamName,
        runId: params.result.runId,
        laneId: params.laneId,
        memberName,
        runtimeSessionId,
        observedAt: ports.nowIso(),
        source,
        appManagedBootstrapCandidate: appManagedCandidateMatches
          ? appManagedCandidate
          : evidence.appManagedBootstrapCandidate,
      },
      bootstrapEvidencePorts
    );
    const verified = await hasCommittedOpenCodeRuntimeBootstrapSessionEvidence(
      {
        teamName: params.teamName,
        runId: params.result.runId,
        laneId: params.laneId,
        memberName,
        runtimeSessionId,
        source,
        appManagedBootstrapCandidate: appManagedCandidateMatches
          ? appManagedCandidate
          : evidence.appManagedBootstrapCandidate,
      },
      bootstrapEvidencePorts
    );
    if (appManagedCandidateMatches && verified && !confirmed) {
      members[memberName] = promoteCommittedOpenCodeAppManagedBootstrapEvidence(evidence);
      changed = true;
    }
  }
  if (!changed) {
    return params.result;
  }
  const teamLaunchState = summarizeRuntimeLaunchResultMembers(members);
  return {
    ...params.result,
    launchPhase: teamLaunchState === 'clean_success' ? 'finished' : params.result.launchPhase,
    teamLaunchState,
    members,
    diagnostics: appendDiagnosticOnce(
      params.result.diagnostics,
      'OpenCode app-managed bootstrap evidence was committed and read back before readiness promotion.'
    ),
  };
}
