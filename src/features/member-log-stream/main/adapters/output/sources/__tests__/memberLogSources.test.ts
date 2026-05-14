import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  OPENCODE_PROMPT_DELIVERY_LEDGER_SCHEMA_VERSION,
  type OpenCodePromptDeliveryLedgerRecord,
} from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MEMBER_LOG_PREVIEW_BUDGET } from '../../../../../core/domain/models/MemberLogPreviewBudget';
import { DEFAULT_MEMBER_LOG_STREAM_BUDGET } from '../../../../../core/domain/models/MemberLogStreamBudget';
import { ClaudeMemberTranscriptPreviewSource } from '../ClaudeMemberTranscriptPreviewSource';
import { ClaudeMemberTranscriptStreamSource } from '../ClaudeMemberTranscriptStreamSource';
import { CodexNativeMemberTracePreviewSource } from '../CodexNativeMemberTracePreviewSource';
import { CodexNativeMemberTraceStreamSource } from '../CodexNativeMemberTraceStreamSource';
import { OpenCodeMemberRuntimePreviewSource } from '../OpenCodeMemberRuntimePreviewSource';
import { OpenCodeMemberRuntimeStreamSource } from '../OpenCodeMemberRuntimeStreamSource';

import type { MemberLogPreviewSourceInput } from '../../../../../core/application/ports/MemberLogPreviewSource';
import type { MemberLogStreamSourceInput } from '../../../../../core/application/ports/MemberLogStreamSource';
import type { EnhancedChunk, ParsedMessage } from '@main/types';

function parsedMessage(uuid: string, timestamp: string): ParsedMessage {
  return {
    uuid,
    parentUuid: null,
    type: 'assistant',
    timestamp: new Date(timestamp),
    role: 'assistant',
    content: `message ${uuid}`,
    isSidechain: true,
    isMeta: false,
    sessionId: 'session-1',
    toolCalls: [],
    toolResults: [],
  };
}

function fakeChunk(id: string): EnhancedChunk {
  return {
    id,
    chunkType: 'ai',
    startTime: new Date('2026-04-04T00:00:00.000Z'),
    endTime: new Date('2026-04-04T00:00:01.000Z'),
    durationMs: 1_000,
    metrics: {
      durationMs: 1_000,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      messageCount: 1,
    },
    responses: [],
    processes: [],
    sidechainMessages: [],
    toolExecutions: [],
    semanticSteps: [],
    rawMessages: [],
  };
}

function sourceInput(
  overrides: Partial<MemberLogStreamSourceInput> = {}
): MemberLogStreamSourceInput {
  return {
    teamName: 'alpha-team',
    memberName: 'alice',
    budget: DEFAULT_MEMBER_LOG_STREAM_BUDGET,
    ...overrides,
  };
}

function previewInput(
  overrides: Partial<MemberLogPreviewSourceInput> = {}
): MemberLogPreviewSourceInput {
  return {
    teamName: 'alpha-team',
    memberName: 'alice',
    budget: DEFAULT_MEMBER_LOG_PREVIEW_BUDGET,
    maxItems: 3,
    textLimit: 200,
    ...overrides,
  };
}

const tempClaudeRoots: string[] = [];

afterEach(async () => {
  setClaudeBasePathOverride(null);
  const roots = tempClaudeRoots.splice(0);
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function createTempClaudeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'member-log-source-'));
  tempClaudeRoots.push(root);
  setClaudeBasePathOverride(root);
  return root;
}

async function writeOpenCodePromptLedger(input: {
  claudeRoot: string;
  teamName: string;
  laneId: string;
  records: OpenCodePromptDeliveryLedgerRecord[];
}): Promise<string> {
  const ledgerPath = path.join(
    input.claudeRoot,
    'teams',
    input.teamName,
    '.opencode-runtime',
    'lanes',
    encodeURIComponent(input.laneId),
    'opencode-prompt-delivery-ledger.json'
  );
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await writeFile(
    ledgerPath,
    `${JSON.stringify(
      {
        schemaVersion: OPENCODE_PROMPT_DELIVERY_LEDGER_SCHEMA_VERSION,
        updatedAt: '2026-04-04T00:00:00.000Z',
        data: input.records,
      },
      null,
      2
    )}\n`
  );
  return ledgerPath;
}

