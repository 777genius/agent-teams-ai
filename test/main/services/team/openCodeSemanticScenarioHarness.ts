import { promises as fs } from 'fs';
import * as path from 'path';

import { OpenCodeTeamRuntimeAdapter } from '../../../../src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter';
import { TeamTaskWriter } from '../../../../src/main/services/team/TeamTaskWriter';
import type {
  OpenCodeLaunchTeamCommandBody,
  OpenCodeLaunchTeamCommandData,
  OpenCodeSendMessageCommandBody,
  OpenCodeSendMessageCommandData,
} from '../../../../src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import type { OpenCodeTeamLaunchReadiness } from '../../../../src/main/services/team/opencode/readiness/OpenCodeTeamLaunchReadiness';
import { REQUIRED_AGENT_TEAMS_APP_TOOL_IDS } from '../../../../src/main/services/team/opencode/mcp/OpenCodeMcpToolAvailability';
import type {
  OpenCodeTeamRuntimeBridgePort,
  OpenCodeTeamRuntimeMessageInput,
} from '../../../../src/main/services/team/runtime';
import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberLaunchEvidence,
  TeamRuntimePrepareResult,
  TeamRuntimeReconcileInput,
  TeamRuntimeReconcileResult,
  TeamRuntimeStopInput,
  TeamRuntimeStopResult,
} from '../../../../src/main/services/team/runtime/TeamRuntimeAdapter';
import type { AgentActionMode, TaskRef, TeamCreateRequest, TeamTask } from '../../../../src/shared/types';

const FIXTURE_PATH = path.join(
  process.cwd(),
  'test',
  'fixtures',
  'team',
  'opencode',
  'semantic-realistic-scenario.json'
);

export interface OpenCodeSemanticScenario {
  teamNamePrefix: string;
  displayName: string;
  description: string;
  teamPromptLines: string[];
  members: Array<{
    name: string;
    role: string;
    workflowLines: string[];
  }>;
  projectFiles: Array<{
    path: string;
    contentLines: string[];
  }>;
  tasks: Array<{
    taskId: string;
    displayId: string;
    subject: string;
    owner: string;
    comment: string;
  }>;
  directDelivery: {
    memberName: string;
    replyRecipient: string;
    actionMode: AgentActionMode;
    taskIndex: number;
    expectedReplyToken: string;
    textLines: string[];
  };
  peerDelivery: {
    senderName: string;
    recipientName: string;
    replyRecipient: string;
    actionMode: AgentActionMode;
    taskIndex: number;
    peerToken: string;
    expectedReplyToken: string;
    textLines: string[];
  };
}

export interface CapturedOpenCodeBridge {
  readonly launchCommands: OpenCodeLaunchTeamCommandBody[];
  readonly messageCommands: OpenCodeSendMessageCommandBody[];
  readonly bridge: OpenCodeTeamRuntimeBridgePort;
}

export class CapturingOpenCodeRuntimeAdapter implements TeamLaunchRuntimeAdapter {
  readonly providerId = 'opencode' as const;
  readonly launchInputs: TeamRuntimeLaunchInput[] = [];

  async prepare(input: TeamRuntimeLaunchInput): Promise<TeamRuntimePrepareResult> {
    return {
      ok: true,
      providerId: 'opencode',
      modelId: input.model ?? null,
      diagnostics: [],
      warnings: [],
    };
  }

  async launch(input: TeamRuntimeLaunchInput): Promise<TeamRuntimeLaunchResult> {
    this.launchInputs.push(input);
    return {
      runId: input.runId,
      teamName: input.teamName,
      launchPhase: 'finished',
      teamLaunchState: 'clean_success',
      members: Object.fromEntries(
        input.expectedMembers.map((member, index) => [
          member.name,
          buildConfirmedMemberEvidence(member.name, member.model ?? input.model ?? null, index),
        ])
      ),
      warnings: [],
      diagnostics: ['captured OpenCode launch input'],
    };
  }

