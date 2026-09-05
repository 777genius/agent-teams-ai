import { randomUUID } from 'crypto';

import {
  freshOpenCodeExecutionProof,
  openCodeReadinessArtifactKey,
  reusableOpenCodeExecutionProof,
} from '../opencode/readiness/OpenCodeExpectedBehaviorFingerprint';
import { normalizeOpenCodeProjectIdentity } from '../opencode/readiness/OpenCodeProjectIdentity';

import {
  blockedLaunchResult,
  firstDisplayableOpenCodeFailureMessage,
  GENERIC_OPEN_CODE_MEMBER_FAILURE_REASON,
  isOpenCodeLaunchTimingDiagnostic,
  isRetryableReadinessState,
  normalizeOpenCodeFailureMessage,
} from './OpenCodeLaunchGateResult';
import {
  createLocalRuntimeInspectionState,
  preflightOpenCodeLocalModels,
} from './OpenCodeLocalModelPreflight';
import { buildMemberBootstrapPrompt } from './OpenCodeMemberBootstrapPrompt';
import { isTransientOpenCodeReadinessTransportFailure } from './OpenCodeReadinessRetryPolicy';
import { buildOpenCodeRuntimeMessageText } from './OpenCodeRuntimeMessageText';

export type { OpenCodeTeamRuntimeAdapterOptions } from './OpenCodeLocalModelPreflight';

import type {
  OpenCodeAnswerPermissionCommandBody,
  OpenCodeBridgeRuntimeSnapshot,
  OpenCodeLaunchTeamCommandBody,
  OpenCodeLaunchTeamCommandData,
  OpenCodeListRuntimePermissionsCommandBody,
  OpenCodeListRuntimePermissionsCommandData,
  OpenCodeObserveMessageDeliveryCommandBody,
  OpenCodeObserveMessageDeliveryCommandData,
  OpenCodeReconcileTeamCommandBody,
  OpenCodeRuntimePermissionCommandData,
  OpenCodeSendMessageCommandBody,
  OpenCodeSendMessageCommandData,
  OpenCodeStopTeamCommandBody,
  OpenCodeStopTeamCommandData,
  OpenCodeTeamMemberLaunchBridgeState,
} from '../opencode/bridge/OpenCodeBridgeCommandContract';
import type { OpenCodeTeamLaunchReadiness } from '../opencode/readiness/OpenCodeTeamLaunchReadiness';
import type { OpenCodeTeamRuntimeAdapterOptions } from './OpenCodeLocalModelPreflight';
import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
  TeamRuntimeLocalModelPreflightResult,
  TeamRuntimeLocalModelPreflightTarget,
  TeamRuntimeMemberLaunchEvidence,
  TeamRuntimeMemberStopEvidence,
  TeamRuntimePendingPermission,
  TeamRuntimePermissionAnswerInput,
  TeamRuntimePermissionListInput,
  TeamRuntimePermissionListResult,
  TeamRuntimePrepareResult,
  TeamRuntimeReconcileInput,
  TeamRuntimeReconcileResult,
  TeamRuntimeStopInput,
  TeamRuntimeStopResult,
} from './TeamRuntimeAdapter';
import type {
  AgentActionMode,
  InboxMessage,
  InboxMessageKind,
  OpenCodeAppManagedBootstrapCandidate,
  TaskRef,
} from '@shared/types/team';

export interface OpenCodeTeamRuntimeBridgePort {
  checkOpenCodeTeamLaunchReadiness(input: {
    projectPath: string;
    selectedModel: string | null;
    requireExecutionProbe: boolean;
    skipPermissions?: boolean;
  }): Promise<OpenCodeTeamLaunchReadiness>;
  getLastOpenCodeRuntimeSnapshot?(
    projectPath: string,
    selectedModel?: string | null,
    requireExecutionProbe?: boolean,
    skipPermissions?: boolean
  ): OpenCodeBridgeRuntimeSnapshot | null;
  launchOpenCodeTeam?(input: OpenCodeLaunchTeamCommandBody): Promise<OpenCodeLaunchTeamCommandData>;
  reconcileOpenCodeTeam?(
    input: OpenCodeReconcileTeamCommandBody
  ): Promise<OpenCodeLaunchTeamCommandData>;
  stopOpenCodeTeam?(input: OpenCodeStopTeamCommandBody): Promise<OpenCodeStopTeamCommandData>;
  sendOpenCodeTeamMessage?(
    input: OpenCodeSendMessageCommandBody
  ): Promise<OpenCodeSendMessageCommandData>;
  observeOpenCodeTeamMessageDelivery?(
    input: OpenCodeObserveMessageDeliveryCommandBody
  ): Promise<OpenCodeObserveMessageDeliveryCommandData>;
  answerOpenCodeRuntimePermission?(
    input: OpenCodeAnswerPermissionCommandBody
  ): Promise<OpenCodeLaunchTeamCommandData>;
  listOpenCodeRuntimePermissions?(
    input: OpenCodeListRuntimePermissionsCommandBody
  ): Promise<OpenCodeListRuntimePermissionsCommandData>;
}

export interface OpenCodeTeamRuntimeMessageInput {
  runId?: string;
  teamName: string;
  laneId: string;
  memberName: string;
  cwd: string;
  text: string;
  messageId?: string;
  deliveryAttemptId?: string;
  fileParts?: OpenCodeSendMessageCommandBody['fileParts'];
  replyRecipient?: string;
  actionMode?: AgentActionMode;
  messageKind?: InboxMessageKind;
  workSyncIntent?: InboxMessage['workSyncIntent'];
  workSyncReviewRequestEventIds?: string[];
  controlUrl?: string;
  taskRefs?: TaskRef[];
  forceSessionRefreshReason?: string;
  bootstrapCheckinRetry?: {
    runtimeSessionId: string;
    reason?: string;
  };
}

export interface OpenCodeTeamRuntimeMessageResult {
  ok: boolean;
  providerId: 'opencode';
  memberName: string;
  sessionId?: string;
  runtimePid?: number;
  prePromptCursor?: string | null;
  runtimePromptMessageId?: string;
  responseObservation?: OpenCodeSendMessageCommandData['responseObservation'];
  diagnostics: string[];
}

const REQUIRED_READY_CHECKPOINTS = new Set([
  'required_tools_proven',
  'delivery_ready',
  'member_ready',
  'run_ready',
]);
const OPEN_CODE_CAPABILITY_SNAPSHOT_REFRESH_RETRY_WARNING =
  'OpenCode capability snapshot changed between readiness and launch; refreshed readiness and retried launch.';
