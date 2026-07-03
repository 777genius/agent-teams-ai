import { getErrorMessage } from '@shared/utils/errorHandling';

import { getOpenCodeBootstrapCheckinRetryMarker } from './TeamProvisioningBootstrapCheckinMarker';
import { resolveOpenCodeSecondaryLaneMemberEvidence } from './TeamProvisioningLaunchStateProjection';
import { matchesTeamMemberIdentity } from './TeamProvisioningMemberIdentity';
import { hasRealOpenCodeFailureDiagnostic } from './TeamProvisioningOpenCodeDiagnosticsPolicy';
import {
  isExplicitLegacyOpenCodeBootstrap,
  isMaterializedOpenCodeSessionId,
  MEMBER_BOOTSTRAP_STALL_MS,
  OPENCODE_APP_MANAGED_BOOTSTRAP_STALLED_DIAGNOSTIC,
  selectOpenCodeSecondaryBootstrapStallDiagnostic,
} from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';

import type { OpenCodeRuntimeMessageAdapter } from '../opencode/delivery/OpenCodeMemberMessageDeliveryService';
import type {
  OpenCodeTeamRuntimeMessageResult,
  TeamRuntimeLaunchResult,
} from '../runtime';
import type {
  MemberSpawnStatusEntry,
  TeamAgentRuntimeDiagnosticSeverity,
  TeamCreateRequest,
  TeamProvisioningProgress,
} from '@shared/types';

export const OPENCODE_RUNTIME_PROCESS_BOOTSTRAP_STALLED_DIAGNOSTIC =
  'Runtime process is alive, but no bootstrap check-in after 5 min.';
export { OPENCODE_APP_MANAGED_BOOTSTRAP_STALLED_DIAGNOSTIC };
export const OPENCODE_LEGACY_BOOTSTRAP_STALLED_DIAGNOSTIC =
  'OpenCode bootstrap did not complete runtime_bootstrap_checkin after 5 min.';
export const OPENCODE_MEMBER_BRIEFING_WITHOUT_CHECKIN_DIAGNOSTIC =
  'OpenCode member_briefing completed, but runtime_bootstrap_checkin did not complete after 5 min.';
export const OPENCODE_RUNTIME_PROCESS_BOOTSTRAP_PENDING_DIAGNOSTIC =
  'OpenCode runtime process is alive, waiting for bootstrap check-in.';

export interface OpenCodeBootstrapStallLaneLike {
  providerId?: string;
  laneId: string;
  runId?: string | null;
  diagnostics?: string[];
  member: Pick<TeamCreateRequest['members'][number], 'name' | 'cwd'>;
  result?: TeamRuntimeLaunchResult | null;
}

export interface OpenCodeBootstrapStallRunLike {
  runId: string;
  teamName: string;
  processKilled?: boolean;
  cancelRequested?: boolean;
  request: Pick<TeamCreateRequest, 'cwd'>;
  provisioningOutputParts: string[];
  memberSpawnStatuses: Map<string, MemberSpawnStatusEntry>;
  progress: TeamProvisioningProgress;
  onProgress(progress: TeamProvisioningProgress): void;
  isLaunch: boolean;
  provisioningComplete: boolean;
  mixedSecondaryLanes?: OpenCodeBootstrapStallLaneLike[];
}

export interface OpenCodeBootstrapStallStatusPorts {
  nowIso(): string;
  syncMemberTaskActivityForRuntimeTransition(
    run: OpenCodeBootstrapStallRunLike,
    memberName: string,
    previous: MemberSpawnStatusEntry,
    next: MemberSpawnStatusEntry,
    observedAt: string
  ): void;
  updateLaunchDiagnostics(run: OpenCodeBootstrapStallRunLike, observedAt: string): void;
  appendMemberBootstrapDiagnostic(
    run: OpenCodeBootstrapStallRunLike,
    memberName: string,
    text: string
  ): void;
  isCurrentTrackedRun(run: OpenCodeBootstrapStallRunLike): boolean;
  emitMemberSpawnChange(run: OpenCodeBootstrapStallRunLike, memberName: string): void;
  persistLaunchStateSnapshot(
    run: OpenCodeBootstrapStallRunLike,
    phase: 'active' | 'finished'
  ): void;
}