function openCodeLedgerRecord(
  overrides: Partial<OpenCodePromptDeliveryLedgerRecord> = {}
): OpenCodePromptDeliveryLedgerRecord {
  const now = overrides.updatedAt ?? '2026-04-04T00:00:00.000Z';
  return {
    id: overrides.id ?? 'opencode-prompt:record-1',
    teamName: overrides.teamName ?? 'alpha-team',
    memberName: overrides.memberName ?? 'alice',
    laneId: overrides.laneId ?? 'secondary:opencode:alice',
    runId: 'opencode-run-1',
    runtimeSessionId: 'opencode-session',
    inboxMessageId: 'inbox-message-1',
    inboxTimestamp: now,
    source: 'watcher',
    messageKind: null,
    replyRecipient: 'team-lead',
    actionMode: 'do',
    taskRefs: [{ taskId: 'task-1', displayId: 'abc12345', teamName: 'alpha-team' }],
    payloadHash: 'sha256:test',
    status: 'responded',
    responseState: 'responded_visible_message',
    attempts: 1,
    maxAttempts: 3,
    acceptanceUnknown: false,
    nextAttemptAt: null,
    lastAttemptAt: now,
    lastObservedAt: now,
    acceptedAt: now,
    respondedAt: now,
    failedAt: null,
    inboxReadCommittedAt: null,
    inboxReadCommitError: null,
    prePromptCursor: null,
    postPromptCursor: null,
    deliveredUserMessageId: 'opencode-user-message',
    observedAssistantMessageId: 'opencode-assistant-message',
    observedAssistantPreview: 'Implemented the calculator updates and verified tests.',
    observedToolCallNames: [],
    observedVisibleMessageId: null,
    visibleReplyMessageId: 'visible-reply-1',
    visibleReplyInbox: 'team-lead',
    visibleReplyCorrelation: 'plain_assistant_text',
    lastReason: null,
    diagnostics: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('ClaudeMemberTranscriptStreamSource', () => {
  it('dedupes cumulative subagent refs by member/session before parsing and keeps path-safe segment ids', async () => {
    const parseFiles = vi.fn().mockImplementation(async (paths: string[]) => {
      const parsed = new Map<string, ParsedMessage[]>();
      parsed.set('/transcripts/larger.jsonl', [
        parsedMessage('msg-1', '2026-04-04T00:00:00.000Z'),
        parsedMessage('msg-2', '2026-04-04T00:01:00.000Z'),
      ]);
      expect(paths).toEqual(['/transcripts/larger.jsonl']);
      return parsed;
    });
    const chunkBuilder = {
      buildBundleChunks: vi.fn(() => [fakeChunk('chunk-1')]),
    };
    const source = new ClaudeMemberTranscriptStreamSource(
      {
        findRecentMemberLogFileRefsByMember: vi.fn().mockResolvedValue([
          {
            memberName: 'alice',
            sessionId: 'session-1',
            filePath: '/transcripts/smaller.jsonl',
            mtimeMs: 10,
            sizeBytes: 1_000,
            messageCount: 1,
            kind: 'subagent',
          },
          {
            memberName: 'alice',
            sessionId: 'session-1',
            filePath: '/transcripts/larger.jsonl',
            mtimeMs: 20,
            sizeBytes: 5_000,
            messageCount: 10,
            kind: 'subagent',
          },
        ]),
      } as never,
      { parseFiles } as never,
      chunkBuilder as never,
      { warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    );

    const result = await source.load(sourceInput());

    expect(result.status).toBe('included');
    expect(parseFiles).toHaveBeenCalledWith(['/transcripts/larger.jsonl']);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.id).not.toContain('/transcripts');
    expect(result.segments[0]?.source).toMatchObject({
      provider: 'claude_transcript',
      sessionId: 'session-1',
      messageCount: 2,
    });
  });
});

describe('ClaudeMemberTranscriptPreviewSource', () => {
  it('builds compact previews from parsed transcript messages without chunk building', async () => {
    const parseFiles = vi.fn().mockResolvedValue(
      new Map<string, ParsedMessage[]>([
        [
          '/transcripts/latest.jsonl',
          [
            {
              ...parsedMessage('tool-call', '2026-04-04T00:00:00.000Z'),
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu-1',
                  name: 'Bash',
                  input: { command: 'pnpm test', ignored: 'x'.repeat(5_000) },
                },
              ],
            },
            {
              ...parsedMessage('tool-result', '2026-04-04T00:01:00.000Z'),
              type: 'user',
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'toolu-1',
                  content: 'x'.repeat(5_000),
                },
              ],
            },
          ],
        ],
      ])
    );
    const source = new ClaudeMemberTranscriptPreviewSource(
      {
        findRecentMemberLogFileRefsByMember: vi.fn().mockResolvedValue([
          {
            memberName: 'alice',
            sessionId: 'session-1',
            filePath: '/transcripts/latest.jsonl',
            mtimeMs: 20,
            sizeBytes: 5_000,
            messageCount: 2,
            kind: 'subagent',
          },
        ]),
      } as never,
      { parseFiles } as never,
      { warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    );

    const result = await source.loadPreview(previewInput({ textLimit: 160 }));

    expect(result.status).toBe('included');
    expect(result.items.map((item) => item.kind)).toEqual(['tool_result']);
    expect(result.items[0]?.preview?.length).toBeLessThanOrEqual(160);
    expect(parseFiles).toHaveBeenCalledWith(['/transcripts/latest.jsonl']);
  });
});