const OPEN_CODE_CAPABILITY_SNAPSHOT_PRELAUNCH_MISMATCH_MARKERS = [
  'Bridge server capability snapshot mismatch',
  'OpenCode bridge capability snapshot precondition mismatch',
];
const OPEN_CODE_CAPABILITY_SNAPSHOT_REFRESH_RETRY_LIMIT = 3;
const OPEN_CODE_READINESS_RETRY_DELAYS_MS = [750, 2_000] as const;

type OpenCodeTeamLaunchReadinessInput = Parameters<
  OpenCodeTeamRuntimeBridgePort['checkOpenCodeTeamLaunchReadiness']
>[0];

function sleepOpenCodeReadinessRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function resolveOpenCodeRuntimeSettlementMode(
  input: Pick<OpenCodeTeamRuntimeMessageInput, 'messageKind'>
): OpenCodeSendMessageCommandBody['settlementMode'] {
  return input.messageKind === 'member_work_sync_nudge' ? 'observed' : 'acceptance';
}

export class OpenCodeTeamRuntimeAdapter implements TeamLaunchRuntimeAdapter {
  readonly providerId = 'opencode' as const;
  private readonly lastProjectPathByTeamName = new Map<string, string>();
  private readonly lastReadinessByProjectPath = new Map<string, OpenCodeTeamLaunchReadiness>();
  private readonly lastReadinessByArtifactKey = new Map<string, OpenCodeTeamLaunchReadiness>();
  private readonly readinessInFlightByArtifactKey = new Map<
    string,
    Promise<OpenCodeTeamLaunchReadiness>
  >();

  constructor(
    private readonly bridge: OpenCodeTeamRuntimeBridgePort,
    private readonly options: OpenCodeTeamRuntimeAdapterOptions = {}
  ) {}

  async prepare(input: TeamRuntimeLaunchInput): Promise<TeamRuntimePrepareResult> {
    return this.prepareOpenCodeLaunch(input, false);
  }

  private async prepareOpenCodeLaunch(
    input: TeamRuntimeLaunchInput,
    forceReadinessRefresh: boolean
  ): Promise<TeamRuntimePrepareResult> {
    const runtimeOnly = input.runtimeOnly === true;
    const readiness = await this.resolveOpenCodeReadinessArtifact(
      {
        projectPath: input.cwd,
        selectedModel: input.model ?? null,
        requireExecutionProbe: !runtimeOnly,
        skipPermissions: input.skipPermissions,
      },
      forceReadinessRefresh
    );
    if (!readiness.launchAllowed) {
      return {
        ok: false,
        providerId: this.providerId,
        reason: readiness.state,
        retryable: isRetryableReadinessState(readiness.state),
        diagnostics: mergeDiagnostics(readiness.diagnostics, readiness.missing),
        warnings: [],
        ...(readiness.supportDiagnostics?.length
          ? { supportDiagnostics: [...readiness.supportDiagnostics] }
          : {}),
      };
    }

    return {
      ok: true,
      providerId: this.providerId,
      modelId: readiness.modelId,
      diagnostics: readiness.diagnostics,
      warnings: [],
      ...(readiness.supportDiagnostics?.length
        ? { supportDiagnostics: [...readiness.supportDiagnostics] }
        : {}),
    };
  }

  getLastOpenCodeTeamLaunchReadiness(projectPath: string): OpenCodeTeamLaunchReadiness | null {
    return (
      this.lastReadinessByProjectPath.get(normalizeOpenCodeProjectIdentity(projectPath)) ?? null
    );
  }

  async preflightLocalModels(input: {
    targets: readonly TeamRuntimeLocalModelPreflightTarget[];
    allowExperimentalLocalModels?: boolean;
  }): Promise<TeamRuntimeLocalModelPreflightResult> {
    return preflightOpenCodeLocalModels(
      this.options,
      input.targets,
      createLocalRuntimeInspectionState(),
      input.allowExperimentalLocalModels === true
    );
  }

  private async checkOpenCodeReadinessWithTransientRetry(
    input: OpenCodeTeamLaunchReadinessInput
  ): Promise<OpenCodeTeamLaunchReadiness> {
    let readiness = await this.bridge.checkOpenCodeTeamLaunchReadiness(input);
    for (const delayMs of OPEN_CODE_READINESS_RETRY_DELAYS_MS) {
      if (!isTransientOpenCodeReadinessTransportFailure(readiness)) {
        return readiness;
      }
      await sleepOpenCodeReadinessRetry(delayMs);
      readiness = await this.bridge.checkOpenCodeTeamLaunchReadiness(input);
    }
    return readiness;
  }

  private async resolveOpenCodeReadinessArtifact(
    input: OpenCodeTeamLaunchReadinessInput,
    forceRefresh = false
  ): Promise<OpenCodeTeamLaunchReadiness> {
    const artifactKey = openCodeReadinessArtifactKey(input);
    const cached = this.lastReadinessByArtifactKey.get(artifactKey);
    if (!forceRefresh && cached?.launchAllowed && reusableOpenCodeExecutionProof(cached, input)) {
      return cached;
    }

    const inFlight = this.readinessInFlightByArtifactKey.get(artifactKey);
    if (!forceRefresh && inFlight) {
      return inFlight;
    }

    const request = this.checkOpenCodeReadinessWithTransientRetry(input)
      .then((readiness) => {
        this.lastReadinessByProjectPath.set(
          normalizeOpenCodeProjectIdentity(input.projectPath),
          readiness
        );
        this.lastReadinessByArtifactKey.set(artifactKey, readiness);
        return readiness;
      })
      .finally(() => {
        if (this.readinessInFlightByArtifactKey.get(artifactKey) === request) {
          this.readinessInFlightByArtifactKey.delete(artifactKey);
        }
      });
    this.readinessInFlightByArtifactKey.set(artifactKey, request);
    return request;
  }