export interface OpenCodeBootstrapStallRetryPromptPorts {
  getOpenCodeRuntimeMessageAdapter(): OpenCodeRuntimeMessageAdapter | null;
  sendOpenCodeMemberMessageToRuntimeSerialized(input: {
    teamName: string;
    laneId: string;
    send: () => Promise<OpenCodeTeamRuntimeMessageResult>;
  }): Promise<OpenCodeTeamRuntimeMessageResult>;
  appendMemberBootstrapDiagnostic(
    run: OpenCodeBootstrapStallRunLike,
    memberName: string,
    text: string
  ): void;
  isCurrentTrackedRun(run: OpenCodeBootstrapStallRunLike): boolean;
}

export interface OpenCodeBootstrapStallTimerPorts {
  nowMs(): number;
  getMemberLaunchGraceKey(run: OpenCodeBootstrapStallRunLike, memberName: string): string;
  hasPendingTimeout(key: string): boolean;
  setPendingTimeout(key: string, timer: NodeJS.Timeout): void;
  deletePendingTimeout(key: string): void;
  setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout;
  reevaluateMemberLaunchStatus(
    run: OpenCodeBootstrapStallRunLike,
    memberName: string
  ): Promise<void>;
}

export interface OpenCodeBootstrapTranscriptOutcome {
  kind: 'success' | 'failure' | 'not_found';
  source?: string;
}

export interface BuildOpenCodeSecondaryBootstrapStallDiagnosticPorts {
  findBootstrapTranscriptOutcome(
    teamName: string,
    memberName: string,
    acceptedAtMs: number | null
  ): Promise<OpenCodeBootstrapTranscriptOutcome | null | undefined>;
}

export interface OpenCodeSecondaryBootstrapRuntimeMetadataLike {
  livenessKind?: MemberSpawnStatusEntry['livenessKind'];
  runtimeDiagnostic?: string;
  runtimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
  runtimeSessionId?: string;
}

export interface ReconcileOpenCodeRuntimeProcessBootstrapPorts {
  buildOpenCodeSecondaryBootstrapStallDiagnostic(
    run: OpenCodeBootstrapStallRunLike,
    memberName: string,
    current: MemberSpawnStatusEntry
  ): Promise<string>;
  setOpenCodeRuntimePendingBootstrapStatus(
    run: OpenCodeBootstrapStallRunLike,
    memberName: string,
    current: MemberSpawnStatusEntry,
    options: {
      bootstrapStalled: boolean;
      runtimeDiagnostic: string;
      runtimeDiagnosticSeverity: TeamAgentRuntimeDiagnosticSeverity;
    }
  ): void;
  maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt(input: {
    run: OpenCodeBootstrapStallRunLike;
    memberName: string;
    current: MemberSpawnStatusEntry;
    runtimeDiagnostic: string;
    runtimeSessionId?: string;
  }): Promise<void>;
  scheduleOpenCodeBootstrapStallReevaluation(
    run: OpenCodeBootstrapStallRunLike,
    memberName: string,
    firstSpawnAcceptedAt: string
  ): void;
}

export interface MarkOpenCodeSecondaryBootstrapStalledPorts {
  buildOpenCodeSecondaryBootstrapStallDiagnostic(
    run: OpenCodeBootstrapStallRunLike,
    memberName: string,
    current: MemberSpawnStatusEntry
  ): Promise<string>;
  setOpenCodeSecondaryBootstrapStalledStatus(
    run: OpenCodeBootstrapStallRunLike,
    memberName: string,
    current: MemberSpawnStatusEntry,
    runtimeDiagnostic: string
  ): void;
  maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt(input: {
    run: OpenCodeBootstrapStallRunLike;
    memberName: string;
    current: MemberSpawnStatusEntry;
    runtimeDiagnostic: string;
    runtimeSessionId?: string;
  }): Promise<void>;
}

export function isOpenCodeBootstrapStallWindowElapsed(
  firstSpawnAcceptedAt: string | undefined,
  nowMs: number
): boolean {
  if (!firstSpawnAcceptedAt) {
    return false;
  }
  const acceptedAtMs = Date.parse(firstSpawnAcceptedAt);
  return Number.isFinite(acceptedAtMs) && nowMs - acceptedAtMs >= MEMBER_BOOTSTRAP_STALL_MS;
}

export function findOpenCodeSecondaryBootstrapStallLane(
  run: Pick<OpenCodeBootstrapStallRunLike, 'mixedSecondaryLanes'>,
  memberName: string
): OpenCodeBootstrapStallLaneLike | undefined {
  return (run.mixedSecondaryLanes ?? []).find(
    (candidate) =>
      candidate.providerId === 'opencode' &&
      matchesTeamMemberIdentity(candidate.member.name, memberName)
  );
}

