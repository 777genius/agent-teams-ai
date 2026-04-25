import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';
import {
  buildOpenCodeScenarioTeamRequest,
  loadOpenCodeSemanticScenario,
  materializeOpenCodeScenarioProject,
  materializeOpenCodeScenarioTasks,
  parseOpenCodeE2EModelList,
  taskRefForScenario,
  type OpenCodeSemanticScenario,
} from './openCodeSemanticScenarioHarness';
import {
  createOpenCodeLiveHarness,
  getRuntimeTranscript,
  waitForOpenCodeMemberIdle,
  type InboxMessage,
  waitForMemberInboxMessage,
  waitForOpenCodeLanesStopped,
  waitForOpenCodePeerRelay,
  waitForUserInboxReply,
} from './openCodeLiveTestHarness';

import type { TaskRef, TeamProvisioningProgress } from '../../../../src/shared/types';

const liveDescribe =
  process.env.OPENCODE_E2E === '1' && process.env.OPENCODE_E2E_SEMANTIC_MODEL_MATRIX === '1'
    ? describe
    : describe.skip;

interface ModelMatrixReport {
  generatedAt: string;
  models: ModelResult[];
}

interface ModelResult {
  model: string;
  passed: boolean;
  score: number;
  durationMs: number;
  stages: {
    launchBootstrap: boolean;
    directReply: boolean;
    peerRelay: boolean;
    taskRefs: boolean;
    longPrompt: boolean;
    latencyStable: boolean;
  };
  diagnostics: string[];
}

liveDescribe('OpenCode semantic model matrix live e2e', () => {
  it(
    'launches realistic OpenCode teams and scores model behavior sequentially',
    async () => {
      const scenario = await loadOpenCodeSemanticScenario();
      const models = parseOpenCodeE2EModelList();
      const results: ModelResult[] = [];

      for (const model of models) {
        results.push(await runModelScenario({ scenario, model }));
      }

      await writeModelMatrixReport({
        generatedAt: new Date().toISOString(),
        models: results,
      });

      const failures = results.filter((result) => !result.passed);
      expect(failures, JSON.stringify(results, null, 2)).toEqual([]);
    },
    Math.max(420_000, parseOpenCodeE2EModelList().length * 420_000)
  );
});

