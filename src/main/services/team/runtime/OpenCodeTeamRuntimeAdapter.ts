import { randomUUID } from 'crypto';

import type { OpenCodeTeamLaunchReadiness } from '../opencode/readiness/OpenCodeTeamLaunchReadiness';
import type {
  OpenCodeLaunchTeamCommandBody,
  OpenCodeLaunchTeamCommandData,
  OpenCodeBridgeRuntimeSnapshot,
  OpenCodeReconcileTeamCommandBody,
  OpenCodeSendMessageCommandBody,
  OpenCodeSendMessageCommandData,
  OpenCodeStopTeamCommandBody,
  OpenCodeStopTeamCommandData,
  OpenCodeTeamLaunchMode,
  OpenCodeTeamMemberLaunchBridgeState,
} from '../opencode/bridge/OpenCodeBridgeCommandContract';
import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberLaunchEvidence,
  TeamRuntimeMemberStopEvidence,
  TeamRuntimePrepareResult,
  TeamRuntimeReconcileInput,
  TeamRuntimeReconcileResult,
  TeamRuntimeStopInput,
  TeamRuntimeStopResult,
} from './TeamRuntimeAdapter';

export interface OpenCodeTeamRuntimeBridgePort {
  checkOpenCodeTeamLaunchReadiness(input: {
    projectPath: string;
    selectedModel: string | null;
    requireExecutionProbe: boolean;
    launchMode?: OpenCodeTeamLaunchMode;
  }): Promise<OpenCodeTeamLaunchReadiness>;
  getLastOpenCodeRuntimeSnapshot?(projectPath: string): OpenCodeBridgeRuntimeSnapshot | null;
  launchOpenCodeTeam?(input: OpenCodeLaunchTeamCommandBody): Promise<OpenCodeLaunchTeamCommandData>;
  reconcileOpenCodeTeam?(
    input: OpenCodeReconcileTeamCommandBody
  ): Promise<OpenCodeLaunchTeamCommandData>;
  stopOpenCodeTeam?(input: OpenCodeStopTeamCommandBody): Promise<OpenCodeStopTeamCommandData>;
  sendOpenCodeTeamMessage?(
    input: OpenCodeSendMessageCommandBody
  ): Promise<OpenCodeSendMessageCommandData>;
}

export interface OpenCodeTeamRuntimeAdapterOptions {
  launchMode?: OpenCodeTeamLaunchMode;
  /**
   * @deprecated Use launchMode. Kept for older tests/callers until the production gate is fully wired.
   */
  launchEnabled?: boolean;
}

export interface OpenCodeTeamRuntimeMessageInput {
  runId?: string;
  teamName: string;
  laneId: string;
  memberName: string;
  cwd: string;
  text: string;
  messageId?: string;
}

export interface OpenCodeTeamRuntimeMessageResult {
  ok: boolean;
  providerId: 'opencode';
  memberName: string;
  sessionId?: string;
  runtimePid?: number;
  diagnostics: string[];
}

export { type OpenCodeTeamLaunchMode } from '../opencode/bridge/OpenCodeBridgeCommandContract';

const REQUIRED_READY_CHECKPOINTS = new Set([
  'required_tools_proven',
  'delivery_ready',
  'member_ready',
  'run_ready',
]);

export class OpenCodeTeamRuntimeAdapter implements TeamLaunchRuntimeAdapter {
  readonly providerId = 'opencode' as const;
  private readonly lastProjectPathByTeamName = new Map<string, string>();
  private readonly lastReadinessByProjectPath = new Map<string, OpenCodeTeamLaunchReadiness>();

  constructor(
    private readonly bridge: OpenCodeTeamRuntimeBridgePort,
    private readonly options: OpenCodeTeamRuntimeAdapterOptions = {}
  ) {}