export function toOpenCodeRuntimeProcessBootstrapStallDiagnostic(
  stalledDiagnostic: string | null | undefined
): string | null {
  return stalledDiagnostic === OPENCODE_LEGACY_BOOTSTRAP_STALLED_DIAGNOSTIC
    ? OPENCODE_RUNTIME_PROCESS_BOOTSTRAP_STALLED_DIAGNOSTIC
    : (stalledDiagnostic ?? null);
}

export async function buildOpenCodeSecondaryBootstrapStallDiagnostic(
  input: {
    run: Pick<OpenCodeBootstrapStallRunLike, 'teamName' | 'mixedSecondaryLanes'>;
    memberName: string;
    current: MemberSpawnStatusEntry;
  },
  ports: BuildOpenCodeSecondaryBootstrapStallDiagnosticPorts
): Promise<string> {
  const lane = findOpenCodeSecondaryBootstrapStallLane(input.run, input.memberName);
  if (
    !isExplicitLegacyOpenCodeBootstrap(
      resolveOpenCodeSecondaryLaneMemberEvidence(lane, input.memberName)
    )
  ) {
    return OPENCODE_APP_MANAGED_BOOTSTRAP_STALLED_DIAGNOSTIC;
  }

  const selectedDiagnostic = selectOpenCodeSecondaryBootstrapStallDiagnostic([
    input.current.runtimeDiagnostic,
    ...(lane?.diagnostics ?? []),
    ...(lane?.result?.diagnostics ?? []),
    ...(lane?.result?.members[input.memberName]?.diagnostics ?? []),
    ...Object.values(lane?.result?.members ?? {})
      .filter((member) => matchesTeamMemberIdentity(member.memberName ?? '', input.memberName))
      .flatMap((member) => member.diagnostics ?? []),
  ]);
  if (selectedDiagnostic) {
    return selectedDiagnostic;
  }

  const acceptedAtMs =
    input.current.firstSpawnAcceptedAt != null ? Date.parse(input.current.firstSpawnAcceptedAt) : NaN;
  const transcriptOutcome = await ports.findBootstrapTranscriptOutcome(
    input.run.teamName,
    input.memberName,
    Number.isFinite(acceptedAtMs) ? acceptedAtMs : null
  );
  if (transcriptOutcome?.kind === 'success' && transcriptOutcome.source === 'member_briefing') {
    return OPENCODE_MEMBER_BRIEFING_WITHOUT_CHECKIN_DIAGNOSTIC;
  }
  return OPENCODE_LEGACY_BOOTSTRAP_STALLED_DIAGNOSTIC;
}

export function setOpenCodeRuntimePendingBootstrapStatus(
  run: OpenCodeBootstrapStallRunLike,
  memberName: string,
  current: MemberSpawnStatusEntry,
  options: {
    bootstrapStalled: boolean;
    runtimeDiagnostic: string;
    runtimeDiagnosticSeverity: TeamAgentRuntimeDiagnosticSeverity;
  },
  ports: OpenCodeBootstrapStallStatusPorts
): void {
  const observedAt = ports.nowIso();
  const wasBootstrapStalled = current.bootstrapStalled === true;
  const next: MemberSpawnStatusEntry = {
    ...current,
    status: 'waiting',
    launchState: 'runtime_pending_bootstrap',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: false,
    hardFailure: false,
    error: undefined,
    hardFailureReason: undefined,
    livenessSource: undefined,
    livenessKind: 'runtime_process',
    runtimeDiagnostic: options.runtimeDiagnostic,
    runtimeDiagnosticSeverity: options.runtimeDiagnosticSeverity,
    bootstrapStalled: options.bootstrapStalled ? true : undefined,
    livenessLastCheckedAt: observedAt,
    firstSpawnAcceptedAt: current.firstSpawnAcceptedAt ?? observedAt,
    updatedAt: observedAt,
  };

  ports.syncMemberTaskActivityForRuntimeTransition(run, memberName, current, next, observedAt);
  run.memberSpawnStatuses.set(memberName, next);
  ports.updateLaunchDiagnostics(run, observedAt);

  if (options.bootstrapStalled && !wasBootstrapStalled) {
    ports.appendMemberBootstrapDiagnostic(run, memberName, 'opencode_bootstrap_stalled');
  } else if (
    !options.bootstrapStalled &&
    (current.status !== 'waiting' || current.livenessKind !== 'runtime_process')
  ) {
    ports.appendMemberBootstrapDiagnostic(
      run,
      memberName,
      'runtime process is alive, teammate check-in not yet received'
    );
  }
  if (!ports.isCurrentTrackedRun(run)) return;
  ports.emitMemberSpawnChange(run, memberName);
  if (run.isLaunch) {
    ports.persistLaunchStateSnapshot(run, run.provisioningComplete ? 'finished' : 'active');
  }
}