  async launch(input: TeamRuntimeLaunchInput): Promise<TeamRuntimeLaunchResult> {
    const memberValidationDiagnostics = validateOpenCodeRuntimeMembers(
      input.expectedMembers,
      input.cwd
    );
    if (memberValidationDiagnostics.length > 0) {
      return blockedLaunchResult(
        input,
        'opencode_invalid_expected_members',
        memberValidationDiagnostics
      );
    }

    // App-managed OpenCode launch requires a fresh capability snapshot from
    // readiness before any state-changing bridge command can run.
    const skipReadinessPreflight = false;
    const requestedModel = input.model?.trim() ?? '';
    let selectedModel = requestedModel;
    let launchWarnings: string[] = [];
    const localRuntimeInspectionState = createLocalRuntimeInspectionState();

    // Reject incompatible local runtimes before OpenCode starts its execution probe.
    // Mixed-model lanes cannot bypass this guard through a custom source id.
    const localModelTargets = [
      { projectPath: input.cwd, modelRoute: selectedModel },
      ...input.expectedMembers.map((member) => ({
        projectPath: member.cwd?.trim() || input.cwd,
        modelRoute: member.model?.trim() ?? '',
      })),
    ];
    const localModelPreflight = await preflightOpenCodeLocalModels(
      this.options,
      localModelTargets,
      localRuntimeInspectionState,
      input.allowExperimentalLocalModels === true
    );
    if (!localModelPreflight.ok) {
      return blockedLaunchResult(input, 'model_unavailable', localModelPreflight.diagnostics);
    }
    launchWarnings = mergeDiagnostics(launchWarnings, localModelPreflight.warnings);

    if (!skipReadinessPreflight) {
      // State-changing launch always requires a fresh real execution proof.
      const prepared = await this.prepareOpenCodeLaunch({ ...input, runtimeOnly: false }, true);
      if (!prepared.ok) {
        const diagnostics =
          prepared.reason === 'mcp_unavailable' || prepared.reason === 'unknown_error'
            ? ['OpenCode is temporarily unavailable. Retry the launch.', ...prepared.diagnostics]
            : prepared.diagnostics;
        return blockedLaunchResult(input, prepared.reason, diagnostics, prepared.warnings, {
          preLaunchGate: true,
        });
      }
      const readinessModel = prepared.modelId?.trim() ?? '';
      if (requestedModel && readinessModel !== requestedModel) {
        return blockedLaunchResult(input, 'opencode_expected_behavior_evidence_invalid', [
          `OpenCode readiness returned model ${readinessModel || '(missing)'} for requested model ${requestedModel}`,
        ]);
      }
      selectedModel = readinessModel || selectedModel;
      launchWarnings = mergeDiagnostics(launchWarnings, prepared.warnings);
    }

    if (!this.bridge.launchOpenCodeTeam) {
      return blockedLaunchResult(input, 'opencode_launch_bridge_missing', [
        'OpenCode state-changing launch bridge is not registered.',
      ]);
    }

    if (!selectedModel) {
      return blockedLaunchResult(input, 'opencode_model_unavailable', [
        'OpenCode launch requires a selected raw model id.',
      ]);
    }

    const selectedLocalModelPreflight = await preflightOpenCodeLocalModels(
      this.options,
      [{ projectPath: input.cwd, modelRoute: selectedModel }],
      localRuntimeInspectionState,
      input.allowExperimentalLocalModels === true
    );
    if (!selectedLocalModelPreflight.ok) {
      return blockedLaunchResult(
        input,
        'model_unavailable',
        selectedLocalModelPreflight.diagnostics
      );
    }
    launchWarnings = mergeDiagnostics(launchWarnings, selectedLocalModelPreflight.warnings);

    const readinessInput: OpenCodeTeamLaunchReadinessInput = {
      projectPath: input.cwd,
      selectedModel: input.model ?? null,
      requireExecutionProbe: true,
      skipPermissions: input.skipPermissions,
    };
    let runtimeSnapshot = skipReadinessPreflight
      ? null
      : (this.bridge.getLastOpenCodeRuntimeSnapshot?.(
          input.cwd,
          readinessInput.selectedModel,
          readinessInput.requireExecutionProbe,
          readinessInput.skipPermissions
        ) ?? null);
    let proofBinding: ReturnType<typeof freshOpenCodeExecutionProof>;
    try {
      proofBinding = freshOpenCodeExecutionProof(
        this.lastReadinessByArtifactKey.get(openCodeReadinessArtifactKey(readinessInput)),
        { projectPath: input.cwd, fullModelId: selectedModel }
      );
    } catch (error) {
      return blockedLaunchResult(input, 'opencode_expected_behavior_evidence_invalid', [
        error instanceof Error ? error.message : String(error),
      ]);
    }
    let executionProof = proofBinding.proof;
    if (
      !skipReadinessPreflight &&
      this.bridge.getLastOpenCodeRuntimeSnapshot &&
      !runtimeSnapshot?.capabilitySnapshotId
    ) {
      return blockedLaunchResult(input, 'opencode_capability_snapshot_missing', [
        'OpenCode app-managed launch requires a fresh capability snapshot before state-changing launch.',
      ]);
    }
    if (
      runtimeSnapshot?.capabilitySnapshotId &&
      executionProof.capabilitySnapshotId !== runtimeSnapshot.capabilitySnapshotId
    ) {
      return blockedLaunchResult(input, 'opencode_expected_behavior_evidence_invalid', [
        'OpenCode launch execution proof belongs to another capability snapshot',
      ]);
    }
    this.lastProjectPathByTeamName.set(input.teamName, input.cwd);
    const buildLaunchCommand = (
      snapshot: OpenCodeBridgeRuntimeSnapshot | null,
      model: string,
      recoveryAttemptId?: string
    ): OpenCodeLaunchTeamCommandBody => ({
      runId: input.runId,
      laneId: input.laneId?.trim() || 'primary',
      teamId: input.teamName,
      teamName: input.teamName,
      projectPath: input.cwd,
      selectedModel: model,
      ...(input.effort ? { effort: input.effort } : {}),
      skipPermissions: input.skipPermissions,
      members: input.expectedMembers.map((member) => {
        const effort = member.effort ?? input.effort;
        return {
          name: member.name,
          role: member.role?.trim() || member.workflow?.trim() || 'teammate',
          prompt: buildMemberBootstrapPrompt(input, member),
          ...(effort ? { effort } : {}),
        };
      }),
      leadPrompt: input.prompt?.trim() ?? '',
      expectedCapabilitySnapshotId: snapshot?.capabilitySnapshotId ?? null,
      expectedBehaviorFingerprint: proofBinding.expectedBehaviorFingerprint,
      manifestHighWatermark: null,
      ...(executionProof ? { executionProof } : {}),
      ...(recoveryAttemptId ? { capabilitySnapshotRecoveryAttemptId: recoveryAttemptId } : {}),
    });

    let data = await this.bridge.launchOpenCodeTeam(
      buildLaunchCommand(runtimeSnapshot, selectedModel)
    );
    let capabilitySnapshotRefreshAttempts = 0;
    while (
      !skipReadinessPreflight &&
      isOpenCodePreLaunchCapabilitySnapshotMismatchData(data) &&
      capabilitySnapshotRefreshAttempts < OPEN_CODE_CAPABILITY_SNAPSHOT_REFRESH_RETRY_LIMIT
    ) {
      capabilitySnapshotRefreshAttempts += 1;
      const refreshed = await this.prepareOpenCodeLaunch(input, true);
      if (!refreshed.ok) {
        return blockedLaunchResult(
          input,
          refreshed.reason,
          mergeDiagnostics(data.diagnostics.map(formatOpenCodeBridgeDiagnostic), [
            OPEN_CODE_CAPABILITY_SNAPSHOT_REFRESH_RETRY_WARNING,
            ...refreshed.diagnostics,
          ]),
          mergeDiagnostics(launchWarnings, refreshed.warnings)
        );
      }
      const refreshedModel = refreshed.modelId?.trim() ?? '';
      if (requestedModel && refreshedModel !== requestedModel) {
        return blockedLaunchResult(input, 'opencode_expected_behavior_evidence_invalid', [
          `OpenCode readiness returned model ${refreshedModel || '(missing)'} for requested model ${requestedModel}`,
        ]);
      }
      selectedModel = refreshedModel || selectedModel;
      const refreshedLocalModelPreflight = await preflightOpenCodeLocalModels(
        this.options,
        [{ projectPath: input.cwd, modelRoute: selectedModel }],
        localRuntimeInspectionState,
        input.allowExperimentalLocalModels === true
      );
      if (!refreshedLocalModelPreflight.ok) {
        return blockedLaunchResult(
          input,
          'model_unavailable',
          refreshedLocalModelPreflight.diagnostics
        );
      }
      launchWarnings = mergeDiagnostics(launchWarnings, refreshedLocalModelPreflight.warnings);
      const refreshedSnapshot =
        this.bridge.getLastOpenCodeRuntimeSnapshot?.(
          input.cwd,
          readinessInput.selectedModel,
          readinessInput.requireExecutionProbe,
          readinessInput.skipPermissions
        ) ?? null;
      if (refreshedSnapshot?.capabilitySnapshotId) {
        runtimeSnapshot = refreshedSnapshot;
        try {
          proofBinding = freshOpenCodeExecutionProof(
            this.lastReadinessByArtifactKey.get(openCodeReadinessArtifactKey(readinessInput)),
            { projectPath: input.cwd, fullModelId: selectedModel }
          );
          executionProof = proofBinding.proof;
          if (executionProof.capabilitySnapshotId !== runtimeSnapshot.capabilitySnapshotId) {
            return blockedLaunchResult(input, 'opencode_expected_behavior_evidence_invalid', [
              'OpenCode launch execution proof belongs to another capability snapshot',
            ]);
          }
        } catch (error) {
          return blockedLaunchResult(input, 'opencode_expected_behavior_evidence_invalid', [
            error instanceof Error ? error.message : String(error),
          ]);
        }
        launchWarnings = mergeDiagnostics(launchWarnings, [
          ...refreshed.warnings,
          OPEN_CODE_CAPABILITY_SNAPSHOT_REFRESH_RETRY_WARNING,
        ]);
        // TODO(opencode-bridge): replace marker-based capability recovery with
        // structured bridge failure details: expectedCapabilitySnapshotId,
        // actualCapabilitySnapshotId, preconditionStage, and safeToRetryWithFreshCommand.
        // Keep this app-side attempt id until packaged runtimes all expose that protocol.
        data = await this.bridge.launchOpenCodeTeam(
          buildLaunchCommand(
            runtimeSnapshot,
            selectedModel,
            `opencode-capability-recovery-${randomUUID()}`
          )
        );
      } else {
        break;
      }
    }

    const launchResult = mapOpenCodeLaunchDataToRuntimeResult(input, data, launchWarnings);
    if (
      launchResult.teamLaunchState === 'clean_success' &&
      data.expectedBehaviorFingerprint !== proofBinding.expectedBehaviorFingerprint
    ) {
      return blockedLaunchResult(input, 'opencode_launch_behavior_fingerprint_mismatch', [
        'OpenCode launch result behavior fingerprint mismatch',
      ]);
    }
    return launchResult;
  }