  async prepare(input: TeamRuntimeLaunchInput): Promise<TeamRuntimePrepareResult> {
    const configuredLaunchMode = resolveOpenCodeTeamLaunchMode(this.options);
    if (configuredLaunchMode === 'disabled') {
      return {
        ok: false,
        providerId: this.providerId,
        reason: 'opencode_team_launch_disabled',
        retryable: false,
        diagnostics: [
          'OpenCode team launch mode is disabled. Set CLAUDE_TEAM_OPENCODE_LAUNCH_MODE=dogfood for local dogfood testing or production after strict readiness evidence exists.',
        ],
        warnings: [],
      };
    }

    const runtimeOnly = input.runtimeOnly === true;
    const readiness = await this.bridge.checkOpenCodeTeamLaunchReadiness({
      projectPath: input.cwd,
      selectedModel: input.model ?? null,
      requireExecutionProbe: !runtimeOnly,
      launchMode: runtimeOnly ? undefined : configuredLaunchMode,
    });
    this.lastReadinessByProjectPath.set(input.cwd, readiness);

    if (!readiness.launchAllowed) {
      return {
        ok: false,
        providerId: this.providerId,
        reason: readiness.state,
        retryable: isRetryableReadinessState(readiness.state),
        diagnostics: mergeDiagnostics(readiness.diagnostics, readiness.missing),
        warnings: [],
      };
    }

    const warnings =
      configuredLaunchMode === 'dogfood' && !runtimeOnly
        ? [
            'OpenCode dogfood launch mode is active. This is local test mode and may run without production E2E evidence.',
          ]
        : [];

    if (
      !runtimeOnly &&
      configuredLaunchMode === 'production' &&
      readiness.supportLevel !== 'production_supported'
    ) {
      return {
        ok: false,
        providerId: this.providerId,
        reason: 'opencode_production_e2e_evidence_missing',
        retryable: false,
        diagnostics: [
          'OpenCode production launch requires strict production E2E evidence before enabling team launch.',
        ],
        warnings,
      };
    }

    return {
      ok: true,
      providerId: this.providerId,
      modelId: readiness.modelId,
      diagnostics: readiness.diagnostics,
      warnings,
    };
  }

  getLastOpenCodeTeamLaunchReadiness(projectPath: string): OpenCodeTeamLaunchReadiness | null {
    return this.lastReadinessByProjectPath.get(projectPath) ?? null;
  }

