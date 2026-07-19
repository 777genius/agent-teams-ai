import { randomUUID } from 'crypto';

import { isOpenCodeTerminalProbeTechnicalDiagnostic } from '../opencode/readiness/OpenCodeFailureDiagnostics';
import { normalizeOpenCodeProjectIdentity } from '../opencode/readiness/OpenCodeProjectIdentity';

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
import type { OpenCodeExecutionProof } from '../opencode/readiness/OpenCodeExecutionProof';
import type { OpenCodeTeamLaunchReadiness } from '../opencode/readiness/OpenCodeTeamLaunchReadiness';
import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
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
  }): Promise<OpenCodeTeamLaunchReadiness>;
  getLastOpenCodeRuntimeSnapshot?(
    projectPath: string,
    selectedModel?: string | null,
    requireExecutionProbe?: boolean
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
const GENERIC_OPEN_CODE_MEMBER_FAILURE_REASON = 'OpenCode bridge reported member launch failure';
const SECRET_FLAG_PATTERN =
  /(--(?:api-key|token|password|secret|authorization|auth-token)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+\S+/gi;
const SECRET_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}\b/g;
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

function openCodeReadinessArtifactKey(input: OpenCodeTeamLaunchReadinessInput): string {
  return JSON.stringify([
    normalizeOpenCodeProjectIdentity(input.projectPath),
    input.selectedModel?.trim() ?? null,
    input.requireExecutionProbe,
  ]);
}

function reusableOpenCodeExecutionProof(
  readiness: OpenCodeTeamLaunchReadiness | undefined,
  input: OpenCodeTeamLaunchReadinessInput
): OpenCodeExecutionProof | null {
  const proof = readiness?.executionProof;
  if (
    !proof ||
    !proof.reusable ||
    (proof.credentialMode !== 'api' && proof.credentialMode !== 'none')
  ) {
    return null;
  }
  const normalizedExpected = normalizeOpenCodeProjectIdentity(input.projectPath);
  const normalizedProofProject = normalizeOpenCodeProjectIdentity(proof.projectPath);
  if (
    proof.modelId !== readiness?.modelId ||
    normalizedProofProject !== normalizedExpected ||
    Date.parse(proof.expiresAt) <= Date.now() + 1_000
  ) {
    return null;
  }
  return proof;
}

function getOpenCodeReadinessDiagnosticText(readiness: OpenCodeTeamLaunchReadiness): string {
  return [...readiness.diagnostics, ...readiness.missing].join('\n');
}

function isTransientOpenCodeReadinessTransportFailure(
  readiness: OpenCodeTeamLaunchReadiness
): boolean {
  if (readiness.launchAllowed) {
    return false;
  }
  if (readiness.state !== 'mcp_unavailable' && readiness.state !== 'unknown_error') {
    return false;
  }

  const diagnosticText = getOpenCodeReadinessDiagnosticText(readiness).toLowerCase();
  if (!diagnosticText) {
    return false;
  }

  const hasHardFailureMarker =
    /\b(?:401|403)\b/.test(diagnosticText) ||
    diagnosticText.includes('unauthorized') ||
    diagnosticText.includes('forbidden') ||
    diagnosticText.includes('missing canonical app mcp tool id') ||
    diagnosticText.includes('observed alias') ||
    diagnosticText.includes('app mcp tool missing') ||
    diagnosticText.includes('tool is absent') ||
    diagnosticText.includes('missing required field') ||
    diagnosticText.includes('runtime store') ||
    diagnosticText.includes('capability snapshot') ||
    diagnosticText.includes('contract') ||
    diagnosticText.includes('schema') ||
    diagnosticText.includes('invalid input') ||
    /\b(?:404|405)\b/.test(diagnosticText) ||
    diagnosticText.includes('not found');
  if (hasHardFailureMarker) {
    return false;
  }

  return (
    diagnosticText.includes('unable to connect') ||
    diagnosticText.includes('socket connection was closed') ||
    diagnosticText.includes('fetch failed') ||
    diagnosticText.includes('econnreset') ||
    diagnosticText.includes('econnrefused') ||
    diagnosticText.includes('socket hang up') ||
    diagnosticText.includes('networkerror') ||
    diagnosticText.includes('/experimental/tool/ids unavailable')
  );
}

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

  constructor(private readonly bridge: OpenCodeTeamRuntimeBridgePort) {}

  async prepare(input: TeamRuntimeLaunchInput): Promise<TeamRuntimePrepareResult> {
    const runtimeOnly = input.runtimeOnly === true;
    const readiness = await this.resolveOpenCodeReadinessArtifact({
      projectPath: input.cwd,
      selectedModel: input.model ?? null,
      requireExecutionProbe: !runtimeOnly,
    });
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
    input: OpenCodeTeamLaunchReadinessInput
  ): Promise<OpenCodeTeamLaunchReadiness> {
    const artifactKey = openCodeReadinessArtifactKey(input);
    const cached = this.lastReadinessByArtifactKey.get(artifactKey);
    if (cached?.launchAllowed && reusableOpenCodeExecutionProof(cached, input)) {
      return cached;
    }

    const inFlight = this.readinessInFlightByArtifactKey.get(artifactKey);
    if (inFlight) {
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
    let selectedModel = input.model?.trim() ?? '';
    let launchWarnings: string[] = [];
    if (!skipReadinessPreflight) {
      // A state-changing launch must never inherit a caller's compatibility-only
      // preflight. Authless subscription bridges such as Cursor ACP are present
      // in the catalog without an OpenCode credential and therefore require a
      // real execution proof before launch, including controlled retries.
      const prepared = await this.prepare({ ...input, runtimeOnly: false });
      if (!prepared.ok) {
        return blockedLaunchResult(input, prepared.reason, prepared.diagnostics, prepared.warnings);
      }
      selectedModel = prepared.modelId ?? selectedModel;
      launchWarnings = prepared.warnings;
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

    const readinessInput: OpenCodeTeamLaunchReadinessInput = {
      projectPath: input.cwd,
      selectedModel: input.model ?? null,
      requireExecutionProbe: true,
    };
    let runtimeSnapshot = skipReadinessPreflight
      ? null
      : (this.bridge.getLastOpenCodeRuntimeSnapshot?.(
          input.cwd,
          readinessInput.selectedModel,
          readinessInput.requireExecutionProbe
        ) ?? null);
    let executionProof = reusableOpenCodeExecutionProof(
      this.lastReadinessByArtifactKey.get(openCodeReadinessArtifactKey(readinessInput)) ??
        this.lastReadinessByProjectPath.get(normalizeOpenCodeProjectIdentity(input.cwd)),
      readinessInput
    );
    if (executionProof?.capabilitySnapshotId !== runtimeSnapshot?.capabilitySnapshotId) {
      executionProof = null;
    }
    if (
      !skipReadinessPreflight &&
      this.bridge.getLastOpenCodeRuntimeSnapshot &&
      !runtimeSnapshot?.capabilitySnapshotId
    ) {
      return blockedLaunchResult(input, 'opencode_capability_snapshot_missing', [
        'OpenCode app-managed launch requires a fresh capability snapshot before state-changing launch.',
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
      skipPermissions: input.skipPermissions,
      members: input.expectedMembers.map((member) => ({
        name: member.name,
        role: member.role?.trim() || member.workflow?.trim() || 'teammate',
        prompt: buildMemberBootstrapPrompt(input, member),
      })),
      leadPrompt: input.prompt?.trim() ?? '',
      expectedCapabilitySnapshotId: snapshot?.capabilitySnapshotId ?? null,
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
      const refreshed = await this.prepare(input);
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
      selectedModel = refreshed.modelId ?? selectedModel;
      const refreshedSnapshot =
        this.bridge.getLastOpenCodeRuntimeSnapshot?.(
          input.cwd,
          readinessInput.selectedModel,
          readinessInput.requireExecutionProbe
        ) ?? null;
      if (refreshedSnapshot?.capabilitySnapshotId) {
        runtimeSnapshot = refreshedSnapshot;
        executionProof = reusableOpenCodeExecutionProof(
          this.lastReadinessByArtifactKey.get(openCodeReadinessArtifactKey(readinessInput)) ??
            this.lastReadinessByProjectPath.get(normalizeOpenCodeProjectIdentity(input.cwd)),
          readinessInput
        );
        if (executionProof?.capabilitySnapshotId !== runtimeSnapshot.capabilitySnapshotId) {
          executionProof = null;
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

    return mapOpenCodeLaunchDataToRuntimeResult(input, data, launchWarnings);
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
      const runtimeSnapshot = projectPath
        ? (this.bridge.getLastOpenCodeRuntimeSnapshot?.(projectPath) ?? null)
        : null;
      const data = await this.bridge.reconcileOpenCodeTeam({
        runId: input.runId,
        laneId: input.laneId?.trim() || 'primary',
        teamId: input.teamName,
        teamName: input.teamName,
        projectPath,
        expectedCapabilitySnapshotId: runtimeSnapshot?.capabilitySnapshotId ?? null,
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
      const runtimeSnapshot = projectPath
        ? (this.bridge.getLastOpenCodeRuntimeSnapshot?.(projectPath) ?? null)
        : null;
      const data = await this.bridge.stopOpenCodeTeam({
        runId: input.runId,
        laneId: input.laneId?.trim() || 'primary',
        teamId: input.teamName,
        teamName: input.teamName,
        projectPath,
        expectedCapabilitySnapshotId: runtimeSnapshot?.capabilitySnapshotId ?? null,
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

function firstDisplayableOpenCodeFailureMessage(
  values: readonly string[],
  options: { includeGeneric: boolean }
): string | undefined {
  for (const value of values) {
    const normalized = normalizeOpenCodeFailureMessage(value);
    if (!normalized) {
      continue;
    }
    if (!options.includeGeneric && isGenericOpenCodeFailureMessage(normalized)) {
      continue;
    }
    return normalized;
  }
  return undefined;
}

function normalizeOpenCodeFailureMessage(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(SECRET_FLAG_PATTERN, '$1[redacted]')
    .replace(BEARER_TOKEN_PATTERN, 'Bearer [redacted]')
    .replace(SECRET_KEY_PATTERN, '[redacted-api-key]');
}

function isGenericOpenCodeFailureMessage(message: string): boolean {
  return (
    message === GENERIC_OPEN_CODE_MEMBER_FAILURE_REASON ||
    message.startsWith(`${GENERIC_OPEN_CODE_MEMBER_FAILURE_REASON}:`) ||
    message.startsWith('OpenCode secondary lane timing:') ||
    message.startsWith(
      'OpenCode bridge reported ready without all required durable checkpoints:'
    ) ||
    message.startsWith(
      'OpenCode bridge reported ready before all expected members were confirmed:'
    ) ||
    message.startsWith(
      'OpenCode bootstrap MCP did not complete required tools before assistant response:'
    ) ||
    message.startsWith('OpenCode command timed out after') ||
    message.startsWith('CLI-authenticated providers missing from live host') ||
    message.startsWith('OpenCode session status') ||
    isOpenCodeTerminalProbeTechnicalDiagnostic(message) ||
    (message.startsWith('opencode_app_mcp_tool_proof_') && message.includes('cache_hit')) ||
    isOpenCodeLaunchTimingDiagnostic(message)
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

function buildMemberBootstrapPrompt(
  input: TeamRuntimeLaunchInput,
  member: TeamRuntimeLaunchInput['expectedMembers'][number]
): string {
  const teamPrompt = input.prompt?.trim();
  const role = member.role?.trim() || member.workflow?.trim() || 'teammate';
  const workflow = member.workflow?.trim();
  const isTeamLead =
    member.name.trim().toLowerCase() === 'team-lead' || role.trim().toLowerCase() === 'team lead';
  const identityLine = isTeamLead
    ? `You are ${member.name}, the team lead for team "${input.teamName}".`
    : `You are ${member.name}, a ${role} on team "${input.teamName}".`;
  const messageTargets = isTeamLead
    ? 'the human user or a teammate'
    : 'the human user, team lead, or another teammate';
  const senderRole = isTeamLead ? 'team lead' : 'OpenCode teammate';
  return [
    '<agent_teams_app_managed_bootstrap_briefing>',
    'AGENT_TEAMS_APP_MANAGED_BOOTSTRAP_V1',
    identityLine,
    teamPrompt ? `Team launch context:\n${teamPrompt}` : null,
    workflow ? `Workflow:\n${workflow}` : null,
    '',
    'This OpenCode session is created, attached, and launch-verified by the desktop app.',
    'Do not call runtime_bootstrap_checkin or member_briefing just to prove launch readiness.',
    'Do NOT create local team files, run join scripts, or search the project for a fake team registry.',
    'That bootstrap restriction is only about team registry/startup files. It does not restrict assigned project work: when a task requires implementation, fixes, review follow-up, or investigation, you may inspect, read/search, and edit files in the project working directory as your available tools allow.',
    'Use the app MCP tools exposed by the "agent-teams" server for team communication and task state.',
    'Launch bootstrap is a silent attach, not a user/team conversation turn.',
    'Do not call task_briefing, message_send, or cross_team_send just to announce readiness, say understood, report no tasks, or ask for work.',
    'If the briefing says there are no actionable tasks, stay idle silently.',
    '',
    `When you need to message ${messageTargets}, call MCP tool agent-teams_message_send (or mcp__agent-teams__message_send) with teamName, to, from, text, and optional summary.`,
    `Always set from="${member.name}" when sending a team message from this ${senderRole}.`,
    'Do not answer team/app messages only as plain assistant text when agent-teams_message_send is available.',
    '</agent_teams_app_managed_bootstrap_briefing>',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function buildOpenCodeRuntimeMessageText(input: OpenCodeTeamRuntimeMessageInput): string {
  if (input.bootstrapCheckinRetry) {
    const runtimeSessionId = input.bootstrapCheckinRetry.runtimeSessionId.trim();
    return [
      '<opencode_runtime_bootstrap_checkin_retry>',
      'The desktop app detected that this OpenCode session exists, but runtime_bootstrap_checkin has not committed durable runtime evidence yet.',
      input.bootstrapCheckinRetry.reason
        ? `Reason: ${input.bootstrapCheckinRetry.reason.trim()}`
        : null,
      'Before any other tool or message, call MCP tool agent-teams_runtime_bootstrap_checkin or mcp__agent-teams__runtime_bootstrap_checkin with exactly:',
      JSON.stringify({
        runId: input.runId,
        teamName: input.teamName,
        memberName: input.memberName,
        runtimeSessionId,
      }),
      'Do not call member_briefing, task tools, message_send, or cross_team_send before runtime_bootstrap_checkin completes.',
      'After runtime_bootstrap_checkin succeeds, stop this turn immediately and wait silently.',
      'If runtime_bootstrap_checkin is unavailable or fails, reply with one short sentence containing the exact error text, then stop.',
      '</opencode_runtime_bootstrap_checkin_retry>',
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
  }

  const replyRecipient = input.replyRecipient?.trim() || 'user';
  const deliveryContext =
    input.messageId && (input.taskRefs?.length || input.messageKind)
      ? JSON.stringify({
          schemaVersion: 1,
          kind: 'opencode-delivery-context',
          teamName: input.teamName,
          laneId: input.laneId,
          memberName: input.memberName,
          inboundMessageId: input.messageId,
          ...(input.messageKind ? { messageKind: input.messageKind } : {}),
          ...(input.workSyncIntent ? { workSyncIntent: input.workSyncIntent } : {}),
          ...(input.workSyncReviewRequestEventIds?.length
            ? { workSyncReviewRequestEventIds: input.workSyncReviewRequestEventIds }
            : {}),
          taskRefs: input.taskRefs,
        })
      : null;
  const isWorkSyncNudge = input.messageKind === 'member_work_sync_nudge';
  const isReviewPickupNudge = isWorkSyncNudge && input.workSyncIntent === 'review_pickup';
  const workSyncToolArgs = buildOpenCodeWorkSyncToolArgs(input);
  const taskIds =
    input.taskRefs
      ?.map((ref) => ref.taskId?.trim())
      .filter((taskId): taskId is string => Boolean(taskId)) ?? [];
  const actionModeWorkScopeReminder =
    input.actionMode === 'ask'
      ? 'Action mode ASK is read-only for this delivered message: do not edit files, change task state, or run side-effecting tools for this message.'
      : input.actionMode === 'delegate'
        ? 'Action mode DELEGATE is orchestration-only for this delivered message: pass the task with context instead of implementing or editing files yourself.'
        : 'If this delivered message assigns implementation, fixes, review follow-up, or concrete investigation, you may inspect, read/search, and edit files in the project working directory as your available tools allow.';
  // Work-sync nudges are health/reporting probes. Requiring a visible
  // message_send reply here causes false delivery failures, so accept the
  // dedicated member_work_sync_report proof path while keeping normal user
  // messages on the visible reply contract.
  const responseInstructions = isReviewPickupNudge
    ? [
        'This delivered app message is a targeted member-work-sync review pickup nudge.',
        'Process the current review request now if it is still assigned to you. Open the task, verify reviewState/status, then use the review workflow tools to start or continue the review.',
        'Do not mark the review complete from this prompt alone.',
        'A visible agent-teams_message_send reply is optional. Review workflow tool usage or agent-teams_member_work_sync_report (or mcp__agent-teams__member_work_sync_report) is sufficient response proof.',
        `If you cannot pick up the review now, call agent-teams_member_work_sync_status (or mcp__agent-teams__member_work_sync_status) with ${workSyncToolArgs}, then report state "blocked" or "still_working" only for the real current state.`,
        'Do not stop after member_work_sync_status. A status-only tool call is incomplete; member_work_sync_report is the required proof.',
        taskIds.length ? `Relevant taskIds: ${taskIds.map((id) => `"${id}"`).join(', ')}.` : null,
        `Do not use provider names, runtime names, or team names as memberName; use exactly "${input.memberName}".`,
        'Do not reply only with acknowledgement.',
      ]
    : isWorkSyncNudge
      ? [
          'This delivered app message is a member-work-sync nudge.',
          'A visible agent-teams_message_send reply is optional. For agenda sync, only agent-teams_member_work_sync_report (or mcp__agent-teams__member_work_sync_report) is sufficient response proof.',
          `Call agent-teams_member_work_sync_status (or mcp__agent-teams__member_work_sync_status) with ${workSyncToolArgs}.`,
          `Then call agent-teams_member_work_sync_report (or mcp__agent-teams__member_work_sync_report) with ${workSyncToolArgs}, the returned agendaFingerprint/reportToken, and state "still_working" or "blocked".`,
          'Do not stop after member_work_sync_status. A status-only tool call is incomplete; member_work_sync_report is the required proof.',
          taskIds.length
            ? `When reporting, include taskIds: ${taskIds.map((id) => `"${id}"`).join(', ')}.`
            : null,
          `Do not use provider names, runtime names, or team names as memberName; use exactly "${input.memberName}".`,
          'Do not reply only with acknowledgement.',
        ]
      : [
          'To make your reply visible in the app Messages UI, call MCP tool agent-teams_message_send (or mcp__agent-teams__message_send if that is the exposed name).',
          `Use teamName="${input.teamName}", to="${replyRecipient}", from="${input.memberName}", text, and summary.`,
          'Include source="runtime_delivery" in that message_send call.',
          input.messageId
            ? `Include relayOfMessageId="${input.messageId}" in that message_send call.`
            : null,
          input.taskRefs?.length
            ? `If taskRefs are present in <opencode_delivery_context>, include taskRefs exactly as provided in that message_send call: ${JSON.stringify(input.taskRefs)}.`
            : null,
          'If message_send returns an unavailable, not connected, or missing-tool error, write the exact concise reply as plain assistant text once, then stop.',
          'After the message_send tool call succeeds, stop immediately. Do not send follow-up confirmations or repeat the same answer.',
          'You must not end this turn empty.',
          'Do not answer only with plain assistant text when agent-teams_message_send is available.',
        ];

  return [
    '<opencode_app_message_delivery>',
    deliveryContext
      ? `<opencode_delivery_context>${deliveryContext}</opencode_delivery_context>`
      : null,
    'You are running in OpenCode, not Claude Code or Codex native.',
    actionModeWorkScopeReminder,
    ...responseInstructions,
    'Do not call runtime_bootstrap_checkin or member_briefing just to answer this delivered app message.',
    'Do not use SendMessage or runtime_deliver_message for ordinary visible replies.',
    'Do not invent placeholder task labels. If no explicit taskRefs are provided and the reply is not about a real board task, do not prefix text or summary with a # task label; never use #00000000.',
    'The inbound app message follows. Treat it as the actual instruction to process now, not as background context.',
    'If the inbound message asks for exact reply text, use that exact text. Do not replace concrete instructions with a generic greeting or availability message.',
    input.actionMode ? `Action mode for this message: ${input.actionMode}.` : null,
    '</opencode_app_message_delivery>',
    '',
    '<opencode_inbound_app_message>',
    input.text,
    '</opencode_inbound_app_message>',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function buildOpenCodeWorkSyncToolArgs(input: OpenCodeTeamRuntimeMessageInput): string {
  const args = [`teamName="${input.teamName}"`, `memberName="${input.memberName}"`];
  const controlUrl = input.controlUrl?.trim();
  if (controlUrl) {
    args.push(`controlUrl=${JSON.stringify(controlUrl)}`);
  }
  return args.join(', ');
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

function isOpenCodeLaunchTimingDiagnostic(diagnostic: string): boolean {
  return (
    diagnostic.startsWith('info:opencode_launch_member_timing:') ||
    diagnostic.startsWith('info:opencode_launch_total_timing:')
  );
}

function blockedLaunchResult(
  input: TeamRuntimeLaunchInput,
  reason: string,
  diagnostics: string[],
  warnings: string[] = []
): TeamRuntimeLaunchResult {
  const readinessFailure =
    reason === 'unknown_error' ||
    reason === 'model_unavailable' ||
    reason === 'not_authenticated' ||
    reason === 'mcp_unavailable' ||
    reason === 'not_installed';
  const hardFailureReason = readinessFailure
    ? (firstDisplayableOpenCodeFailureMessage(diagnostics, { includeGeneric: false }) ?? reason)
    : reason;
  const members = Object.fromEntries(
    input.expectedMembers.map((member) => [
      member.name,
      {
        memberName: member.name,
        providerId: 'opencode' as const,
        launchState: 'failed_to_start' as const,
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason,
        diagnostics,
      },
    ])
  );

  return {
    runId: input.runId,
    teamName: input.teamName,
    launchPhase: 'finished',
    teamLaunchState: 'partial_failure',
    members,
    warnings,
    diagnostics,
  };
}

function isRetryableReadinessState(state: OpenCodeTeamLaunchReadiness['state']): boolean {
  return (
    state === 'not_installed' ||
    state === 'not_authenticated' ||
    state === 'runtime_store_blocked' ||
    state === 'mcp_unavailable' ||
    state === 'model_unavailable' ||
    state === 'unknown_error'
  );
}

function mergeDiagnostics(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right].filter((value) => value.trim().length > 0))];
}
