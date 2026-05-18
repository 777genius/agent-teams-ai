import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createOpenCodePromptDeliveryLedgerStore } from '../../../../src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import {
  getOpenCodeLaneScopedRuntimeFilePath,
} from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { OpenCodeTaskLogStreamSource } from '../../../../src/main/services/team/taskLogs/stream/OpenCodeTaskLogStreamSource';
import { TeamDataService } from '../../../../src/main/services/team/TeamDataService';
import { TeamTaskReader } from '../../../../src/main/services/team/TeamTaskReader';
import {
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';
import {
  createOpenCodeLiveHarness,
  waitForOpenCodeLanesStopped,
  waitForOpenCodeMemberIdle,
  type OpenCodeLiveHarness,
} from './openCodeLiveTestHarness';

import type { ClaudeMultimodelBridgeService } from '../../../../src/main/services/runtime/ClaudeMultimodelBridgeService';
import type { ParsedMessage } from '../../../../src/main/types';
import type { BoardTaskLogStreamResponse, TeamProvisioningProgress } from '../../../../src/shared/types';

const liveDescribe =
  process.env.OPENCODE_E2E === '1' && process.env.OPENCODE_DELIVERY_ACCEPT_FAST_LIVE === '1'
    ? describe
    : describe.skip;

const DEFAULT_ORCHESTRATOR_CLI = '/Users/belief/dev/projects/claude/agent_teams_orchestrator/cli';
const DEFAULT_MODEL = 'opencode/big-pickle';

liveDescribe('OpenCode accept-fast delivery live e2e', () => {
  let tempDir: string;
  let tempClaudeRoot: string;
  let harness: OpenCodeLiveHarness | null;
  let teamName: string | null;
  let previousOrchestratorCliPath: string | undefined;
  let previousMcpClaudeDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-accept-fast-e2e-'));
    tempClaudeRoot = path.join(tempDir, '.claude');
    await fs.mkdir(tempClaudeRoot, { recursive: true });
    setClaudeBasePathOverride(tempClaudeRoot);
    previousOrchestratorCliPath = process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH;
    process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH =
      previousOrchestratorCliPath?.trim() || DEFAULT_ORCHESTRATOR_CLI;
    previousMcpClaudeDir = process.env.AGENT_TEAMS_MCP_CLAUDE_DIR;
    process.env.AGENT_TEAMS_MCP_CLAUDE_DIR = tempClaudeRoot;
    harness = null;
    teamName = null;
  });

  afterEach(async () => {
    if (harness && teamName) {
      await harness.svc.stopTeam(teamName).catch(() => undefined);
      await waitForOpenCodeLanesStopped(teamName).catch(() => undefined);
    }
    await harness?.dispose().catch(() => undefined);
    setClaudeBasePathOverride(null);
    if (previousOrchestratorCliPath === undefined) {
      delete process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH;
    } else {
      process.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH = previousOrchestratorCliPath;
    }
    if (previousMcpClaudeDir === undefined) {
      delete process.env.AGENT_TEAMS_MCP_CLAUDE_DIR;
    } else {
      process.env.AGENT_TEAMS_MCP_CLAUDE_DIR = previousMcpClaudeDir;
    }
    if (process.env.OPENCODE_E2E_KEEP_TEMP === '1') {
      console.info(`[OpenCodeAcceptFastDelivery.live] preserved temp dir: ${tempDir}`);
    } else {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it(
    'returns after prompt acceptance and later projects exact-session task logs',
    async () => {
      const selectedModel = process.env.OPENCODE_E2E_MODEL?.trim() || DEFAULT_MODEL;
      const projectPath = path.join(tempDir, 'project');
      await fs.mkdir(projectPath, { recursive: true });
      await fs.writeFile(
        path.join(projectPath, 'README.md'),
        '# OpenCode accept-fast live e2e\n\nSmall project for exact-session delivery checks.\n',
        'utf8'
      );

      harness = await createOpenCodeLiveHarness({
        tempDir,
        selectedModel,
        projectPath,
      });

      const memberName = 'bob';
      const marker = `accept-fast-live-${Date.now()}`;
      teamName = `opencode-accept-fast-${Date.now()}`;
      const progressEvents: TeamProvisioningProgress[] = [];

      await harness.svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: selectedModel,
          skipPermissions: true,
          prompt: [
            'Keep launch work minimal.',
            'When instructed to work on a task, use the Agent Teams task tools exactly as requested.',
            'Do not send app messages unless explicitly asked.',
          ].join(' '),
          members: [
            {
              name: memberName,
              role: 'Developer',
              providerId: 'opencode',
              model: selectedModel,
            },
          ],
        },
        (progress) => {
          progressEvents.push(progress);
        }
      );

      expect(
        progressEvents.some((progress) =>
          progress.message.includes('OpenCode team launch is ready')
        ),
        formatProgressDump(progressEvents)
      ).toBe(true);

      const task = await new TeamDataService().createTask(teamName, {
        subject: `OpenCode accept-fast delivery proof ${marker}`,
        owner: memberName,
        startImmediately: false,
        prompt: `Live accept-fast marker: ${marker}`,
      });
      const taskRef = {
        teamName,
        taskId: task.id,
        displayId: task.displayId ?? task.id.slice(0, 8),
      };
      const messageId = `accept-fast-live-message-${Date.now()}`;
      const sleepSeconds = Number(process.env.OPENCODE_ACCEPT_FAST_LIVE_SLEEP_SECONDS ?? 20);

      const startedAtMs = Date.now();
      const delivery = await harness.svc.deliverOpenCodeMemberMessage(teamName, {
        memberName,
        messageId,
        source: 'ui-send',
        replyRecipient: 'user',
        actionMode: 'do',
        taskRefs: [taskRef],
        text: [
          `Work on task #${task.displayId}.`,
          `First call agent-teams_task_start for taskId "${task.id}".`,
          `Then run exactly one bash command: sleep ${sleepSeconds}; pwd`,
          `After that command finishes, call agent-teams_task_add_comment for taskId "${task.id}" with text exactly "${marker}:task-comment-after-sleep".`,
          'Do not call agent-teams_message_send for this validation.',
          'Stop after the task comment.',
        ].join('\n'),
      });
      const acceptedAtMs = Date.now();

      expect(delivery.delivered, JSON.stringify(delivery, null, 2)).toBe(true);
      expect(delivery.accepted, JSON.stringify(delivery, null, 2)).toBe(true);
      expect(delivery.responsePending, JSON.stringify(delivery, null, 2)).toBe(true);
      expect(delivery.ledgerRecordId).toBeTruthy();
      expect(delivery.laneId).toBeTruthy();

      const immediateTask = await readTask(teamName, task.id);
      expect(
        Boolean(
          immediateTask?.comments?.some((comment) =>
            comment.text.includes(`${marker}:task-comment-after-sleep`)
          )
        ),
        'accept-fast should return before the delayed task comment is produced'
      ).toBe(false);

      const ledgerRecord = await waitForLedgerRecord({
        teamName,
        laneId: delivery.laneId!,
        messageId,
      });
      expect(ledgerRecord.acceptedAt).toBeTruthy();
      expect(ledgerRecord.runtimeSessionId).toBeTruthy();
      expect(ledgerRecord.runtimePromptMessageId).toBeTruthy();
      expect(ledgerRecord.runtimePromptMessageIds ?? []).toContain(
        ledgerRecord.runtimePromptMessageId
      );
      expect(ledgerRecord.taskRefs).toEqual([taskRef]);
      expect(Date.parse(ledgerRecord.acceptedAt!)).toBeGreaterThanOrEqual(startedAtMs - 1_000);
      expect(Date.parse(ledgerRecord.acceptedAt!)).toBeLessThanOrEqual(acceptedAtMs + 1_000);

      await waitUntil(async () => {
        const currentTask = await readTask(teamName!, task.id);
        return Boolean(
          currentTask?.comments?.some((comment) =>
            comment.text.includes(`${marker}:task-comment-after-sleep`)
          )
        );
      }, 180_000, 2_000, async () => {
        const currentTask = await readTask(teamName!, task.id);
        return `Task comments: ${JSON.stringify(currentTask?.comments ?? [], null, 2)}\nDelivery: ${JSON.stringify(
          delivery,
          null,
          2
        )}`;
      });

      await waitForOpenCodeMemberIdle({
        bridgeClient: harness.bridgeClient,
        teamName,
        memberName,
        projectPath,
        timeoutMs: 90_000,
      }).catch(() => undefined);

      const stream = await waitForTaskLogStream({
        source: createLiveOpenCodeTaskLogSource(harness, projectPath),
        teamName,
        taskId: task.id,
        marker,
      });
      const rawMessages = flattenRawMessages(stream);
      const toolNames = rawMessages.flatMap((message) =>
        message.toolCalls.map((toolCall) => toolCall.name)
      );
      const serialized = rawMessages
        .map((message) =>
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
        )
        .join('\n');

      expect(stream.source).toMatch(/^opencode_runtime_/);
      expect(stream.runtimeProjection?.provider).toBe('opencode');
      expect(stream.runtimeProjection?.attributionRecordCount ?? 0).toBeGreaterThan(0);
      expect(stream.runtimeProjection?.nativeToolCount ?? 0).toBeGreaterThan(0);
      expect(toolNames).toEqual(
        expect.arrayContaining(['agent-teams_task_start', 'agent-teams_task_add_comment', 'bash'])
      );
      expect(serialized).toContain(`${marker}:task-comment-after-sleep`);
    },
    360_000
  );
});