  async launch(input: TeamRuntimeLaunchInput): Promise<TeamRuntimeLaunchResult> {
    const memberValidationDiagnostics = validateOpenCodeRuntimeMembers(input.expectedMembers);
    if (memberValidationDiagnostics.length > 0) {
      return blockedLaunchResult(
        input,
        'opencode_invalid_expected_members',
        memberValidationDiagnostics
      );
    }

    const configuredLaunchMode = resolveOpenCodeTeamLaunchMode(this.options);
    const prepared = await this.prepare(input);
    if (!prepared.ok) {
      return blockedLaunchResult(input, prepared.reason, prepared.diagnostics, prepared.warnings);
    }

    if (!this.bridge.launchOpenCodeTeam) {
      return blockedLaunchResult(input, 'opencode_launch_bridge_missing', [
        'OpenCode readiness passed, but the state-changing launch bridge is not registered.',
      ]);
    }

    const selectedModel = prepared.modelId ?? input.model?.trim() ?? '';
    if (!selectedModel) {
      return blockedLaunchResult(input, 'opencode_model_unavailable', [
        'OpenCode launch requires a selected raw model id.',
      ]);
    }

    const runtimeSnapshot = this.bridge.getLastOpenCodeRuntimeSnapshot?.(input.cwd) ?? null;
    this.lastProjectPathByTeamName.set(input.teamName, input.cwd);
    const data = await this.bridge.launchOpenCodeTeam({
      mode: configuredLaunchMode,
      runId: input.runId,
      laneId: input.laneId?.trim() || 'primary',
      teamId: input.teamName,
      teamName: input.teamName,
      projectPath: input.cwd,
      selectedModel,
      members: input.expectedMembers.map((member) => ({
        name: member.name,
        role: member.role?.trim() || member.workflow?.trim() || 'teammate',
        prompt: buildMemberBootstrapPrompt(input, member),
      })),
      leadPrompt: input.prompt?.trim() ?? '',
      expectedCapabilitySnapshotId: runtimeSnapshot?.capabilitySnapshotId ?? null,
      manifestHighWatermark: null,
    });

    return mapOpenCodeLaunchDataToRuntimeResult(input, data, prepared.warnings);
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
            runtimeAlive: member.runtimeAlive,
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
      agent: 'teammate',
    });

    return {
      ok: data.accepted,
      providerId: this.providerId,
      memberName: input.memberName,
      sessionId: data.sessionId,
      runtimePid: data.runtimePid,
      diagnostics: data.diagnostics.map((diagnostic) => diagnostic.message),
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

export function resolveOpenCodeTeamLaunchMode(
  options: OpenCodeTeamRuntimeAdapterOptions = {}
): OpenCodeTeamLaunchMode {
  if (options.launchMode) {
    return options.launchMode;
  }
  if (options.launchEnabled === true) {
    return 'production';
  }
  return 'disabled';
}

function mapOpenCodeLaunchDataToRuntimeResult(
  input: TeamRuntimeLaunchInput,
  data: OpenCodeLaunchTeamCommandData,
  prepareWarnings: string[]
): TeamRuntimeLaunchResult {
  const checkpointNames = extractCheckpointNames(data);
  const readyCheckpointsPresent = [...REQUIRED_READY_CHECKPOINTS].every((name) =>
    checkpointNames.has(name)
  );
  const bridgeReady = data.teamLaunchState === 'ready';
  const missingExpectedMembers = input.expectedMembers
    .map((member) => member.name)
    .filter((memberName) => data.members[memberName] == null);
  const unconfirmedExpectedMembers = input.expectedMembers
    .map((member) => member.name)
    .filter((memberName) => data.members[memberName]?.launchState !== 'confirmed_alive');
  const anyExpectedMemberFailed = input.expectedMembers.some(
    (member) => data.members[member.name]?.launchState === 'failed'
  );
  const allExpectedMembersConfirmed =
    input.expectedMembers.length > 0 && unconfirmedExpectedMembers.length === 0;
  const success = bridgeReady && readyCheckpointsPresent && allExpectedMembersConfirmed;
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
      return [
        member.name,
        mapBridgeMemberToRuntimeEvidence(
          member.name,
          fallbackLaunchState,
          bridgeMember?.sessionId,
          bridgeMember?.runtimePid,
          bridgeMember?.pendingPermissionRequestIds,
          bridgeMember != null,
          [
            ...(bridgeMember
              ? []
              : [
                  `OpenCode bridge response did not include ${member.name}; keeping the member pending until lane state materializes.`,
                ]),
            ...(bridgeMember?.diagnostics ?? []),
            ...(bridgeMember?.evidence ?? []).map(
              (evidence) => `${evidence.kind} at ${evidence.observedAt}`
            ),
            ...checkpointDiagnostic,
            ...(missingExpectedMembers.includes(member.name) ? incompleteReadyDiagnostic : []),
          ]
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
    diagnostics: [
      ...data.diagnostics.map(formatOpenCodeBridgeDiagnostic),
      ...checkpointDiagnostic,
      ...incompleteReadyDiagnostic,
    ],
  };
}

function mapBridgeMemberToRuntimeEvidence(
  memberName: string,
  launchState: OpenCodeTeamMemberLaunchBridgeState,
  sessionId: string | undefined,
  runtimePid: number | undefined,
  pendingPermissionRequestIds: string[] | undefined,
  runtimeMaterialized: boolean,
  diagnostics: string[]
): TeamRuntimeMemberLaunchEvidence {
  const confirmed = launchState === 'confirmed_alive';
  const createdOrBlocked = launchState === 'created' || launchState === 'permission_blocked';
  const failed = launchState === 'failed';
  const pendingRuntimeObserved = createdOrBlocked && runtimeMaterialized;
  return {
    memberName,
    providerId: 'opencode',
    launchState: failed
      ? 'failed_to_start'
      : confirmed
        ? 'confirmed_alive'
        : launchState === 'permission_blocked'
          ? 'runtime_pending_permission'
          : 'runtime_pending_bootstrap',
    agentToolAccepted: confirmed || pendingRuntimeObserved,
    runtimeAlive: confirmed || pendingRuntimeObserved,
    bootstrapConfirmed: confirmed,
    hardFailure: failed,
    hardFailureReason: failed ? 'OpenCode bridge reported member launch failure' : undefined,
    pendingPermissionRequestIds:
      pendingPermissionRequestIds && pendingPermissionRequestIds.length > 0
        ? [...new Set(pendingPermissionRequestIds)]
        : undefined,
    sessionId,
    ...(typeof runtimePid === 'number' && Number.isFinite(runtimePid) && runtimePid > 0
      ? { runtimePid }
      : {}),
    diagnostics,
  };
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
  return [
    `You are ${member.name}, a ${role} on team "${input.teamName}".`,
    teamPrompt ? `Team launch context:\n${teamPrompt}` : null,
    workflow ? `Workflow:\n${workflow}` : null,
    '',
    'This OpenCode session is already attached by the desktop app. Do NOT create local team files, run join scripts, or search the project for a fake team registry.',
    'Use the app MCP tools exposed by the "agent-teams" server for team communication and task state.',
    'If available, your first app-team action is to call MCP tool agent-teams_member_briefing (or mcp__agent-teams__member_briefing if that is the exposed name) with:',
    `{ "teamName": "${input.teamName}", "memberName": "${member.name}" }`,
    'If that tool is not available, stay idle and wait for app-delivered instructions. Do not improvise a replacement workflow.',
    '',
    'When you need to message the human user, team lead, or another teammate, call MCP tool agent-teams_message_send (or mcp__agent-teams__message_send) with teamName, to, from, text, and optional summary.',
    `Always set from="${member.name}" when sending a team message from this OpenCode teammate.`,
    'Do not answer team/app messages only as plain assistant text when agent-teams_message_send is available.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function buildOpenCodeRuntimeMessageText(input: OpenCodeTeamRuntimeMessageInput): string {
  const replyRecipient = extractRequestedReplyRecipient(input.text);
  const replyLine = replyRecipient
    ? `For this message, if you reply, call agent-teams_message_send with to="${replyRecipient}" and from="${input.memberName}".`
    : `If you reply, call agent-teams_message_send with the requested recipient and from="${input.memberName}".`;

  return [
    '<opencode_app_message_delivery>',
    'You are running in OpenCode, not Claude Code or Codex native.',
    'If the incoming message below mentions SendMessage, treat that as a UI abstraction for other runtimes. Do not import, require, create, or run a SendMessage script.',
    'To make your reply visible in the app Messages UI, call MCP tool agent-teams_message_send (or mcp__agent-teams__message_send if that is the exposed name).',
    `Use teamName="${input.teamName}". ${replyLine}`,
    'Pass your human-readable reply as text and a short summary as summary. Do not answer only with plain assistant text when the tool is available.',
    input.messageId
      ? `The inbound app messageId is "${input.messageId}"; keep it only as context unless a tool explicitly asks for provenance.`
      : null,
    '</opencode_app_message_delivery>',
    '',
    input.text,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function extractRequestedReplyRecipient(text: string): string | null {
  const replyRecipientMatch = /reply back to recipient "([^"]+)"/i.exec(text);
  if (replyRecipientMatch?.[1]?.trim()) {
    return replyRecipientMatch[1].trim();
  }
  const destinationMatch = /destination must be exactly to="([^"]+)"/i.exec(text);
  if (destinationMatch?.[1]?.trim()) {
    return destinationMatch[1].trim();
  }
  return null;
}

function validateOpenCodeRuntimeMembers(
  members: TeamRuntimeLaunchInput['expectedMembers']
): string[] {
  if (members.length === 0) {
    return ['OpenCode runtime adapter requires at least one expected OpenCode member.'];
  }

  return members.flatMap((member, index) => {
    const name = member.name.trim() || `<index ${index}>`;
    if (member.providerId === 'opencode') {
      return [];
    }
    return [
      `OpenCode runtime adapter received non-OpenCode member "${name}" with provider "${member.providerId}".`,
    ];
  });
}

function formatOpenCodeBridgeDiagnostic(diagnostic: {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}): string {
  return `${diagnostic.severity}:${diagnostic.code}: ${diagnostic.message}`;
}

function blockedLaunchResult(
  input: TeamRuntimeLaunchInput,
  reason: string,
  diagnostics: string[],
  warnings: string[] = []
): TeamRuntimeLaunchResult {
  const hardFailureReason =
    reason === 'unknown_error' && diagnostics[0]?.trim() ? diagnostics[0].trim() : reason;
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
    state === 'e2e_missing' ||
    state === 'runtime_store_blocked' ||
    state === 'mcp_unavailable' ||
    state === 'model_unavailable' ||
    state === 'unknown_error'
  );
}

function mergeDiagnostics(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right].filter((value) => value.trim().length > 0))];
}