describe('OpenCodeMemberRuntimeStreamSource', () => {
  it('enforces member message and content budgets before building OpenCode chunks', async () => {
    const getOpenCodeTranscript = vi.fn().mockResolvedValue({
      sessionId: 'opencode-session',
      logProjection: {
        messages: [0, 1, 2].map((index) => ({
          uuid: `opencode-${index}`,
          parentUuid: index === 0 ? null : `opencode-${index - 1}`,
          type: 'assistant',
          timestamp: `2026-04-04T00:00:0${index}.000Z`,
          role: 'assistant',
          content: `long OpenCode runtime message ${index} ${'x'.repeat(80)}`,
          toolCalls: [],
          toolResults: [],
          isMeta: false,
          sessionId: 'opencode-session',
        })),
      },
    });
    const buildBundleChunks = vi.fn((_: ParsedMessage[]) => [fakeChunk('opencode-budgeted-chunk')]);
    const source = new OpenCodeMemberRuntimeStreamSource(
      { getOpenCodeTranscript } as never,
      { buildBundleChunks } as never,
      { resolve: vi.fn().mockResolvedValue('/mock/orchestrator') }
    );

    const result = await source.load(
      sourceInput({
        budget: {
          ...DEFAULT_MEMBER_LOG_STREAM_BUDGET,
          maxMessagesPerSegment: 2,
          maxTotalContentChars: 60,
          maxMessageContentChars: 40,
        },
      })
    );

    expect(result.status).toBe('included');
    expect(result.metadata?.droppedMessageCount).toBe(1);
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(['segment_message_window_limited', 'message_content_limited'])
    );
    expect(result.segments[0]?.source).toMatchObject({
      provider: 'opencode_runtime',
      messageCount: 2,
      truncated: true,
    });
    expect(buildBundleChunks).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ uuid: 'opencode-1' }),
        expect.objectContaining({ uuid: 'opencode-2' }),
      ])
    );
    expect(JSON.stringify(buildBundleChunks.mock.calls[0]?.[0])).toContain(
      '[content truncated by member log stream budget]'
    );
  });

  it('joins active bridge calls, uses TTL cache, and lets forceRefresh bypass completed cache only', async () => {
    const getOpenCodeTranscript = vi.fn().mockResolvedValue({
      sessionId: 'opencode-session',
      logProjection: {
        messages: [
          {
            uuid: 'opencode-1',
            parentUuid: null,
            type: 'assistant',
            timestamp: '2026-04-04T00:00:00.000Z',
            role: 'assistant',
            content: 'hello',
            toolCalls: [],
            toolResults: [],
            isMeta: false,
            sessionId: 'opencode-session',
          },
        ],
      },
    });
    const source = new OpenCodeMemberRuntimeStreamSource(
      { getOpenCodeTranscript } as never,
      { buildBundleChunks: vi.fn(() => [fakeChunk('opencode-chunk')]) } as never,
      { resolve: vi.fn().mockResolvedValue('/mock/orchestrator') }
    );
    const input = sourceInput({ laneId: 'secondary:opencode:alice' });

    const [first, second] = await Promise.all([source.load(input), source.load(input)]);

    expect(first.status).toBe('included');
    expect(second.status).toBe('included');
    expect(getOpenCodeTranscript).toHaveBeenCalledTimes(1);

    await source.load(input);
    expect(getOpenCodeTranscript).toHaveBeenCalledTimes(1);

    await source.load({ ...input, forceRefresh: true });
    expect(getOpenCodeTranscript).toHaveBeenCalledTimes(2);
    expect(getOpenCodeTranscript).toHaveBeenLastCalledWith(
      '/mock/orchestrator',
      expect.objectContaining({
        teamId: 'alpha-team',
        memberName: 'alice',
        laneId: 'secondary:opencode:alice',
        timeoutMs: DEFAULT_MEMBER_LOG_STREAM_BUDGET.openCodeTimeoutMs,
      })
    );
  });

  it('reports ambiguous OpenCode lane errors as skipped provider warnings', async () => {
    const source = new OpenCodeMemberRuntimeStreamSource(
      {
        getOpenCodeTranscript: vi
          .fn()
          .mockRejectedValue(new Error('multiple records, pass --lane')),
      } as never,
      { buildBundleChunks: vi.fn(() => [fakeChunk('opencode-chunk')]) } as never,
      { resolve: vi.fn().mockResolvedValue('/mock/orchestrator') }
    );

    const result = await source.load(sourceInput());

    expect(result).toMatchObject({
      provider: 'opencode_runtime',
      status: 'skipped',
      warnings: [
        {
          code: 'opencode_ambiguous_lane',
          message: 'OpenCode runtime session is ambiguous without a safe lane id.',
        },
      ],
    });
  });
});