  async reconcile(input: TeamRuntimeReconcileInput): Promise<TeamRuntimeReconcileResult> {
    return {
      runId: input.runId,
      teamName: input.teamName,
      launchPhase: 'reconciled',
      teamLaunchState: 'clean_success',
      members: Object.fromEntries(
        input.expectedMembers.map((member, index) => [
          member.name,
          buildConfirmedMemberEvidence(member.name, member.model ?? null, index),
        ])
      ),
      snapshot: input.previousLaunchState,
      warnings: [],
      diagnostics: ['captured OpenCode reconcile input'],
    };
  }

  async stop(input: TeamRuntimeStopInput): Promise<TeamRuntimeStopResult> {
    return {
      runId: input.runId,
      teamName: input.teamName,
      stopped: true,
      members: {},
      warnings: [],
      diagnostics: ['captured OpenCode stop input'],
    };
  }
}

export async function loadOpenCodeSemanticScenario(): Promise<OpenCodeSemanticScenario> {
  const parsed = JSON.parse(await fs.readFile(FIXTURE_PATH, 'utf8')) as OpenCodeSemanticScenario;
  if (!Array.isArray(parsed.members) || parsed.members.length < 2) {
    throw new Error('OpenCode semantic scenario requires at least two members.');
  }
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length < 2) {
    throw new Error('OpenCode semantic scenario requires at least two tasks.');
  }
  return parsed;
}

export async function materializeOpenCodeScenarioProject(
  scenario: OpenCodeSemanticScenario,
  projectPath: string
): Promise<void> {
  for (const file of scenario.projectFiles) {
    const targetPath = path.join(projectPath, file.path);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, `${file.contentLines.join('\n')}\n`, 'utf8');
  }
}

export async function materializeOpenCodeScenarioTasks(input: {
  scenario: OpenCodeSemanticScenario;
  teamName: string;
  projectPath: string;
}): Promise<void> {
  const writer = new TeamTaskWriter();
  const createdAt = '2026-04-21T00:00:00.000Z';
  for (const task of input.scenario.tasks) {
    const record: TeamTask = {
      id: task.taskId,
      displayId: task.displayId,
      subject: task.subject,
      description: task.comment,
      owner: task.owner,
      createdBy: 'lead',
      status: 'in_progress',
      projectPath: input.projectPath,
      createdAt,
      updatedAt: createdAt,
      comments: [
        {
          id: `${task.taskId}-comment`,
          author: 'lead',
          text: task.comment,
          createdAt,
          type: 'regular',
        },
      ],
    };
    await writer.createTask(input.teamName, record);
  }
}

export function buildOpenCodeScenarioTeamRequest(input: {
  scenario: OpenCodeSemanticScenario;
  teamName: string;
  projectPath: string;
  model: string;
  memberNames?: string[];
}): TeamCreateRequest {
  const memberNames = new Set(input.memberNames ?? input.scenario.members.map((member) => member.name));
  return {
    teamName: input.teamName,
    displayName: input.scenario.displayName,
    description: input.scenario.description,
    cwd: input.projectPath,
    providerId: 'opencode',
    model: input.model,
    skipPermissions: true,
    prompt: input.scenario.teamPromptLines.join('\n'),
    members: input.scenario.members
      .filter((member) => memberNames.has(member.name))
      .map((member) => ({
        name: member.name,
        role: member.role,
        workflow: member.workflowLines.join('\n'),
        providerId: 'opencode' as const,
        model: input.model,
      })),
  };
}