export function setOpenCodeSecondaryBootstrapStalledStatus(
  run: OpenCodeBootstrapStallRunLike,
  memberName: string,
  current: MemberSpawnStatusEntry,
  runtimeDiagnostic: string,
  ports: OpenCodeBootstrapStallStatusPorts
): void {
  const observedAt = ports.nowIso();
  const wasBootstrapStalled = current.bootstrapStalled === true;
  const runtimeProcessAlive =
    current.runtimeAlive === true && current.livenessKind === 'runtime_process';
  const next: MemberSpawnStatusEntry = {
    ...current,
    status: 'waiting',
    launchState: 'runtime_pending_bootstrap',
    agentToolAccepted: true,
    runtimeAlive: runtimeProcessAlive,
    bootstrapConfirmed: false,
    hardFailure: false,
    error: undefined,
    hardFailureReason: undefined,
    livenessSource: undefined,
    livenessKind: current.livenessKind ?? (runtimeProcessAlive ? 'runtime_process' : 'registered_only'),
    runtimeDiagnostic,
    runtimeDiagnosticSeverity: 'warning',
    bootstrapStalled: true,
    livenessLastCheckedAt: observedAt,
    firstSpawnAcceptedAt: current.firstSpawnAcceptedAt ?? observedAt,
    updatedAt: observedAt,
  };

  ports.syncMemberTaskActivityForRuntimeTransition(run, memberName, current, next, observedAt);
  run.memberSpawnStatuses.set(memberName, next);
  ports.updateLaunchDiagnostics(run, observedAt);

  if (!wasBootstrapStalled) {
    ports.appendMemberBootstrapDiagnostic(run, memberName, runtimeDiagnostic);
  }
  if (!ports.isCurrentTrackedRun(run)) return;
  ports.emitMemberSpawnChange(run, memberName);
  if (run.isLaunch) {
    ports.persistLaunchStateSnapshot(run, run.provisioningComplete ? 'finished' : 'active');
  }
}

export async function reconcileOpenCodeRuntimeProcessBootstrapStatus(
  input: {
    run: OpenCodeBootstrapStallRunLike;
    memberName: string;
    current: MemberSpawnStatusEntry;
    bootstrapStalled: boolean;
    runtimeDiagnostic?: string;
    runtimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
    runtimeSessionId?: string;
    firstSpawnAcceptedAt?: string;
    scheduleReevaluation: boolean;
  },
  ports: ReconcileOpenCodeRuntimeProcessBootstrapPorts
): Promise<void> {
  const stalledDiagnostic = input.bootstrapStalled
    ? await ports.buildOpenCodeSecondaryBootstrapStallDiagnostic(
        input.run,
        input.memberName,
        input.current
      )
    : null;
  const runtimeProcessStallDiagnostic =
    toOpenCodeRuntimeProcessBootstrapStallDiagnostic(stalledDiagnostic);
  ports.setOpenCodeRuntimePendingBootstrapStatus(input.run, input.memberName, input.current, {
    bootstrapStalled: input.bootstrapStalled,
    runtimeDiagnostic: input.bootstrapStalled
      ? (runtimeProcessStallDiagnostic ?? OPENCODE_RUNTIME_PROCESS_BOOTSTRAP_STALLED_DIAGNOSTIC)
      : (input.runtimeDiagnostic ?? OPENCODE_RUNTIME_PROCESS_BOOTSTRAP_PENDING_DIAGNOSTIC),
    runtimeDiagnosticSeverity: input.bootstrapStalled
      ? 'warning'
      : (input.runtimeDiagnosticSeverity ?? 'info'),
  });
  if (input.bootstrapStalled) {
    await ports.maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt({
      run: input.run,
      memberName: input.memberName,
      current: input.current,
      runtimeDiagnostic:
        runtimeProcessStallDiagnostic ?? OPENCODE_RUNTIME_PROCESS_BOOTSTRAP_STALLED_DIAGNOSTIC,
      runtimeSessionId: input.runtimeSessionId,
    });
    return;
  }
  if (input.scheduleReevaluation && input.firstSpawnAcceptedAt) {
    ports.scheduleOpenCodeBootstrapStallReevaluation(
      input.run,
      input.memberName,
      input.firstSpawnAcceptedAt
    );
  }
}