async function waitForLedgerRecord(input: {
  teamName: string;
  laneId: string;
  messageId: string;
}) {
  return await waitUntilValue(async () => {
    const ledger = createOpenCodePromptDeliveryLedgerStore({
      filePath: getOpenCodeLaneScopedRuntimeFilePath({
        teamsBasePath: getTeamsBasePath(),
        teamName: input.teamName,
        laneId: input.laneId,
        fileName: 'opencode-prompt-delivery-ledger.json',
      }),
    });
    const records = await ledger.list().catch(() => []);
    return records.find((record) => record.inboxMessageId === input.messageId) ?? null;
  }, 30_000);
}

async function waitForTaskLogStream(input: {
  source: OpenCodeTaskLogStreamSource;
  teamName: string;
  taskId: string;
  marker: string;
}): Promise<BoardTaskLogStreamResponse> {
  let lastStream: BoardTaskLogStreamResponse | null = null;
  return await waitUntilValue(async () => {
    const stream = await input.source.getTaskLogStream(input.teamName, input.taskId);
    lastStream = stream;
    if (!stream) {
      return null;
    }
    const rawMessages = flattenRawMessages(stream);
    const toolNames = rawMessages.flatMap((message) =>
      message.toolCalls.map((toolCall) => toolCall.name)
    );
    const serialized = rawMessages
      .map((message) =>
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
      )
      .join('\n');
    const hasExpectedTools =
      toolNames.includes('agent-teams_task_start') &&
      toolNames.includes('agent-teams_task_add_comment') &&
      toolNames.includes('bash');
    return hasExpectedTools && serialized.includes(`${input.marker}:task-comment-after-sleep`)
      ? stream
      : null;
  }, 90_000, 500, async () =>
    `Last stream: ${JSON.stringify(
      {
        source: lastStream?.source,
        runtimeProjection: lastStream?.runtimeProjection,
        segmentCount: lastStream?.segments.length ?? 0,
        toolNames: lastStream
          ? flattenRawMessages(lastStream).flatMap((message) =>
              message.toolCalls.map((toolCall) => toolCall.name)
            )
          : [],
      },
      null,
      2
    )}`
  );
}