export function buildScenarioRuntimeMessageInput(input: {
  scenario: OpenCodeSemanticScenario;
  teamName: string;
  projectPath: string;
  runId?: string;
  laneId?: string;
  kind: 'direct' | 'peer';
}): OpenCodeTeamRuntimeMessageInput {
  if (input.kind === 'direct') {
    const delivery = input.scenario.directDelivery;
    return {
      runId: input.runId,
      teamName: input.teamName,
      laneId: input.laneId ?? 'primary',
      memberName: delivery.memberName,
      cwd: input.projectPath,
      text: delivery.textLines.join('\n'),
      messageId: `semantic-direct-${delivery.expectedReplyToken}`,
      replyRecipient: delivery.replyRecipient,
      actionMode: delivery.actionMode,
      taskRefs: [taskRefForScenario(input.scenario, delivery.taskIndex, input.teamName)],
    };
  }

  const delivery = input.scenario.peerDelivery;
  return {
    runId: input.runId,
    teamName: input.teamName,
    laneId: input.laneId ?? 'primary',
    memberName: delivery.senderName,
    cwd: input.projectPath,
    text: delivery.textLines.join('\n'),
    messageId: `semantic-peer-${delivery.peerToken}`,
    replyRecipient: delivery.replyRecipient,
    actionMode: delivery.actionMode,
    taskRefs: [taskRefForScenario(input.scenario, delivery.taskIndex, input.teamName)],
  };
}

export function taskRefForScenario(
  scenario: OpenCodeSemanticScenario,
  taskIndex: number,
  teamName: string
): TaskRef {
  const task = scenario.tasks[taskIndex];
  if (!task) {
    throw new Error(`OpenCode semantic scenario task index ${taskIndex} is missing.`);
  }
  return {
    taskId: task.taskId,
    displayId: task.displayId,
    teamName,
  };
}

export function createCapturingOpenCodeBridge(modelId: string): CapturedOpenCodeBridge {
  const launchCommands: OpenCodeLaunchTeamCommandBody[] = [];
  const messageCommands: OpenCodeSendMessageCommandBody[] = [];
  return {
    launchCommands,
    messageCommands,
    bridge: {
      checkOpenCodeTeamLaunchReadiness: async () => readyOpenCodeReadiness(modelId),
      getLastOpenCodeRuntimeSnapshot: () => ({
        providerId: 'opencode',
        binaryPath: '/opt/homebrew/bin/opencode',
        binaryFingerprint: 'version:1.14.19',
        version: '1.14.19',
        capabilitySnapshotId: 'capability-semantic-contract',
      }),
      launchOpenCodeTeam: async (command) => {
        launchCommands.push(command);
        return buildReadyLaunchData(command, modelId);
      },
      sendOpenCodeTeamMessage: async (command) => {
        messageCommands.push(command);
        return buildAcceptedMessageData(command);
      },
    },
  };
}