  async reconcile(input: TeamRuntimeReconcileInput): Promise<TeamRuntimeReconcileResult> {
    const memberValidationDiagnostics = validateOpenCodeRuntimeMembers(input.expectedMembers);
    if (memberValidationDiagnostics.length > 0) {
      return {
        ...blockedLaunchResult(
          {
            runId: input.runId,
            teamName: input.teamName,
            cwd: input.expectedMembers[0]?.cwd ?? '',
            providerId: this.providerId,
            skipPermissions: false,
            expectedMembers: input.expectedMembers,
            previousLaunchState: input.previousLaunchState,
          },
          'opencode_invalid_expected_members',
          memberValidationDiagnostics
        ),
        snapshot: input.previousLaunchState,
      };
    }

    if (this.bridge.reconcileOpenCodeTeam) {
      const projectPath =
        input.expectedMembers[0]?.cwd ?? this.lastProjectPathByTeamName.get(input.teamName);
      const data = await this.bridge.reconcileOpenCodeTeam({
        runId: input.runId,
        laneId: input.laneId?.trim() || 'primary',
        teamId: input.teamName,
        teamName: input.teamName,
        projectPath,
        // The command service binds the persisted lane manifest, never a project-latest probe.
        expectedCapabilitySnapshotId: null,
        manifestHighWatermark: null,
        reconcileAttemptId: `opencode-reconcile-${randomUUID()}`,
        expectedMembers: input.expectedMembers.map((member) => ({
          name: member.name,
          model: member.model ?? null,
        })),
        reason: input.reason,
      });
      const mapped = mapOpenCodeLaunchDataToRuntimeResult(
        {
          runId: input.runId,
          teamName: input.teamName,
          cwd: input.expectedMembers[0]?.cwd ?? '',
          providerId: this.providerId,
          skipPermissions: false,
          expectedMembers: input.expectedMembers,
          previousLaunchState: input.previousLaunchState,
        },
        data,
        []
      );
      return {
        ...mapped,
        snapshot: input.previousLaunchState,
      };
    }

    const snapshot = input.previousLaunchState;
    if (!snapshot) {
      return {
        runId: input.runId,
        teamName: input.teamName,
        launchPhase: 'reconciled',
        teamLaunchState: 'partial_pending',
        members: {},
        snapshot: null,
        warnings: [],
        diagnostics: ['No previous OpenCode launch snapshot was available for reconciliation.'],
      };
    }

    return {
      runId: input.runId,
      teamName: input.teamName,
      launchPhase: snapshot.launchPhase,
      teamLaunchState: snapshot.teamLaunchState,
      members: Object.fromEntries(
        Object.entries(snapshot.members).map(([memberName, member]) => [
          memberName,
          {
            memberName,
            providerId: this.providerId,
            launchState: member.launchState,
            agentToolAccepted: member.agentToolAccepted,
            runtimeAlive: member.bootstrapConfirmed === true,
            bootstrapConfirmed: member.bootstrapConfirmed,
            hardFailure: member.hardFailure,
            hardFailureReason: member.hardFailureReason,
            diagnostics: member.diagnostics ?? [],
          } satisfies TeamRuntimeMemberLaunchEvidence,
        ])
      ),
      snapshot,
      warnings: [],
      diagnostics: [`OpenCode launch snapshot reconciled from ${input.reason}.`],
    };
  }