export function shouldMarkOpenCodeSecondaryBootstrapStalled(input: {
  isOpenCodeSecondaryLaneMember: boolean;
  current: MemberSpawnStatusEntry;
  bootstrapStallWindowElapsed: boolean;
}): boolean {
  return (
    input.isOpenCodeSecondaryLaneMember &&
    input.current.launchState === 'runtime_pending_bootstrap' &&
    input.current.bootstrapConfirmed !== true &&
    input.current.hardFailure !== true &&
    input.bootstrapStallWindowElapsed
  );
}

export async function markOpenCodeSecondaryBootstrapStalled(
  input: {
    run: OpenCodeBootstrapStallRunLike;
    memberName: string;
    current: MemberSpawnStatusEntry;
    isOpenCodeSecondaryLaneMember: boolean;
    bootstrapStallWindowElapsed: boolean;
    runtimeMetadata?: OpenCodeSecondaryBootstrapRuntimeMetadataLike;
  },
  ports: MarkOpenCodeSecondaryBootstrapStalledPorts
): Promise<boolean> {
  if (!shouldMarkOpenCodeSecondaryBootstrapStalled(input)) {
    return false;
  }
  const enriched: MemberSpawnStatusEntry = {
    ...input.current,
    ...(input.runtimeMetadata?.livenessKind ? { livenessKind: input.runtimeMetadata.livenessKind } : {}),
    ...(input.runtimeMetadata?.runtimeDiagnostic
      ? { runtimeDiagnostic: input.runtimeMetadata.runtimeDiagnostic }
      : {}),
    ...(input.runtimeMetadata?.runtimeDiagnosticSeverity
      ? { runtimeDiagnosticSeverity: input.runtimeMetadata.runtimeDiagnosticSeverity }
      : {}),
  };
  const diagnostic = await ports.buildOpenCodeSecondaryBootstrapStallDiagnostic(
    input.run,
    input.memberName,
    enriched
  );
  ports.setOpenCodeSecondaryBootstrapStalledStatus(
    input.run,
    input.memberName,
    enriched,
    diagnostic
  );
  await ports.maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt({
    run: input.run,
    memberName: input.memberName,
    current: enriched,
    runtimeDiagnostic: diagnostic,
    runtimeSessionId: input.runtimeMetadata?.runtimeSessionId,
  });
  return true;
}

export type OpenCodeBootstrapCheckinRetryPromptPlan =
  | { shouldSend: false; reason: string }
  | {
      shouldSend: true;
      lane: OpenCodeBootstrapStallLaneLike;
      laneRunId: string;
      runtimeSessionId: string;
      marker: string;
      diagnostics: string[];
    };