async function runModelScenario(input: {
  scenario: OpenCodeSemanticScenario;
  model: string;
}): Promise<ModelResult> {
  const startedAt = Date.now();
  const stages: ModelResult['stages'] = {
    launchBootstrap: false,
    directReply: false,
    peerRelay: false,
    taskRefs: false,
    longPrompt: false,
    latencyStable: false,
  };
  const diagnostics: string[] = [];
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-semantic-model-matrix-'));
  const tempClaudeRoot = path.join(tempDir, '.claude');
  const projectPath = path.join(tempDir, 'project');
  const teamName = `${input.scenario.teamNamePrefix}-${sanitizeModelForTeamName(input.model)}-${Date.now()}`;
  let harness: Awaited<ReturnType<typeof createOpenCodeLiveHarness>> | null = null;
  let keepTempDir = false;

  try {
    await fs.mkdir(tempClaudeRoot, { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });
    setClaudeBasePathOverride(tempClaudeRoot);
    await materializeOpenCodeScenarioProject(input.scenario, projectPath);
    harness = await createOpenCodeLiveHarness({
      tempDir,
      selectedModel: input.model,
    });

    const progressEvents: TeamProvisioningProgress[] = [];
    const createStartedAt = Date.now();
    const { runId } = await harness.svc.createTeam(
      buildOpenCodeScenarioTeamRequest({
        scenario: input.scenario,
        teamName,
        projectPath,
        model: harness.selectedModel,
      }),
      (progress) => progressEvents.push(progress)
    );
    diagnostics.push(`runId=${runId}`);
    await materializeOpenCodeScenarioTasks({ scenario: input.scenario, teamName, projectPath });

    const progressDump = formatProgressDump(progressEvents);
    if (!progressEvents.some((progress) => progress.message.includes('OpenCode team launch is ready'))) {
      throw new Error(`OpenCode launch did not reach ready state.\n${progressDump}`);
    }
    const runtimeSnapshot = await harness.svc.getTeamAgentRuntimeSnapshot(teamName);
    for (const member of input.scenario.members) {
      const snapshot = runtimeSnapshot.members[member.name];
      if (!snapshot?.alive) {
        throw new Error(
          `OpenCode member ${member.name} is not alive. Snapshot: ${JSON.stringify(
            runtimeSnapshot,
            null,
            2
          )}`
        );
      }
      if (snapshot.runtimeModel !== harness.selectedModel) {
        diagnostics.push(
          `${member.name} runtime model ${snapshot.runtimeModel ?? 'unknown'} differs from ${harness.selectedModel}`
        );
      }
    }
    stages.launchBootstrap = true;
    stages.longPrompt = input.scenario.teamPromptLines.join('\n').length > 1_500;
    stages.latencyStable = Date.now() - createStartedAt < 240_000;

    const directTaskRef = taskRefForScenario(
      input.scenario,
      input.scenario.directDelivery.taskIndex,
      teamName
    );
    const directDelivery = await harness.svc.deliverOpenCodeMemberMessage(teamName, {
      memberName: input.scenario.directDelivery.memberName,
      messageId: `ui-direct-${Date.now()}`,
      replyRecipient: input.scenario.directDelivery.replyRecipient,
      actionMode: input.scenario.directDelivery.actionMode,
      taskRefs: [directTaskRef],
      source: 'manual',
      text: input.scenario.directDelivery.textLines.join('\n'),
    });
    diagnostics.push(`directDelivery=${formatDeliveryDiagnostic(directDelivery)}`);
    if (!directDelivery.delivered) {
      throw new Error(`Direct OpenCode delivery failed: ${JSON.stringify(directDelivery, null, 2)}`);
    }
    const directReply = await waitForReplyWithTranscript({
      bridgeClient: harness.bridgeClient,
      teamName,
      memberName: input.scenario.directDelivery.memberName,
      projectPath,
      expectedToken: input.scenario.directDelivery.expectedReplyToken,
      timeoutMs: 180_000,
    });
    assertVisibleReplyContract(directReply, {
      expectedFrom: input.scenario.directDelivery.memberName,
      expectedTo: 'user',
      expectedTaskRef: directTaskRef,
    });
    stages.directReply = true;
    stages.taskRefs = hasTaskRef(directReply, directTaskRef);
    await waitForOpenCodeMemberIdle({
      bridgeClient: harness.bridgeClient,
      teamName,
      memberName: input.scenario.directDelivery.memberName,
      projectPath,
      timeoutMs: 90_000,
    });

    const peerTaskRef = taskRefForScenario(
      input.scenario,
      input.scenario.peerDelivery.taskIndex,
      teamName
    );
    const peerDelivery = await harness.svc.deliverOpenCodeMemberMessage(teamName, {
      memberName: input.scenario.peerDelivery.senderName,
      messageId: `ui-peer-${Date.now()}`,
      replyRecipient: input.scenario.peerDelivery.replyRecipient,
      actionMode: input.scenario.peerDelivery.actionMode,
      taskRefs: [peerTaskRef],
      source: 'manual',
      text: input.scenario.peerDelivery.textLines.join('\n'),
    });
    diagnostics.push(`peerDelivery=${formatDeliveryDiagnostic(peerDelivery)}`);
    if (!peerDelivery.delivered) {
      throw new Error(`Peer OpenCode delivery failed: ${JSON.stringify(peerDelivery, null, 2)}`);
    }
    if (peerDelivery.accepted === false || peerDelivery.queuedBehindMessageId) {
      throw new Error(
        `Peer OpenCode delivery was not accepted immediately: ${JSON.stringify(
          peerDelivery,
          null,
          2
        )}`
      );
    }

    let peerMessage: Awaited<ReturnType<typeof waitForMemberInboxMessage>>;
    try {
      peerMessage = await waitForMemberInboxMessage(
        teamName,
        input.scenario.peerDelivery.recipientName,
        input.scenario.peerDelivery.senderName,
        input.scenario.peerDelivery.peerToken,
        180_000
      );
    } catch (error) {
      const transcript = await getRuntimeTranscript({
        bridgeClient: harness.bridgeClient,
        teamName,
        memberName: input.scenario.peerDelivery.senderName,
        projectPath,
      });
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nSender transcript: ${JSON.stringify(
          transcript,
          null,
          2
        )}`
      );
    }
    assertVisibleReplyContract(peerMessage, {
      expectedFrom: input.scenario.peerDelivery.senderName,
      expectedTo: input.scenario.peerDelivery.recipientName,
      expectedTaskRef: peerTaskRef,
    });
    await waitForOpenCodePeerRelay(
      harness.svc,
      teamName,
      input.scenario.peerDelivery.recipientName,
      peerMessage.messageId,
      180_000
    );
    const peerReply = await waitForReplyWithTranscript({
      bridgeClient: harness.bridgeClient,
      teamName,
      memberName: input.scenario.peerDelivery.recipientName,
      projectPath,
      expectedToken: input.scenario.peerDelivery.expectedReplyToken,
      timeoutMs: 180_000,
    });
    assertVisibleReplyContract(peerReply, {
      expectedFrom: input.scenario.peerDelivery.recipientName,
      expectedTo: 'user',
    });
    stages.peerRelay = true;

    const score = scoreModel(stages);
    return {
      model: input.model,
      passed: score === 100,
      score,
      durationMs: Date.now() - startedAt,
      stages,
      diagnostics,
    };
  } catch (error) {
    if (process.env.OPENCODE_E2E_KEEP_FAILED === '1') {
      keepTempDir = true;
      diagnostics.push(`tempDir=${tempDir}`);
    }
    diagnostics.push(error instanceof Error ? error.message : String(error));
    return {
      model: input.model,
      passed: false,
      score: scoreModel(stages),
      durationMs: Date.now() - startedAt,
      stages,
      diagnostics,
    };
  } finally {
    if (harness) {
      await harness.svc.stopTeam(teamName).catch(() => undefined);
      await harness.dispose().catch(() => undefined);
      await waitForOpenCodeLanesStopped(teamName).catch(() => undefined);
    }
    setClaudeBasePathOverride(null);
    if (!keepTempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function waitForReplyWithTranscript(input: {
  bridgeClient: Parameters<typeof getRuntimeTranscript>[0]['bridgeClient'];
  teamName: string;
  memberName: string;
  projectPath: string;
  expectedToken: string;
  timeoutMs: number;
}): Promise<InboxMessage> {
  try {
    return await waitForUserInboxReply(
      input.teamName,
      input.memberName,
      input.expectedToken,
      input.timeoutMs
    );
  } catch (error) {
    const transcript = await getRuntimeTranscript({
      bridgeClient: input.bridgeClient,
      teamName: input.teamName,
      memberName: input.memberName,
      projectPath: input.projectPath,
    });
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nTranscript: ${JSON.stringify(
        transcript,
        null,
        2
      )}`
    );
  }
}