  async sendMessageToMember(
    input: OpenCodeTeamRuntimeMessageInput
  ): Promise<OpenCodeTeamRuntimeMessageResult> {
    if (!this.bridge.sendOpenCodeTeamMessage) {
      return {
        ok: false,
        providerId: this.providerId,
        memberName: input.memberName,
        diagnostics: ['OpenCode message bridge is not registered.'],
      };
    }

    const data = await this.bridge.sendOpenCodeTeamMessage({
      runId: input.runId,
      laneId: input.laneId,
      teamId: input.teamName,
      teamName: input.teamName,
      projectPath: input.cwd,
      memberName: input.memberName,
      text: buildOpenCodeRuntimeMessageText(input),
      messageId: input.messageId,
      ...(input.deliveryAttemptId ? { deliveryAttemptId: input.deliveryAttemptId } : {}),
      ...(input.forceSessionRefreshReason
        ? { forceSessionRefreshReason: input.forceSessionRefreshReason }
        : {}),
      settlementMode: resolveOpenCodeRuntimeSettlementMode(input),
      fileParts: input.fileParts,
      actionMode: input.actionMode,
      messageKind: input.messageKind,
      taskRefs: input.taskRefs,
      agent: 'teammate',
    });

    return {
      ok: data.accepted,
      providerId: this.providerId,
      memberName: input.memberName,
      sessionId: data.sessionId,
      runtimePid: data.runtimePid,
      prePromptCursor: data.prePromptCursor,
      runtimePromptMessageId: data.runtimePromptMessageId,
      responseObservation: data.responseObservation,
      diagnostics: data.diagnostics.map((diagnostic) => diagnostic.message),
    };
  }

  async observeMessageDelivery(
    input: OpenCodeTeamRuntimeMessageInput & {
      prePromptCursor?: string | null;
      sessionId?: string;
      runtimePromptMessageId?: string;
    }
  ): Promise<OpenCodeTeamRuntimeMessageResult> {
    if (!this.bridge.observeOpenCodeTeamMessageDelivery) {
      return {
        ok: false,
        providerId: this.providerId,
        memberName: input.memberName,
        diagnostics: ['OpenCode message delivery observe bridge is not registered.'],
      };
    }
    if (!input.messageId?.trim()) {
      return {
        ok: false,
        providerId: this.providerId,
        memberName: input.memberName,
        diagnostics: ['OpenCode message delivery observe requires messageId.'],
      };
    }

    const data = await this.bridge.observeOpenCodeTeamMessageDelivery({
      runId: input.runId,
      laneId: input.laneId,
      teamId: input.teamName,
      teamName: input.teamName,
      projectPath: input.cwd,
      memberName: input.memberName,
      messageId: input.messageId,
      sessionId: input.sessionId,
      runtimePromptMessageId: input.runtimePromptMessageId,
      prePromptCursor: input.prePromptCursor ?? null,
    });

    return {
      ok: data.observed,
      providerId: this.providerId,
      memberName: input.memberName,
      sessionId: data.sessionId,
      runtimePid: data.runtimePid,
      runtimePromptMessageId: data.runtimePromptMessageId,
      responseObservation: data.responseObservation,
      diagnostics: data.diagnostics.map((diagnostic) => diagnostic.message),
    };
  }

  async answerRuntimePermission(
    input: TeamRuntimePermissionAnswerInput
  ): Promise<TeamRuntimeLaunchResult> {
    if (!this.bridge.answerOpenCodeRuntimePermission) {
      throw new Error('OpenCode permission answer bridge is not registered.');
    }

    const data = await this.bridge.answerOpenCodeRuntimePermission({
      runId: input.runId,
      laneId: input.laneId?.trim() || 'primary',
      teamId: input.teamName,
      teamName: input.teamName,
      projectPath: input.cwd,
      memberName: input.memberName,
      requestId: input.requestId,
      decision: input.decision,
      ...(input.message === undefined ? {} : { message: input.message }),
      expectedCapabilitySnapshotId: null,
      manifestHighWatermark: null,
    });

    return mapOpenCodeLaunchDataToRuntimeResult(
      {
        runId: input.runId,
        teamName: input.teamName,
        laneId: input.laneId,
        cwd: input.cwd,
        providerId: this.providerId,
        skipPermissions: false,
        expectedMembers: input.expectedMembers,
        previousLaunchState: input.previousLaunchState,
      },
      data,
      []
    );
  }

  async listRuntimePermissions(
    input: TeamRuntimePermissionListInput
  ): Promise<TeamRuntimePermissionListResult> {
    if (!this.bridge.listOpenCodeRuntimePermissions) {
      return {
        permissions: [],
        diagnostics: ['OpenCode runtime permission list bridge is not registered.'],
      };
    }

    const data = await this.bridge.listOpenCodeRuntimePermissions({
      teamId: input.teamName,
      teamName: input.teamName,
      laneId: input.laneId,
      memberName: input.memberName,
      sessionId: input.sessionId,
      projectPath: input.cwd,
    });
    return {
      permissions: normalizeOpenCodeRuntimePendingPermissions(data.permissions) ?? [],
      diagnostics: data.diagnostics ?? [],
    };
  }