export async function dumpOpenCodePromptArtifacts(input: {
  outputDir: string;
  launchInput: TeamRuntimeLaunchInput;
  launchCommand: OpenCodeLaunchTeamCommandBody;
  messageCommands: OpenCodeSendMessageCommandBody[];
}): Promise<void> {
  await fs.mkdir(input.outputDir, { recursive: true });
  const summary = {
    teamName: input.launchInput.teamName,
    launchPromptChars: input.launchInput.prompt?.length ?? 0,
    leadPromptChars: input.launchCommand.leadPrompt?.length ?? 0,
    memberPromptChars: input.launchCommand.members.map((member) => ({
      name: member.name,
      chars: member.prompt?.length ?? 0,
    })),
    messagePromptChars: input.messageCommands.map((command) => ({
      memberName: command.memberName,
      chars: command.text.length,
      actionMode: command.actionMode ?? null,
      taskRefs: command.taskRefs ?? [],
    })),
  };
  await fs.writeFile(path.join(input.outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await fs.writeFile(
    path.join(input.outputDir, 'launch-command.json'),
    `${JSON.stringify(input.launchCommand, null, 2)}\n`
  );
  await fs.writeFile(
    path.join(input.outputDir, 'message-commands.json'),
    `${JSON.stringify(input.messageCommands, null, 2)}\n`
  );
}

export function createOpenCodeRuntimeAdapterFromCapture(
  capture: CapturedOpenCodeBridge
): OpenCodeTeamRuntimeAdapter {
  return new OpenCodeTeamRuntimeAdapter(capture.bridge);
}

export function parseOpenCodeE2EModelList(): string[] {
  const raw = process.env.OPENCODE_E2E_MODELS?.trim();
  if (!raw) {
    const single = process.env.OPENCODE_E2E_MODEL?.trim();
    return single ? [single] : ['opencode/big-pickle'];
  }
  return raw
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
}

function readyOpenCodeReadiness(modelId: string): OpenCodeTeamLaunchReadiness {
  return {
    state: 'ready',
    launchAllowed: true,
    modelId,
    availableModels: [modelId],
    opencodeVersion: '1.14.19',
    installMethod: 'brew',
    binaryPath: '/opt/homebrew/bin/opencode',
    hostHealthy: true,
    appMcpConnected: true,
    requiredToolsPresent: true,
    permissionBridgeReady: true,
    runtimeStoresReady: true,
    supportLevel: 'production_supported',
    missing: [],
    diagnostics: [],
    evidence: {
      capabilitiesReady: true,
      mcpToolProofRoute: '/experimental/tool/ids',
      observedMcpTools: [...REQUIRED_AGENT_TEAMS_APP_TOOL_IDS],
      runtimeStoreReadinessReason: 'runtime_store_manifest_valid',
    },
  };
}

function buildReadyLaunchData(
  command: OpenCodeLaunchTeamCommandBody,
  modelId: string
): OpenCodeLaunchTeamCommandData {
  return {
    runId: command.runId,
    teamLaunchState: 'ready',
    durableCheckpoints: [
      { name: 'required_tools_proven', observedAt: '2026-04-21T00:00:00.000Z' },
      { name: 'delivery_ready', observedAt: '2026-04-21T00:00:00.000Z' },
      { name: 'run_ready', observedAt: '2026-04-21T00:00:00.000Z' },
    ],
    members: Object.fromEntries(
      command.members.map((member, index) => [
        member.name,
        {
          sessionId: `semantic-session-${member.name}`,
          launchState: 'confirmed_alive' as const,
          runtimePid: 31_000 + index,
          model: modelId,
          evidence: [
            { kind: 'required_tools_proven', observedAt: '2026-04-21T00:00:00.000Z' },
            { kind: 'delivery_ready', observedAt: '2026-04-21T00:00:00.000Z' },
            { kind: 'member_ready', observedAt: '2026-04-21T00:00:00.000Z' },
            { kind: 'run_ready', observedAt: '2026-04-21T00:00:00.000Z' },
          ],
          diagnostics: [],
        },
      ])
    ),
    warnings: [],
    diagnostics: [],
  };
}

function buildAcceptedMessageData(
  command: OpenCodeSendMessageCommandBody
): OpenCodeSendMessageCommandData {
  return {
    accepted: true,
    sessionId: `semantic-session-${command.memberName}`,
    memberName: command.memberName,
    runtimePid: 41_000,
    prePromptCursor: 'semantic-pre-prompt-cursor',
    responseObservation: {
      state: 'responded_tool_call',
      deliveredUserMessageId: command.messageId ?? null,
      assistantMessageId: 'semantic-assistant-message',
      toolCallNames: ['agent-teams_message_send'],
      visibleMessageToolCallId: 'semantic-tool-call',
      visibleReplyMessageId: command.messageId ?? null,
      visibleReplyCorrelation: command.messageId ? 'relayOfMessageId' : null,
      latestAssistantPreview: 'semantic accepted message',
      reason: null,
    },
    diagnostics: [],
  };
}

function buildConfirmedMemberEvidence(
  memberName: string,
  model: string | null,
  index: number
): TeamRuntimeMemberLaunchEvidence {
  return {
    memberName,
    providerId: 'opencode',
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    sessionId: `semantic-session-${memberName}`,
    runtimePid: 21_000 + index,
    diagnostics: [`captured OpenCode launch ready${model ? ` for ${model}` : ''}`],
  };
}