function assertVisibleReplyContract(
  message: InboxMessage,
  input: {
    expectedFrom: string;
    expectedTo: string;
    expectedTaskRef?: TaskRef;
  }
): void {
  expect(message).toMatchObject({
    from: input.expectedFrom,
    to: input.expectedTo,
  });
  const text = message.text ?? '';
  expect(text).not.toContain('SendMessage');
  expect(text).not.toContain('runtime_deliver_message');
  expect(text).not.toContain('#00000000');
  expect(text.trim()).not.toBe('\u041f\u043e\u043d\u044f\u043b');
  if (input.expectedTaskRef) {
    expect(hasTaskRef(message, input.expectedTaskRef)).toBe(true);
  }
}

function hasTaskRef(message: InboxMessage, expected: TaskRef): boolean {
  return Boolean(
    message.taskRefs?.some(
      (taskRef) =>
        taskRef.teamName === expected.teamName &&
        taskRef.taskId === expected.taskId &&
        taskRef.displayId === expected.displayId
    )
  );
}

function scoreModel(stages: ModelResult['stages']): number {
  return (
    (stages.launchBootstrap ? 25 : 0) +
    (stages.directReply ? 25 : 0) +
    (stages.peerRelay ? 20 : 0) +
    (stages.taskRefs ? 15 : 0) +
    (stages.longPrompt ? 10 : 0) +
    (stages.latencyStable ? 5 : 0)
  );
}

function formatDeliveryDiagnostic(delivery: {
  delivered?: unknown;
  accepted?: unknown;
  responsePending?: unknown;
  responseState?: unknown;
  ledgerStatus?: unknown;
  queuedBehindMessageId?: unknown;
  reason?: unknown;
  visibleReplyMessageId?: unknown;
  visibleReplyCorrelation?: unknown;
  diagnostics?: unknown;
}): string {
  return JSON.stringify({
    delivered: delivery.delivered,
    accepted: delivery.accepted,
    responsePending: delivery.responsePending,
    responseState: delivery.responseState,
    ledgerStatus: delivery.ledgerStatus,
    queuedBehindMessageId: delivery.queuedBehindMessageId,
    reason: delivery.reason,
    visibleReplyMessageId: delivery.visibleReplyMessageId,
    visibleReplyCorrelation: delivery.visibleReplyCorrelation,
    diagnostics: Array.isArray(delivery.diagnostics)
      ? delivery.diagnostics.slice(0, 5)
      : delivery.diagnostics,
  });
}

async function writeModelMatrixReport(report: ModelMatrixReport): Promise<void> {
  const outputDir = process.env.OPENCODE_E2E_REPORT_DIR?.trim()
    ? path.resolve(process.env.OPENCODE_E2E_REPORT_DIR.trim())
    : path.join(process.cwd(), 'test-results', 'opencode-semantic-model-matrix');
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, `report-${Date.now()}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8'
  );
}

function formatProgressDump(progressEvents: TeamProvisioningProgress[]): string {
  return progressEvents
    .map((progress) =>
      [
        progress.state,
        progress.message,
        progress.messageSeverity,
        progress.error,
        progress.cliLogsTail,
      ]
        .filter(Boolean)
        .join(' | ')
    )
    .join('\n');
}

function sanitizeModelForTeamName(model: string): string {
  return model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}