  async stop(input: TeamRuntimeStopInput): Promise<TeamRuntimeStopResult> {
    if (this.bridge.stopOpenCodeTeam) {
      const projectPath = input.cwd ?? this.lastProjectPathByTeamName.get(input.teamName);
      const data = await this.bridge.stopOpenCodeTeam({
        runId: input.runId,
        laneId: input.laneId?.trim() || 'primary',
        teamId: input.teamName,
        teamName: input.teamName,
        projectPath,
        // The command service binds the persisted lane manifest, never a project-latest probe.
        expectedCapabilitySnapshotId: null,
        manifestHighWatermark: null,
        reason: input.reason,
        force: input.force,
      });
      if (data.stopped) {
        this.lastProjectPathByTeamName.delete(input.teamName);
      }
      return {
        runId: input.runId,
        teamName: input.teamName,
        stopped: data.stopped,
        members: Object.fromEntries(
          Object.entries(data.members).map(([memberName, member]) => [
            memberName,
            {
              memberName,
              providerId: this.providerId,
              stopped: member.stopped,
              sessionId: member.sessionId,
              diagnostics: member.diagnostics,
            } satisfies TeamRuntimeMemberStopEvidence,
          ])
        ),
        warnings: data.warnings.map((warning) => warning.message),
        diagnostics: data.diagnostics.map(formatOpenCodeBridgeDiagnostic),
      };
    }

    const members = input.previousLaunchState
      ? Object.fromEntries(
          Object.keys(input.previousLaunchState.members).map((memberName) => [
            memberName,
            {
              memberName,
              providerId: this.providerId,
              stopped: true,
              diagnostics: [
                'No live OpenCode session stop command is wired in this adapter shell.',
              ],
            } satisfies TeamRuntimeMemberStopEvidence,
          ])
        )
      : {};

    return {
      runId: input.runId,
      teamName: input.teamName,
      stopped: true,
      members,
      warnings: [],
      diagnostics: input.previousLaunchState
        ? ['OpenCode stop was acknowledged without live session ownership changes.']
        : ['No previous OpenCode launch snapshot was available to stop.'],
    };
  }
}