function createLiveOpenCodeTaskLogSource(
  harness: OpenCodeLiveHarness,
  projectPath: string
): OpenCodeTaskLogStreamSource {
  const runtimeBridge = {
    getOpenCodeTranscript: async (
      _binaryPath: string,
      params: {
        teamId: string;
        memberName: string;
        limit?: number;
        laneId?: string;
        sessionId?: string;
        timeoutMs?: number;
      }
    ) => {
      const result = await harness.bridgeClient.execute<
        {
          teamId: string;
          teamName: string;
          laneId: string;
          memberName: string;
          sessionId?: string;
          limit?: number;
        },
        {
          providerId?: string;
          transcript?: unknown;
          logProjection?: unknown;
          messages?: unknown;
        }
      >(
        'opencode.getRuntimeTranscript',
        {
          teamId: params.teamId,
          teamName: params.teamId,
          laneId: params.laneId ?? 'primary',
          memberName: params.memberName,
          ...(params.sessionId?.trim() ? { sessionId: params.sessionId.trim() } : {}),
          ...(typeof params.limit === 'number' ? { limit: params.limit } : {}),
        },
        { cwd: projectPath, timeoutMs: params.timeoutMs ?? 60_000 }
      );
      if (!result.ok) {
        throw new Error(
          `OpenCode live transcript bridge failed: ${result.error.message}; diagnostics=${JSON.stringify(
            result.diagnostics
          )}`
        );
      }
      const data = result.data;
      if (data.providerId === 'opencode' && data.transcript) {
        return data.transcript;
      }
      if (data.logProjection || data.messages) {
        return data;
      }
      return null;
    },
  } as unknown as ClaudeMultimodelBridgeService;

  return new OpenCodeTaskLogStreamSource(runtimeBridge, {
    resolve: async () => DEFAULT_ORCHESTRATOR_CLI,
  });
}

async function readTask(teamName: string, taskId: string) {
  const tasks = await new TeamTaskReader().getTasks(teamName);
  return tasks.find((candidate) => candidate.id === taskId) ?? null;
}

function flattenRawMessages(response: BoardTaskLogStreamResponse): ParsedMessage[] {
  return response.segments.flatMap((segment) =>
    segment.chunks.flatMap((chunk) => chunk.rawMessages)
  );
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  pollMs = 500,
  diagnostics?: () => Promise<string>
): Promise<void> {
  await waitUntilValue(
    async () => ((await predicate()) ? true : null),
    timeoutMs,
    pollMs,
    diagnostics
  );
}

async function waitUntilValue<T>(
  producer: () => Promise<T | null>,
  timeoutMs: number,
  pollMs = 500,
  diagnostics?: () => Promise<string>
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await producer();
      if (value !== null) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const detail = diagnostics ? `\n${await diagnostics().catch(String)}` : '';
  const errorDetail = lastError ? `\nLast error: ${String(lastError)}` : '';
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition${detail}${errorDetail}`);
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