describe('OpenCodeMemberRuntimePreviewSource', () => {
  it('skips OpenCode preview without a safe lane id before touching the runtime bridge', async () => {
    const getOpenCodeTranscript = vi.fn();
    const resolve = vi.fn();
    const source = new OpenCodeMemberRuntimePreviewSource({ getOpenCodeTranscript } as never, {
      resolve,
    });

    const result = await source.loadPreview(previewInput());

    expect(result).toMatchObject({
      provider: 'opencode_runtime',
      status: 'skipped',
      reason: 'opencode_safe_lane_unavailable',
      items: [],
      warnings: [],
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(getOpenCodeTranscript).not.toHaveBeenCalled();
  });

  it('uses lane delivery ledger previews before touching the runtime bridge', async () => {
    const claudeRoot = await createTempClaudeRoot();
    const laneId = 'secondary:opencode:alice';
    await writeOpenCodePromptLedger({
      claudeRoot,
      teamName: 'alpha-team',
      laneId,
      records: [
        openCodeLedgerRecord({
          laneId,
          observedAssistantPreview:
            'Finished #abc12345 after reading context. <system-reminder>hidden</system-reminder>',
        }),
      ],
    });
    const getOpenCodeTranscript = vi.fn();
    const resolve = vi.fn();
    const source = new OpenCodeMemberRuntimePreviewSource({ getOpenCodeTranscript } as never, {
      resolve,
    });

    const result = await source.loadPreview(previewInput({ laneId }));

    expect(result.status).toBe('included');
    expect(result.items[0]).toMatchObject({
      kind: 'text',
      title: 'OpenCode reply',
      preview: 'Finished #abc12345 after reading context.',
      sourceLabel: 'OpenCode delivery',
      sessionId: 'opencode-session',
      laneId,
    });
    expect(result.truncated).toBe(false);
    expect(result.overflowCount).toBe(0);
    expect(resolve).not.toHaveBeenCalled();
    expect(getOpenCodeTranscript).not.toHaveBeenCalled();
  });

  it('renders OpenCode non-visible tool activity from the delivery ledger', async () => {
    const claudeRoot = await createTempClaudeRoot();
    const laneId = 'secondary:opencode:alice';
    await writeOpenCodePromptLedger({
      claudeRoot,
      teamName: 'alpha-team',
      laneId,
      records: [
        openCodeLedgerRecord({
          laneId,
          responseState: 'responded_non_visible_tool',
          observedAssistantPreview: null,
          observedToolCallNames: ['task_get', 'read', 'bash', 'read'],
        }),
      ],
    });
    const source = new OpenCodeMemberRuntimePreviewSource(
      { getOpenCodeTranscript: vi.fn() } as never,
      { resolve: vi.fn() }
    );

    const result = await source.loadPreview(previewInput({ laneId }));

    expect(result.status).toBe('included');
    expect(result.items[0]).toMatchObject({
      kind: 'tool_use',
      title: 'Tool activity',
      preview: 'task_get, read, bash',
      tone: 'neutral',
    });
  });

  it('renders terminal OpenCode delivery errors as error-toned previews', async () => {
    const claudeRoot = await createTempClaudeRoot();
    const laneId = 'secondary:opencode:alice';
    await writeOpenCodePromptLedger({
      claudeRoot,
      teamName: 'alpha-team',
      laneId,
      records: [
        openCodeLedgerRecord({
          laneId,
          status: 'failed_terminal',
          responseState: 'tool_error',
          observedAssistantPreview: null,
          lastReason: 'tool failed with stderr output',
          diagnostics: ['stderr: permission denied'],
          failedAt: '2026-04-04T00:01:00.000Z',
          updatedAt: '2026-04-04T00:01:00.000Z',
        }),
      ],
    });
    const source = new OpenCodeMemberRuntimePreviewSource(
      { getOpenCodeTranscript: vi.fn() } as never,
      { resolve: vi.fn() }
    );

    const result = await source.loadPreview(previewInput({ laneId }));

    expect(result.status).toBe('included');
    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Tool error',
      preview: 'tool failed with stderr output',
      tone: 'error',
    });
  });

  it('renders the real relay-works bob ledger shape as tool activity without runtime transcript', async () => {
    const claudeRoot = await createTempClaudeRoot();
    const teamName = 'relay-works';
    const memberName = 'bob';
    const laneId = 'secondary:opencode:bob';
    await writeOpenCodePromptLedger({
      claudeRoot,
      teamName,
      laneId,
      records: [
        openCodeLedgerRecord({
          id: 'opencode-prompt:relay-bob-real-shape',
          teamName,
          memberName,
          laneId,
          runId: 'relay-bob-run',
          runtimeSessionId: 'relay-bob-session',
          inboxMessageId: 'relay-bob-inbox-message',
          inboxTimestamp: '2026-05-06T21:55:58.077Z',
          actionMode: null,
          taskRefs: [
            {
              taskId: '20eb14b4-144d-4c52-89c1-bdeb7b9a14ef',
              displayId: '20eb14b4',
              teamName,
            },
          ],
          status: 'responded',
          responseState: 'responded_non_visible_tool',
          attempts: 2,
          nextAttemptAt: '2026-05-06T21:56:26.767Z',
          lastAttemptAt: '2026-05-06T21:57:03.644Z',
          lastObservedAt: '2026-05-06T21:57:03.644Z',
          acceptedAt: '2026-05-06T21:56:11.751Z',
          respondedAt: '2026-05-06T21:56:11.751Z',
          inboxReadCommittedAt: '2026-05-06T21:57:03.692Z',
          observedAssistantPreview: null,
          observedToolCallNames: ['task_get', 'bash', 'task_start', 'read', 'glob'],
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          lastReason: 'non_visible_tool_without_task_progress',
          diagnostics: [
            'OpenCode app MCP was reattached before message delivery.',
            'OpenCode bootstrap MCP did not complete required tools before assistant response: runtime_bootstrap_checkin, member_briefing',
          ],
          createdAt: '2026-05-06T21:55:58.224Z',
          updatedAt: '2026-05-06T21:57:03.692Z',
        }),
      ],
    });
    const getOpenCodeTranscript = vi.fn();
    const source = new OpenCodeMemberRuntimePreviewSource({ getOpenCodeTranscript } as never, {
      resolve: vi.fn(),
    });

    const result = await source.loadPreview(
      previewInput({ teamName, memberName, laneId, textLimit: 160 })
    );

    expect(result.status).toBe('included');
    expect(result.items[0]).toMatchObject({
      kind: 'tool_use',
      title: 'Tool activity',
      preview: 'task_get, bash, task_start, read, glob',
      tone: 'neutral',
      sessionId: 'relay-bob-session',
      laneId,
    });
    expect(getOpenCodeTranscript).not.toHaveBeenCalled();
  });

  it('renders the real relay-works jack visible-reply failure as a readable error', async () => {
    const claudeRoot = await createTempClaudeRoot();
    const teamName = 'relay-works';
    const memberName = 'jack';
    const laneId = 'secondary:opencode:jack';
    await writeOpenCodePromptLedger({
      claudeRoot,
      teamName,
      laneId,
      records: [
        openCodeLedgerRecord({
          id: 'opencode-prompt:relay-jack-real-shape',
          teamName,
          memberName,
          laneId,
          runId: 'relay-jack-run',
          runtimeSessionId: 'relay-jack-session',
          inboxMessageId: 'relay-jack-stall-message',
          inboxTimestamp: '2026-05-06T22:06:32.842Z',
          source: 'watchdog',
          replyRecipient: 'user',
          actionMode: 'do',
          taskRefs: [
            {
              taskId: '32cc252b-7c6f-4f1d-af0a-c13c18861a4e',
              displayId: '32cc252b',
              teamName,
            },
          ],
          status: 'failed_terminal',
          responseState: 'responded_visible_message',
          attempts: 3,
          nextAttemptAt: null,
          lastAttemptAt: '2026-05-06T22:08:03.447Z',
          lastObservedAt: '2026-05-06T22:08:03.447Z',
          acceptedAt: '2026-05-06T22:07:00.236Z',
          respondedAt: '2026-05-06T22:07:00.236Z',
          failedAt: '2026-05-06T22:08:03.471Z',
          inboxReadCommittedAt: null,
          observedAssistantPreview: null,
          observedToolCallNames: ['task_get', 'message_send'],
          observedVisibleMessageId: 'functions.agent-teams_message_send:1',
          visibleReplyMessageId: null,
          visibleReplyCorrelation: 'direct_child_message_send',
          lastReason: 'visible_reply_destination_not_found_yet',
          diagnostics: [
            'OpenCode app MCP was reattached before message delivery.',
            'visible_reply_destination_not_found_yet',
          ],
          createdAt: '2026-05-06T22:06:32.865Z',
          updatedAt: '2026-05-06T22:08:03.471Z',
        }),
      ],
    });
    const getOpenCodeTranscript = vi.fn();
    const source = new OpenCodeMemberRuntimePreviewSource({ getOpenCodeTranscript } as never, {
      resolve: vi.fn(),
    });

    const result = await source.loadPreview(previewInput({ teamName, memberName, laneId }));

    expect(result.status).toBe('included');
    expect(result.items[0]).toMatchObject({
      kind: 'tool_result',
      title: 'Visible reply missing',
      preview: 'visible reply destination not found yet',
      tone: 'error',
      sessionId: 'relay-jack-session',
      laneId,
    });
    expect(getOpenCodeTranscript).not.toHaveBeenCalled();
  });

  it('reports ledger overflow from the full filtered lane record count', async () => {
    const claudeRoot = await createTempClaudeRoot();
    const laneId = 'secondary:opencode:alice';
    await writeOpenCodePromptLedger({
      claudeRoot,
      teamName: 'alpha-team',
      laneId,
      records: Array.from({ length: 5 }, (_, index) =>
        openCodeLedgerRecord({
          id: `opencode-prompt:record-${index}`,
          laneId,
          observedAssistantPreview: `Ledger event ${index}`,
          updatedAt: `2026-04-04T00:00:0${index}.000Z`,
        })
      ),
    });
    const source = new OpenCodeMemberRuntimePreviewSource(
      { getOpenCodeTranscript: vi.fn() } as never,
      { resolve: vi.fn() }
    );

    const result = await source.loadPreview(previewInput({ laneId, maxItems: 3 }));

    expect(result.status).toBe('included');
    expect(result.truncated).toBe(true);
    expect(result.overflowCount).toBe(2);
    expect(result.items.map((item) => item.preview)).toEqual([
      'Ledger event 4',
      'Ledger event 3',
      'Ledger event 2',
    ]);
  });

  it('falls back to OpenCode transcript when the delivery ledger has no renderable records', async () => {
    await createTempClaudeRoot();
    const laneId = 'secondary:opencode:alice';
    const getOpenCodeTranscript = vi.fn().mockResolvedValue({
      sessionId: 'opencode-session',
      logProjection: {
        messages: [
          {
            uuid: 'opencode-transcript-1',
            parentUuid: null,
            type: 'assistant',
            timestamp: '2026-04-04T00:00:00.000Z',
            role: 'assistant',
            content: 'Transcript response from OpenCode.',
            toolCalls: [],
            toolResults: [],
            isMeta: false,
            sessionId: 'opencode-session',
          },
        ],
      },
    });
    const source = new OpenCodeMemberRuntimePreviewSource({ getOpenCodeTranscript } as never, {
      resolve: vi.fn().mockResolvedValue('/mock/orchestrator'),
    });

    const result = await source.loadPreview(previewInput({ laneId }));

    expect(result.status).toBe('included');
    expect(result.items[0]).toMatchObject({
      kind: 'text',
      title: 'Assistant',
      preview: 'Transcript response from OpenCode.',
    });
    expect(result.warnings).toEqual([]);
    expect(getOpenCodeTranscript).toHaveBeenCalledTimes(1);
  });

  it('reports runtime unavailable when no ledger exists and the OpenCode binary is missing', async () => {
    await createTempClaudeRoot();
    const laneId = 'secondary:opencode:alice';
    const getOpenCodeTranscript = vi.fn();
    const source = new OpenCodeMemberRuntimePreviewSource({ getOpenCodeTranscript } as never, {
      resolve: vi.fn().mockResolvedValue(null),
    });

    const result = await source.loadPreview(previewInput({ laneId }));

    expect(result).toMatchObject({
      provider: 'opencode_runtime',
      status: 'skipped',
      reason: 'OpenCode runtime bridge is unavailable.',
      warnings: [
        {
          code: 'opencode_runtime_unavailable',
          message: 'OpenCode runtime bridge is unavailable.',
        },
      ],
    });
    expect(getOpenCodeTranscript).not.toHaveBeenCalled();
  });

  it('renders the real comet-hub OpenCode transcript error shape when no ledger exists', async () => {
    await createTempClaudeRoot();
    const teamName = 'comet-hub';
    const memberName = 'bob';
    const laneId = 'secondary:opencode:bob';
    const getOpenCodeTranscript = vi.fn().mockResolvedValue({
      sessionId: 'ses_1ddb71a6affexQQR3lRdHRfAOX',
      logProjection: {
        messages: [
          {
            uuid: 'msg_e224bf71b0017NamfjVeIoBdP7',
            parentUuid: null,
            type: 'assistant',
            timestamp: '2026-05-13T17:04:24.347Z',
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking:
                  'I need to stop. The protocol instruction says to stop after the message_send succeeds.',
                signature: 'opencode',
              },
              {
                type: 'text',
                text: 'All done. Task #622701b8 completed and approved.',
              },
            ],
            toolCalls: [],
            toolResults: [],
            isMeta: false,
            sessionId: 'ses_1ddb71a6affexQQR3lRdHRfAOX',
          },
          {
            uuid: 'msg_e224c0ae2001F76RknnkihymsV::error',
            parentUuid: 'msg_e224bf71b0017NamfjVeIoBdP7',
            type: 'system',
            timestamp: '2026-05-13T17:04:45.546Z',
            role: 'system',
            content: 'OpenCode runtime error - UnknownError: database or disk is full',
            toolCalls: [],
            toolResults: [],
            isMeta: false,
            sessionId: 'ses_1ddb71a6affexQQR3lRdHRfAOX',
          },
        ],
      },
    });
    const source = new OpenCodeMemberRuntimePreviewSource({ getOpenCodeTranscript } as never, {
      resolve: vi.fn().mockResolvedValue('/mock/orchestrator'),
    });

    const result = await source.loadPreview(previewInput({ teamName, memberName, laneId }));

    expect(result.status).toBe('included');
    expect(result.items[0]).toMatchObject({
      kind: 'text',
      title: 'Runtime error',
      preview: 'OpenCode runtime error - UnknownError: database or disk is full',
      tone: 'error',
      sourceLabel: 'OpenCode runtime',
      sessionId: 'ses_1ddb71a6affexQQR3lRdHRfAOX',
      laneId,
    });
    expect(getOpenCodeTranscript).toHaveBeenCalledTimes(1);
  });

  it('does not classify command text containing --lane as an ambiguous lane failure', async () => {
    await createTempClaudeRoot();
    const laneId = 'secondary:opencode:alice';
    const getOpenCodeTranscript = vi
      .fn()
      .mockRejectedValue(
        new Error(`Command failed: runtime transcript --lane ${laneId} exited with code 1`)
      );
    const source = new OpenCodeMemberRuntimePreviewSource({ getOpenCodeTranscript } as never, {
      resolve: vi.fn().mockResolvedValue('/mock/orchestrator'),
    });

    const result = await source.loadPreview(previewInput({ laneId }));

    expect(result.status).toBe('skipped');
    expect(result.warnings[0]?.code).toBe('opencode_runtime_unavailable');
  });

  it('classifies killed OpenCode transcript calls as timeouts even when command text includes --lane', async () => {
    await createTempClaudeRoot();
    const laneId = 'secondary:opencode:alice';
    const getOpenCodeTranscript = vi
      .fn()
      .mockRejectedValue(
        new Error(`Command failed: runtime transcript --lane ${laneId} exited with code 143`)
      );
    const source = new OpenCodeMemberRuntimePreviewSource({ getOpenCodeTranscript } as never, {
      resolve: vi.fn().mockResolvedValue('/mock/orchestrator'),
    });

    const result = await source.loadPreview(previewInput({ laneId }));

    expect(result.status).toBe('skipped');
    expect(result.warnings[0]?.code).toBe('opencode_runtime_timeout');
  });

  it('classifies exec timeout objects as OpenCode runtime timeouts', async () => {
    await createTempClaudeRoot();
    const laneId = 'secondary:opencode:alice';
    const timeoutError = Object.assign(
      new Error(`Command failed: runtime transcript --lane ${laneId}`),
      {
        killed: true,
        signal: 'SIGTERM',
      }
    );
    const getOpenCodeTranscript = vi.fn().mockRejectedValue(timeoutError);
    const source = new OpenCodeMemberRuntimePreviewSource({ getOpenCodeTranscript } as never, {
      resolve: vi.fn().mockResolvedValue('/mock/orchestrator'),
    });

    const result = await source.loadPreview(previewInput({ laneId }));

    expect(result.status).toBe('skipped');
    expect(result.warnings[0]?.code).toBe('opencode_runtime_timeout');
  });

  it('keeps batch preview working when the delivery ledger is corrupt', async () => {
    const claudeRoot = await createTempClaudeRoot();
    const laneId = 'secondary:opencode:alice';
    const ledgerPath = path.join(
      claudeRoot,
      'teams',
      'alpha-team',
      '.opencode-runtime',
      'lanes',
      encodeURIComponent(laneId),
      'opencode-prompt-delivery-ledger.json'
    );
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, '{not-json');
    const getOpenCodeTranscript = vi.fn().mockResolvedValue({
      sessionId: 'opencode-session',
      logProjection: {
        messages: [
          {
            uuid: 'opencode-transcript-1',
            parentUuid: null,
            type: 'assistant',
            timestamp: '2026-04-04T00:00:00.000Z',
            role: 'assistant',
            content: 'Transcript still works.',
            toolCalls: [],
            toolResults: [],
            isMeta: false,
            sessionId: 'opencode-session',
          },
        ],
      },
    });
    const source = new OpenCodeMemberRuntimePreviewSource({ getOpenCodeTranscript } as never, {
      resolve: vi.fn().mockResolvedValue('/mock/orchestrator'),
    });

    const result = await source.loadPreview(previewInput({ laneId }));

    expect(result.status).toBe('included');
    expect(result.items[0]?.preview).toBe('Transcript still works.');
    expect(result.warnings.map((warning) => warning.code)).toContain(
      'opencode_runtime_unavailable'
    );
  });

  it('uses encoded lane-specific ledger paths and filters unrelated records', async () => {
    const claudeRoot = await createTempClaudeRoot();
    const laneId = 'secondary:opencode:ali/ce?x';
    const ledgerPath = await writeOpenCodePromptLedger({
      claudeRoot,
      teamName: 'alpha-team',
      laneId,
      records: [
        openCodeLedgerRecord({
          id: 'opencode-prompt:other-member',
          laneId,
          memberName: 'bob',
          observedAssistantPreview: 'Wrong member',
        }),
        openCodeLedgerRecord({
          id: 'opencode-prompt:other-lane',
          laneId: 'secondary:opencode:other',
          observedAssistantPreview: 'Wrong lane',
        }),
        openCodeLedgerRecord({
          id: 'opencode-prompt:valid',
          laneId,
          observedAssistantPreview: 'Correct lane preview',
        }),
      ],
    });
    const source = new OpenCodeMemberRuntimePreviewSource(
      { getOpenCodeTranscript: vi.fn() } as never,
      { resolve: vi.fn() }
    );

    const result = await source.loadPreview(previewInput({ laneId }));

    expect(ledgerPath).toContain(encodeURIComponent(laneId));
    expect(result.status).toBe('included');
    expect(result.items.map((item) => item.preview)).toEqual(['Correct lane preview']);
  });

  it('uses bounded OpenCode projection messages and preserves safe lane ids', async () => {
    const getOpenCodeTranscript = vi.fn().mockResolvedValue({
      sessionId: 'opencode-session',
      logProjection: {
        messages: [
          {
            uuid: 'opencode-1',
            parentUuid: null,
            type: 'assistant',
            timestamp: '2026-04-04T00:00:00.000Z',
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu-1',
                name: 'Edit',
                input: { filePath: 'src/app.ts' },
              },
            ],
            toolCalls: [],
            toolResults: [],
            isMeta: false,
            sessionId: 'opencode-session',
          },
        ],
      },
    });
    const source = new OpenCodeMemberRuntimePreviewSource(
      { getOpenCodeTranscript } as never,
      {
        resolve: vi.fn().mockResolvedValue('/mock/orchestrator'),
      },
      {
        list: vi.fn().mockResolvedValue([]),
      }
    );

    const result = await source.loadPreview(previewInput({ laneId: 'secondary:opencode:alice' }));

    expect(result.status).toBe('included');
    expect(result.items[0]).toMatchObject({
      kind: 'tool_use',
      title: 'Edit',
      laneId: 'secondary:opencode:alice',
    });
    expect(getOpenCodeTranscript).toHaveBeenCalledWith(
      '/mock/orchestrator',
      expect.objectContaining({
        limit: DEFAULT_MEMBER_LOG_PREVIEW_BUDGET.openCodeMessageLimit,
        timeoutMs: DEFAULT_MEMBER_LOG_PREVIEW_BUDGET.openCodeTimeoutMs,
        laneId: 'secondary:opencode:alice',
      })
    );
  });
});