function mapOpenCodeLaunchDataToRuntimeResult(
  input: TeamRuntimeLaunchInput,
  data: OpenCodeLaunchTeamCommandData,
  prepareWarnings: string[]
): TeamRuntimeLaunchResult {
  const bridgeDiagnostics = data.diagnostics.map(formatOpenCodeBridgeDiagnostic);
  const memberBridgeDiagnostics = bridgeDiagnostics.filter(
    (diagnostic) => !isOpenCodeLaunchTimingDiagnostic(diagnostic)
  );
  const checkpointNames = extractCheckpointNames(data);
  const readyCheckpointsPresent = [...REQUIRED_READY_CHECKPOINTS].every((name) =>
    checkpointNames.has(name)
  );
  const bridgeReady = data.teamLaunchState === 'ready';
  const isExpectedMemberConfirmed = (memberName: string): boolean => {
    const bridgeMember = data.members[memberName];
    return bridgeMember?.launchState === 'confirmed_alive';
  };
  const missingExpectedMembers = input.expectedMembers
    .map((member) => member.name)
    .filter((memberName) => data.members[memberName] == null);
  const unconfirmedExpectedMembers = input.expectedMembers
    .map((member) => member.name)
    .filter((memberName) => !isExpectedMemberConfirmed(memberName));
  const anyExpectedMemberFailed = input.expectedMembers.some(
    (member) => data.members[member.name]?.launchState === 'failed'
  );
  const allExpectedMembersConfirmed =
    input.expectedMembers.length > 0 && unconfirmedExpectedMembers.length === 0;
  const success =
    (bridgeReady && readyCheckpointsPresent && allExpectedMembersConfirmed) ||
    (data.teamLaunchState === 'launching' && allExpectedMembersConfirmed);
  const checkpointDiagnostic = success
    ? []
    : bridgeReady && !readyCheckpointsPresent
      ? [
          `OpenCode bridge reported ready without all required durable checkpoints: missing ${[
            ...REQUIRED_READY_CHECKPOINTS,
          ]
            .filter((name) => !checkpointNames.has(name))
            .join(', ')}`,
        ]
      : [];
  const incompleteReadyDiagnostic =
    bridgeReady && readyCheckpointsPresent && !allExpectedMembersConfirmed
      ? [
          `OpenCode bridge reported ready before all expected members were confirmed: pending ${unconfirmedExpectedMembers.join(', ')}`,
        ]
      : [];

  const members = Object.fromEntries(
    input.expectedMembers.map((member) => {
      const bridgeMember = data.members[member.name];
      const fallbackLaunchState = bridgeMember
        ? bridgeMember.launchState
        : data.teamLaunchState === 'failed'
          ? 'failed'
          : 'created';
      const checkpointDiagnosticsForMember = [
        ...checkpointDiagnostic,
        ...(missingExpectedMembers.includes(member.name) ? incompleteReadyDiagnostic : []),
      ];
      const memberDiagnostics = [
        ...(bridgeMember
          ? []
          : [
              `OpenCode bridge response did not include ${member.name}; keeping the member pending until lane state materializes.`,
            ]),
        ...(bridgeMember?.diagnostics ?? []),
        ...(bridgeMember?.evidence ?? []).map(
          (evidence) => `${evidence.kind} at ${evidence.observedAt}`
        ),
        ...memberBridgeDiagnostics,
        ...checkpointDiagnosticsForMember,
      ];
      return [
        member.name,
        mapBridgeMemberToRuntimeEvidence(
          member.name,
          fallbackLaunchState,
          bridgeMember?.sessionId,
          bridgeMember?.model,
          bridgeMember?.runtimePid,
          bridgeMember?.pendingPermissionRequestIds,
          bridgeMember?.pendingPermissions,
          bridgeMember != null,
          memberDiagnostics,
          input.runId,
          input.laneId?.trim() || 'primary',
          input.teamName,
          bridgeMember?.bootstrapEvidenceSource,
          bridgeMember?.bootstrapMode,
          bridgeMember?.appManagedBootstrapCandidate,
          selectOpenCodeMemberFailureReason({
            memberDiagnostics: bridgeMember?.diagnostics ?? [],
            bridgeDiagnostics: data.diagnostics,
            checkpointDiagnostics: checkpointDiagnosticsForMember,
            fallback: GENERIC_OPEN_CODE_MEMBER_FAILURE_REASON,
          })
        ),
      ];
    })
  );

  return {
    runId: input.runId,
    teamName: input.teamName,
    launchPhase: success
      ? 'finished'
      : data.teamLaunchState === 'launching' || (bridgeReady && !anyExpectedMemberFailed)
        ? 'active'
        : 'finished',
    teamLaunchState: success
      ? 'clean_success'
      : anyExpectedMemberFailed || data.teamLaunchState === 'failed'
        ? 'partial_failure'
        : data.teamLaunchState === 'launching' ||
            data.teamLaunchState === 'permission_blocked' ||
            bridgeReady
          ? 'partial_pending'
          : 'partial_failure',
    members,
    warnings: [...prepareWarnings, ...data.warnings.map((warning) => warning.message)],
    diagnostics: [...bridgeDiagnostics, ...checkpointDiagnostic, ...incompleteReadyDiagnostic],
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeAppManagedBootstrapCandidate(
  value: OpenCodeAppManagedBootstrapCandidate | undefined,
  expected: {
    teamName: string;
    memberName: string;
    runId: string;
    laneId: string;
    runtimeSessionId?: string;
  }
): OpenCodeAppManagedBootstrapCandidate | undefined {
  if (value?.schemaVersion !== 1 || value.source !== 'app_managed_bootstrap') {
    return undefined;
  }
  if (
    value.teamName !== expected.teamName ||
    value.memberName !== expected.memberName ||
    value.runId !== expected.runId ||
    value.laneId !== expected.laneId ||
    (expected.runtimeSessionId && value.runtimeSessionId !== expected.runtimeSessionId)
  ) {
    return undefined;
  }
  if (
    !isNonEmptyString(value.runtimeSessionId) ||
    !isNonEmptyString(value.messageID) ||
    !value.messageID.startsWith('msg') ||
    !isNonEmptyString(value.contextHash) ||
    !isNonEmptyString(value.briefingHash) ||
    !isNonEmptyString(value.injectionVerifiedAt) ||
    !isNonEmptyString(value.candidateAt)
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    source: 'app_managed_bootstrap',
    teamName: value.teamName,
    memberName: value.memberName,
    runId: value.runId,
    laneId: value.laneId,
    runtimeSessionId: value.runtimeSessionId,
    messageID: value.messageID,
    contextHash: value.contextHash,
    briefingHash: value.briefingHash,
    injectionVerifiedAt: value.injectionVerifiedAt,
    candidateAt: value.candidateAt,
    ...(isNonEmptyString(value.model) ? { model: value.model } : {}),
    ...(isNonEmptyString(value.agent) ? { agent: value.agent } : {}),
  };
}

function normalizeOpenCodeRuntimePendingPermissions(
  permissions: OpenCodeRuntimePermissionCommandData[] | undefined
): TeamRuntimePendingPermission[] | undefined {
  if (!permissions?.length) {
    return undefined;
  }
  const normalized: TeamRuntimePendingPermission[] = [];
  const seen = new Set<string>();
  for (const permission of permissions) {
    const requestId = permission.requestId?.trim();
    if (!requestId || seen.has(requestId)) {
      continue;
    }
    seen.add(requestId);
    normalized.push({
      providerId: 'opencode',
      requestId,
      sessionId: permission.sessionId ?? null,
      tool: permission.tool ?? null,
      title: permission.title ?? null,
      kind: permission.kind ?? null,
      ...(permission.raw ? { raw: permission.raw } : {}),
    });
  }
  return normalized.length > 0 ? normalized : undefined;
}

function mapBridgeMemberToRuntimeEvidence(
  memberName: string,
  launchState: OpenCodeTeamMemberLaunchBridgeState,
  sessionId: string | undefined,
  model: string | undefined,
  runtimePid: number | undefined,
  pendingPermissionRequestIds: string[] | undefined,
  pendingPermissions: OpenCodeRuntimePermissionCommandData[] | undefined,
  runtimeMaterialized: boolean,
  diagnostics: string[],
  runId: string,
  laneId: string,
  teamName: string,
  bootstrapEvidenceSource: TeamRuntimeMemberLaunchEvidence['bootstrapEvidenceSource'] | undefined,
  bootstrapMode: TeamRuntimeMemberLaunchEvidence['bootstrapMode'] | undefined,
  appManagedBootstrapCandidate: OpenCodeAppManagedBootstrapCandidate | undefined,
  selectedHardFailureReason: string
): TeamRuntimeMemberLaunchEvidence {
  const normalizedAppManagedCandidate = normalizeAppManagedBootstrapCandidate(
    appManagedBootstrapCandidate,
    {
      teamName,
      memberName,
      runId,
      laneId,
      runtimeSessionId: sessionId,
    }
  );
  const appManagedCandidatePresent =
    launchState === 'created' &&
    isNonEmptyString(sessionId) &&
    bootstrapEvidenceSource === 'app_managed_bootstrap' &&
    bootstrapMode === 'app_managed_context' &&
    normalizedAppManagedCandidate != null;
  const confirmed = launchState === 'confirmed_alive';
  const failed = launchState === 'failed';
  const hasRuntimePid =
    typeof runtimePid === 'number' && Number.isFinite(runtimePid) && runtimePid > 0;
  const hasSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0;
  const hasRuntimeHandle = hasRuntimePid || hasSessionId;
  const pendingRuntimeObserved = launchState === 'created' && hasRuntimeHandle;
  const livenessKind = confirmed
    ? 'confirmed_bootstrap'
    : pendingRuntimeObserved
      ? 'runtime_process_candidate'
      : launchState === 'permission_blocked'
        ? 'permission_blocked'
        : 'registered_only';
  const runtimeDiagnostic = appManagedCandidatePresent
    ? 'OpenCode app-managed bootstrap context was injected and verified by the bridge; waiting for app-owned durable evidence commit.'
    : pendingRuntimeObserved
      ? hasRuntimePid
        ? 'OpenCode runtime pid reported by bridge without local process verification'
        : 'OpenCode session exists without verified runtime pid'
      : launchState === 'permission_blocked'
        ? 'OpenCode runtime is waiting for permission approval'
        : runtimeMaterialized
          ? 'OpenCode bridge did not report a runtime session or pid for this member'
          : undefined;
  const runtimeDiagnosticSeverity = appManagedCandidatePresent
    ? 'info'
    : failed
      ? 'error'
      : pendingRuntimeObserved || launchState === 'permission_blocked' || runtimeMaterialized
        ? 'warning'
        : undefined;
  const normalizedPendingApprovals = normalizeOpenCodeRuntimePendingPermissions(pendingPermissions);
  return {
    memberName,
    providerId: 'opencode',
    ...(isNonEmptyString(model) ? { model: model.trim() } : {}),
    launchState: failed
      ? 'failed_to_start'
      : confirmed
        ? 'confirmed_alive'
        : launchState === 'permission_blocked'
          ? 'runtime_pending_permission'
          : 'runtime_pending_bootstrap',
    agentToolAccepted:
      confirmed ||
      pendingRuntimeObserved ||
      launchState === 'permission_blocked' ||
      hasRuntimeHandle,
    runtimeAlive: confirmed,
    bootstrapConfirmed: confirmed,
    hardFailure: failed,
    hardFailureReason: failed ? selectedHardFailureReason : undefined,
    pendingPermissionRequestIds:
      pendingPermissionRequestIds && pendingPermissionRequestIds.length > 0
        ? [...new Set(pendingPermissionRequestIds)]
        : undefined,
    pendingApprovals: normalizedPendingApprovals,
    pendingPermissions: normalizedPendingApprovals,
    sessionId,
    ...(appManagedCandidatePresent
      ? { bootstrapEvidenceSource: 'app_managed_bootstrap' as const }
      : {}),
    ...(appManagedCandidatePresent ? { bootstrapMode: 'app_managed_context' as const } : {}),
    ...(normalizedAppManagedCandidate
      ? { appManagedBootstrapCandidate: normalizedAppManagedCandidate }
      : {}),
    ...(hasRuntimePid ? { runtimePid } : {}),
    livenessKind,
    ...(hasRuntimePid ? { pidSource: 'opencode_bridge' as const } : {}),
    ...(runtimeDiagnostic ? { runtimeDiagnostic } : {}),
    ...(runtimeDiagnosticSeverity ? { runtimeDiagnosticSeverity } : {}),
    diagnostics,
  };
}

function selectOpenCodeMemberFailureReason(input: {
  memberDiagnostics: readonly string[];
  bridgeDiagnostics: readonly {
    code: string;
    severity: 'info' | 'warning' | 'error';
    message: string;
  }[];
  checkpointDiagnostics: readonly string[];
  fallback: string;
}): string {
  return (
    firstDisplayableOpenCodeFailureMessage(input.memberDiagnostics, { includeGeneric: false }) ??
    firstDisplayableOpenCodeFailureMessage(
      input.bridgeDiagnostics
        .filter((diagnostic) => diagnostic.severity === 'error')
        .map((diagnostic) => diagnostic.message),
      { includeGeneric: false }
    ) ??
    firstDisplayableOpenCodeFailureMessage(input.memberDiagnostics, { includeGeneric: true }) ??
    firstDisplayableOpenCodeFailureMessage(input.checkpointDiagnostics, { includeGeneric: true }) ??
    firstDisplayableOpenCodeFailureMessage(
      input.bridgeDiagnostics
        .filter((diagnostic) => diagnostic.severity !== 'info')
        .map((diagnostic) => diagnostic.message),
      { includeGeneric: true }
    ) ??
    normalizeOpenCodeFailureMessage(input.fallback) ??
    GENERIC_OPEN_CODE_MEMBER_FAILURE_REASON
  );
}

function extractCheckpointNames(data: OpenCodeLaunchTeamCommandData): Set<string> {
  const names = new Set<string>();
  for (const checkpoint of data.durableCheckpoints ?? []) {
    if (checkpoint.name.trim()) names.add(checkpoint.name);
  }
  for (const member of Object.values(data.members)) {
    for (const evidence of member.evidence) {
      if (evidence.kind.trim()) names.add(evidence.kind);
    }
  }
  return names;
}

function validateOpenCodeRuntimeMembers(
  members: TeamRuntimeLaunchInput['expectedMembers'],
  launchCwd?: string
): string[] {
  if (members.length === 0) {
    return ['OpenCode runtime adapter requires at least one expected OpenCode member.'];
  }

  const diagnostics = members.flatMap((member, index) => {
    const name = member.name.trim() || `<index ${index}>`;
    if (member.providerId === 'opencode') {
      return [];
    }
    return [
      `OpenCode runtime adapter received non-OpenCode member "${name}" with provider "${member.providerId}".`,
    ];
  });
  const memberCwds = [
    ...new Set(members.map((member) => member.cwd.trim()).filter((cwd) => cwd.length > 0)),
  ];
  if (memberCwds.length > 1) {
    diagnostics.push(
      'OpenCode runtime adapter currently supports one project path per lane. Launch isolated OpenCode teammates as separate side lanes.'
    );
  }
  const onlyMemberCwd = memberCwds.length === 1 ? memberCwds[0] : null;
  if (launchCwd?.trim() && onlyMemberCwd && onlyMemberCwd !== launchCwd.trim()) {
    diagnostics.push(
      `OpenCode runtime lane cwd mismatch: launch cwd "${launchCwd.trim()}" differs from member cwd "${onlyMemberCwd}".`
    );
  }
  return diagnostics;
}

function formatOpenCodeBridgeDiagnostic(diagnostic: {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}): string {
  return `${diagnostic.severity}:${diagnostic.code}: ${diagnostic.message}`;
}

function isOpenCodePreLaunchCapabilitySnapshotMismatchData(
  data: OpenCodeLaunchTeamCommandData
): boolean {
  if (data.teamLaunchState !== 'failed') {
    return false;
  }
  if (
    data.diagnostics.some(
      (diagnostic) =>
        isOpenCodePreLaunchCapabilitySnapshotMismatchText(diagnostic.message) ||
        isOpenCodePreLaunchCapabilitySnapshotMismatchText(diagnostic.code)
    )
  ) {
    return true;
  }
  return Object.values(data.members).some((member) =>
    (member.diagnostics ?? []).some(isOpenCodePreLaunchCapabilitySnapshotMismatchText)
  );
}

function isOpenCodePreLaunchCapabilitySnapshotMismatchText(value: string): boolean {
  const normalized = value.toLowerCase();
  return OPEN_CODE_CAPABILITY_SNAPSHOT_PRELAUNCH_MISMATCH_MARKERS.some((marker) =>
    normalized.includes(marker.toLowerCase())
  );
}

function mergeDiagnostics(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right].filter((value) => value.trim().length > 0))];
}