export function planOpenCodeSecondaryBootstrapCheckinRetryPrompt(input: {
  run: Pick<
    OpenCodeBootstrapStallRunLike,
    | 'mixedSecondaryLanes'
    | 'processKilled'
    | 'cancelRequested'
    | 'provisioningOutputParts'
  >;
  memberName: string;
  current: MemberSpawnStatusEntry;
  runtimeDiagnostic: string;
  runtimeSessionId?: string;
  isCurrentTrackedRun: boolean;
}): OpenCodeBootstrapCheckinRetryPromptPlan {
  const { run, memberName, current, runtimeDiagnostic } = input;
  if (
    !input.isCurrentTrackedRun ||
    run.processKilled ||
    run.cancelRequested ||
    current.launchState !== 'runtime_pending_bootstrap' ||
    current.bootstrapConfirmed === true ||
    current.hardFailure === true ||
    current.skippedForLaunch === true ||
    (current.pendingPermissionRequestIds?.length ?? 0) > 0
  ) {
    return { shouldSend: false, reason: 'inactive_or_not_retryable' };
  }

  const lane = findOpenCodeSecondaryBootstrapStallLane(run, memberName);
  const laneRunId = lane?.runId?.trim();
  const runtimeSessionId =
    input.runtimeSessionId?.trim() ||
    lane?.result?.members[memberName]?.sessionId?.trim() ||
    Object.values(lane?.result?.members ?? {})
      .find((member) => matchesTeamMemberIdentity(member.memberName ?? '', memberName))
      ?.sessionId?.trim() ||
    '';
  if (!lane || !laneRunId || !isMaterializedOpenCodeSessionId(runtimeSessionId)) {
    return { shouldSend: false, reason: 'missing_lane_or_session' };
  }
  if (
    !isExplicitLegacyOpenCodeBootstrap(resolveOpenCodeSecondaryLaneMemberEvidence(lane, memberName))
  ) {
    return { shouldSend: false, reason: 'app_managed_bootstrap' };
  }

  const diagnostics = [
    runtimeDiagnostic,
    current.runtimeDiagnostic,
    ...(lane.diagnostics ?? []),
    ...(lane.result?.diagnostics ?? []),
    ...(lane.result?.members[memberName]?.diagnostics ?? []),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (hasRealOpenCodeFailureDiagnostic(diagnostics.join('\n').toLowerCase())) {
    return { shouldSend: false, reason: 'real_failure_diagnostic' };
  }

  const marker = getOpenCodeBootstrapCheckinRetryMarker(laneRunId, runtimeSessionId);
  if (
    run.provisioningOutputParts.some((line) => line.includes(marker)) ||
    diagnostics.some((line) => line.includes(marker))
  ) {
    return { shouldSend: false, reason: 'already_sent' };
  }

  return {
    shouldSend: true,
    lane,
    laneRunId,
    runtimeSessionId,
    marker,
    diagnostics,
  };
}

export async function maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt(
  input: {
    run: OpenCodeBootstrapStallRunLike;
    memberName: string;
    current: MemberSpawnStatusEntry;
    runtimeDiagnostic: string;
    runtimeSessionId?: string;
  },
  ports: OpenCodeBootstrapStallRetryPromptPorts
): Promise<void> {
  const { run, memberName, current, runtimeDiagnostic } = input;
  const plan = planOpenCodeSecondaryBootstrapCheckinRetryPrompt({
    run,
    memberName,
    current,
    runtimeDiagnostic,
    runtimeSessionId: input.runtimeSessionId,
    isCurrentTrackedRun: ports.isCurrentTrackedRun(run),
  });
  if (!plan.shouldSend) {
    return;
  }

  const adapter = ports.getOpenCodeRuntimeMessageAdapter();
  if (!adapter) {
    return;
  }

  plan.lane.diagnostics = [...new Set([...(plan.lane.diagnostics ?? []), plan.marker])];
  ports.appendMemberBootstrapDiagnostic(run, memberName, plan.marker);

  try {
    const result = await ports.sendOpenCodeMemberMessageToRuntimeSerialized({
      teamName: run.teamName,
      laneId: plan.lane.laneId,
      send: async () =>
        await adapter.sendMessageToMember({
          runId: plan.laneRunId,
          teamName: run.teamName,
          laneId: plan.lane.laneId,
          memberName,
          cwd: plan.lane.member.cwd?.trim() || run.request.cwd,
          text: '',
          messageId: `bootstrap-checkin-retry-${run.runId}-${memberName}-${plan.runtimeSessionId}`,
          bootstrapCheckinRetry: {
            runtimeSessionId: plan.runtimeSessionId,
            reason: runtimeDiagnostic,
          },
        }),
    });
    if (!result.ok) {
      ports.appendMemberBootstrapDiagnostic(
        run,
        memberName,
        `opencode_bootstrap_checkin_retry_prompt_failed: ${
          result.diagnostics.join('; ') || 'OpenCode bridge did not accept retry prompt'
        }`
      );
    }
  } catch (error) {
    ports.appendMemberBootstrapDiagnostic(
      run,
      memberName,
      `opencode_bootstrap_checkin_retry_prompt_failed: ${getErrorMessage(error)}`
    );
  }
}

export function scheduleOpenCodeBootstrapStallReevaluation(
  run: OpenCodeBootstrapStallRunLike,
  memberName: string,
  firstSpawnAcceptedAt: string,
  ports: OpenCodeBootstrapStallTimerPorts
): void {
  const acceptedAtMs = Date.parse(firstSpawnAcceptedAt);
  if (!Number.isFinite(acceptedAtMs)) {
    return;
  }
  const stallDelayMs = Math.max(
    1_000,
    acceptedAtMs + MEMBER_BOOTSTRAP_STALL_MS - ports.nowMs()
  );
  const stallKey = `${ports.getMemberLaunchGraceKey(run, memberName)}:bootstrap-stall`;
  if (ports.hasPendingTimeout(stallKey)) {
    return;
  }
  const timer = ports.setTimeout(() => {
    ports.deletePendingTimeout(stallKey);
    void ports.reevaluateMemberLaunchStatus(run, memberName);
  }, stallDelayMs);
  timer.unref?.();
  ports.setPendingTimeout(stallKey, timer);
}