describe('CodexNativeMemberTraceStreamSource', () => {
  it('returns an honest skipped warning for Codex members only', async () => {
    const codexSource = new CodexNativeMemberTraceStreamSource({
      getConfig: vi.fn().mockResolvedValue({
        members: [{ name: 'alice', providerId: 'codex' }],
      }),
    } as never);
    const nonCodexSource = new CodexNativeMemberTraceStreamSource({
      getConfig: vi.fn().mockResolvedValue({
        members: [{ name: 'alice', providerId: 'opencode' }],
      }),
    } as never);
    const unknownLeadSource = new CodexNativeMemberTraceStreamSource({
      getConfig: vi.fn().mockRejectedValue(new Error('config unavailable')),
    } as never);

    await expect(codexSource.load(sourceInput())).resolves.toMatchObject({
      status: 'skipped',
      warnings: [{ code: 'codex_member_wide_not_supported' }],
    });
    await expect(nonCodexSource.load(sourceInput())).resolves.toMatchObject({
      status: 'skipped',
      warnings: [],
    });
    await expect(
      unknownLeadSource.load(sourceInput({ memberName: 'team-lead' }))
    ).resolves.toMatchObject({
      status: 'skipped',
      warnings: [],
    });
  });
});

describe('CodexNativeMemberTracePreviewSource', () => {
  it('returns unsupported empty coverage for known Codex previews without breaking the batch', async () => {
    const codexSource = new CodexNativeMemberTracePreviewSource({
      getConfig: vi.fn().mockResolvedValue({
        members: [{ name: 'alice', providerId: 'codex' }],
      }),
    } as never);
    const unknownLeadSource = new CodexNativeMemberTracePreviewSource({
      getConfig: vi.fn().mockRejectedValue(new Error('config unavailable')),
    } as never);

    await expect(codexSource.loadPreview(previewInput())).resolves.toMatchObject({
      provider: 'codex_native_trace',
      status: 'skipped',
      items: [],
      warnings: [{ code: 'codex_member_wide_not_supported' }],
    });
    await expect(
      unknownLeadSource.loadPreview(previewInput({ memberName: 'team-lead' }))
    ).resolves.toMatchObject({
      provider: 'codex_native_trace',
      status: 'skipped',
      items: [],
      warnings: [],
    });
  });
});
