import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { readOpenUIReply } from '../../../../scripts/lib/openui-chat-reply';
import { parseChatVisualization } from '../../../../src/features/chat-visualizations/renderer/parseChatVisualization';
import { guardChatVisualizationProgram } from '../../../../src/features/chat-visualizations/renderer/programGuards';
import { TeamInboxWriter } from '../../../../src/main/services/team/TeamInboxWriter';
import {
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';

import {
  createOpenCodeLiveHarness,
  getRuntimeTranscript,
  type OpenCodeOriginalTranscriptBinding,
  waitForOpenCodeLanesStopped,
  waitForOpenCodeMemberIdle,
  waitUntil,
} from './openCodeLiveTestHarness';

const liveDescribe =
  process.env.OPENCODE_E2E === '1' && process.env.OPENCODE_E2E_VISUALIZATION === '1'
    ? describe
    : describe.skip;
type Harness = Awaited<ReturnType<typeof createOpenCodeLiveHarness>>;
interface DisplayNode {
  typeName: string;
  props: Record<string, unknown>;
}
interface Reply {
  from: string;
  to: string;
  text: string;
  messageId: string;
  relayOfMessageId: string;
  source: string;
}
interface ToolCall {
  toolName?: string;
  status?: string;
  isError?: boolean;
  input?: Record<string, unknown>;
}
interface CaseContext {
  harness: Harness;
  teamName: string;
  projectPath: string;
  tempDir: string;
  bindings: Record<string, OpenCodeOriginalTranscriptBinding>;
}

function visibleContent(text: string): { sources: string[]; prose: string } {
  const { fences, prose } = readOpenUIReply(text);
  return {
    sources: fences.filter((fence) => fence.state === 'closed').map((fence) => fence.source),
    prose,
  };
}

async function readReplies(teamName: string): Promise<Reply[]> {
  try {
    return JSON.parse(
      await fs.readFile(path.join(getTeamsBasePath(), teamName, 'inboxes', 'user.json'), 'utf8')
    ) as Reply[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function save(tempDir: string, name: string, data: unknown): Promise<void> {
  await fs.writeFile(path.join(tempDir, `${name}.json`), JSON.stringify(data, null, 2) + '\n');
}

function parseReply(sources: string[]) {
  const programs = sources.map((source) => {
    expect(source.length).toBeLessThanOrEqual(32_000);
    const parsed = parseChatVisualization(source);
    expect(parsed.meta.errors).toEqual([]);
    expect(parsed.meta.incomplete).toBe(false);
    expect(parsed.meta.unresolved).toEqual([]);
    expect(guardChatVisualizationProgram(parsed, 'closed')).toEqual({ status: 'ready' });
    return { source, parsed };
  });
  expect(programs.length, 'A real chat reply must contain a closed OpenUI fence').toBeGreaterThan(
    0
  );
  const nodes = programs.flatMap(({ parsed }) =>
    (parsed.root!.props.children as DisplayNode[]).flatMap(
      (card) => card.props.children as DisplayNode[]
    )
  );
  return { programs, nodes };
}

function verifyDiscovery(nodes: DisplayNode[]): void {
  const bars = nodes.filter((node) => node.typeName === 'BarChart');
  expect(bars).toHaveLength(1);
  expect(bars[0].props.labels).toEqual(['Альфа', 'Бета']);
  const series = bars[0].props.series as DisplayNode[];
  expect(series).toHaveLength(1);
  expect(series[0].props.values).toEqual([10, 20]);
}

function verifyVariants(nodes: DisplayNode[]): void {
  const bar = nodes.find((node) => node.typeName === 'BarChart');
  expect(bar?.props.variant).toBe('stacked');
  expect(bar?.props.labels).toEqual(['Jan', 'Feb', 'Mar']);
  const series = bar?.props.series as DisplayNode[];
  expect(series.map((item) => [item.props.category, item.props.values])).toEqual([
    ['Plan', [10, 20, 30]],
    ['Actual', [12, 18, 33]],
  ]);
  const line = nodes.find((node) => node.typeName === 'LineChart');
  expect(line?.props.variant).toBe('step');
  expect(line?.props.labels).toEqual(['Mon', 'Tue', 'Wed', 'Thu']);
  expect((line?.props.series as DisplayNode[])[0].props.values).toEqual([2, 7, 3, 9]);
  const pie = nodes.find((node) => node.typeName === 'PieChart');
  expect(pie?.props.variant).toBe('donut');
  expect(pie?.props.appearance).toBe('semiCircular');
  expect(pie?.props.labels).toEqual(['Rent', 'Food', 'Travel']);
  expect(pie?.props.values).toEqual([60, 25, 15]);
  const table = nodes.find((node) => node.typeName === 'Table');
  expect(
    (table?.props.columns as DisplayNode[]).map((col) => [col.props.label, col.props.data])
  ).toEqual([
    ['Category', ['Alpha', 'Beta']],
    ['Value', [10, 20]],
  ]);
}

async function runCase(context: CaseContext, memberName: string, variants = false): Promise<void> {
  const { harness, teamName, projectPath, tempDir } = context;
  const transcriptInput = {
    bridgeClient: harness.bridgeClient,
    teamName,
    memberName,
    projectPath,
    originalBinding: context.bindings[memberName],
  };
  const caseName = `${memberName}-${variants ? 'variants' : 'discovery'}`;
  const marker = `OPENUI_${randomUUID()}`;
  const request = variants
    ? 'Покажи прямо здесь в чате через OpenUI мини-дашборд: столбцы с накоплением по Jan, Feb, Mar для Plan 10, 20, 30 и Actual 12, 18, 33; ступенчатую линию по Mon, Tue, Wed, Thu со значениями 2, 7, 3, 9; полукруглое кольцо расходов Rent 60, Food 25, Travel 15; таблицу с колонками Category и Value для Alpha 10 и Beta 20. Все данные учебные и приведены здесь. Добавь короткое объяснение.'
    : 'Покажи прямо здесь в чате через OpenUI столбчатую диаграмму: Альфа — 10, Бета — 20. Добавь короткое объяснение.';
  // The user request deliberately contains no DSL, component signatures, tool,
  // briefing, or delivery hints: these must come from the production context.
  const text = `${request}\nВключи в пояснение идентификатор проверки: ${marker}.`;
  const written = await new TeamInboxWriter().sendMessage(teamName, {
    member: memberName,
    from: 'user',
    to: memberName,
    source: 'user_sent',
    text,
  });
  await save(tempDir, `${caseName}-request`, { text, marker, written });
  let lastRelay: Awaited<ReturnType<Harness['svc']['relayInboxFileToLiveRecipient']>> | undefined;
  try {
    await waitUntil(
      async () => {
        lastRelay = await harness.svc.relayInboxFileToLiveRecipient(teamName, memberName, {
          onlyMessageId: written.messageId,
          source: 'ui-send',
          deliveryMetadata: { replyRecipient: 'user' },
        });
        if (
          lastRelay.lastDelivery?.delivered === false &&
          !lastRelay.lastDelivery.responsePending
        ) {
          throw new Error(`OpenCode delivery failed: ${JSON.stringify(lastRelay)}`);
        }
        return lastRelay.relayed === 1;
      },
      180_000,
      1500
    );
    await save(tempDir, `${caseName}-relay`, lastRelay);
    await waitUntil(
      async () => {
        if (
          (await readReplies(teamName)).some(
            (row) =>
              row.from === memberName &&
              row.relayOfMessageId === written.messageId &&
              visibleContent(row.text).sources.length > 0
          )
        )
          return true;
        const transcript = (await getRuntimeTranscript(transcriptInput)) as {
          data?: { messages?: { hasError?: boolean; errorMessage?: string; errorName?: string }[] };
        };
        const failure = transcript.data?.messages?.find((message) => message.hasError);
        if (failure)
          throw new Error(
            `OpenCode model error: ${failure.errorName ?? ''}: ${failure.errorMessage ?? ''}`
          );
        return false;
      },
      180_000,
      1500
    );
    await waitForOpenCodeMemberIdle({
      ...transcriptInput,
      timeoutMs: 120_000,
    });
    const matches = (await readReplies(teamName)).filter(
      (row) => row.relayOfMessageId === written.messageId
    );
    await save(tempDir, `${caseName}-replies`, matches);
    expect(matches).toHaveLength(1);
    const reply = matches[0];
    expect(reply).toMatchObject({
      from: memberName,
      to: 'user',
      source: 'runtime_delivery',
      relayOfMessageId: written.messageId,
    });
    expect(reply.messageId).toBeTruthy();
    const { sources, prose } = visibleContent(reply.text);
    expect(prose).toContain(marker);
    expect(prose.replace(marker, '').trim()).toMatch(/\p{L}{3}/u);
    const transcript = await getRuntimeTranscript(transcriptInput);
    await save(tempDir, `${caseName}-transcript`, transcript);
    const calls =
      (
        transcript as { data?: { messages?: { toolCalls?: ToolCall[] }[] } }
      ).data?.messages?.flatMap((message) => message.toolCalls ?? []) ?? [];
    const send = calls.find(
      (call) =>
        call.toolName?.endsWith('message_send') &&
        call.status === 'completed' &&
        !call.isError &&
        call.input?.relayOfMessageId === written.messageId
    );
    expect(send, 'Real model must invoke the MCP communication tool').toMatchObject({
      status: 'completed',
      isError: false,
    });
    expect(send?.input).toMatchObject({
      teamName,
      from: memberName,
      to: 'user',
      source: reply.source,
      relayOfMessageId: written.messageId,
      text: reply.text,
    });
    if (!variants) {
      const briefing = memberName === 'team-lead' ? 'lead_briefing' : 'member_briefing';
      expect(
        calls.some(
          (call) =>
            call.toolName?.endsWith(briefing) && call.status === 'completed' && !call.isError
        ),
        `Fresh ${memberName} must discover the actual display specification`
      ).toBe(true);
    }
    const parsed = parseReply(sources);
    if (variants) verifyVariants(parsed.nodes);
    else verifyDiscovery(parsed.nodes);
    await save(tempDir, `${caseName}-proof`, { passed: true, reply, ...parsed });
  } finally {
    await save(tempDir, `${caseName}-last-relay`, lastRelay ?? null);
    await save(
      tempDir,
      `${caseName}-final-transcript`,
      await getRuntimeTranscript(transcriptInput).catch((error) => ({ error: String(error) }))
    );
  }
}

liveDescribe('OpenCode chat visualization live e2e', () => {
  it('discovers OpenUI for a fresh lead/member and sends supported variants into the real chat inbox', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-visualization-e2e-'));
    const projectPath = path.join(tempDir, 'project');
    const claudeRoot = path.join(tempDir, 'claude-state');
    const teamName = `openui-live-${Date.now()}`;
    const selectedModel = process.env.OPENCODE_E2E_MODEL?.trim() ?? 'opencode/big-pickle';
    const progress: unknown[] = [];
    let harness: Harness | undefined;
    let passed = false;
    await fs.mkdir(projectPath, { recursive: true });
    await fs.mkdir(claudeRoot, { recursive: true });
    setClaudeBasePathOverride(claudeRoot);
    console.info(`[OpenCodeVisualization.live] model=${selectedModel} artifacts=${tempDir}`);
    try {
      harness = await createOpenCodeLiveHarness({
        tempDir,
        projectPath,
        selectedModel,
        launchTimeoutMs: 240_000,
      });
      const launch = await harness.svc.createTeam(
        {
          teamName,
          cwd: projectPath,
          providerId: 'opencode',
          model: selectedModel,
          skipPermissions: true,
          members: [
            { name: 'visualizer', role: 'Developer', providerId: 'opencode', model: selectedModel },
          ],
        },
        (event) => {
          progress.push(event);
        }
      );
      const snapshot = await harness.svc.getTeamAgentRuntimeSnapshot(teamName);
      await save(tempDir, 'launch', {
        launch,
        progress,
        snapshot,
      });
      expect(launch.runId).toBeTruthy();
      expect(
        snapshot.runId,
        `OpenCode launch did not commit a live run: ${JSON.stringify(progress)}`
      ).toBe(launch.runId);
      const bindings: Record<string, OpenCodeOriginalTranscriptBinding> = {};
      for (const memberName of ['team-lead', 'visualizer']) {
        const originalBinding = {
          runId: launch.runId,
          laneId: snapshot.members[memberName]?.laneId ?? '',
          runtimeSessionId: snapshot.members[memberName]?.runtimeSessionId ?? '',
        };
        expect(originalBinding.laneId).toBeTruthy();
        expect(originalBinding.runtimeSessionId).toBeTruthy();
        bindings[memberName] = originalBinding;
        await waitForOpenCodeMemberIdle({
          bridgeClient: harness.bridgeClient,
          teamName,
          memberName,
          projectPath,
          originalBinding,
          timeoutMs: 120_000,
        });
        await save(
          tempDir,
          `${memberName}-bootstrap`,
          await getRuntimeTranscript({
            bridgeClient: harness.bridgeClient,
            teamName,
            memberName,
            projectPath,
            originalBinding,
          })
        );
      }
      expect(
        await readReplies(teamName),
        'Fresh attach must remain silent until a real user request'
      ).toHaveLength(0);
      const context = { harness, teamName, projectPath, tempDir, bindings };
      await runCase(context, 'team-lead');
      await runCase(context, 'visualizer');
      await runCase(context, 'visualizer', true);
      passed = true;
    } catch (error) {
      await save(tempDir, 'failure', {
        error:
          error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
      });
      throw error;
    } finally {
      await save(tempDir, 'result', {
        passed,
        teamName,
        selectedModel,
        progress,
        scope:
          'Real app main services/runtime/MCP and durable chat inbox; Electron renderer not launched.',
      });
      try {
        if (harness) {
          try {
            await harness.svc.stopTeam(teamName);
          } finally {
            await harness.dispose();
          }
          await waitForOpenCodeLanesStopped(teamName);
        }
      } finally {
        setClaudeBasePathOverride(null);
        if (process.env.OPENCODE_E2E_KEEP_TEMP === '1')
          console.info(`[OpenCodeVisualization.live] preserved ${tempDir}`);
        else await fs.rm(tempDir, { recursive: true, force: true });
      }
    }
  }, 900_000);
});
