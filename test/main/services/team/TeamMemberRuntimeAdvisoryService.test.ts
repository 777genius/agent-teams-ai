import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as fs from 'fs/promises';

import { TeamMemberRuntimeAdvisoryService } from '../../../../src/main/services/team/TeamMemberRuntimeAdvisoryService';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

import type { MemberRuntimeAdvisory, ResolvedTeamMember } from '../../../../src/shared/types/team';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildMember(
  name: string,
  removedAt?: number
): Pick<ResolvedTeamMember, 'name' | 'removedAt'> {
  return removedAt == null ? { name } : { name, removedAt };
}

function buildRetryingAdvisory(label: string): MemberRuntimeAdvisory {
  return {
    kind: 'sdk_retrying',
    observedAt: '2026-04-09T10:00:00.000Z',
    retryUntil: '2026-04-09T10:01:00.000Z',
    retryDelayMs: 60_000,
    reasonCode: 'backend_error',
    message: `retry:${label}`,
  };
}

function createStubbedServiceHarness() {
  const logsFinder = {
    findMemberLogs: vi.fn(async (_teamName: string, memberName: string) => [
      { filePath: `/logs/${memberName}.jsonl` },
    ]),
    findRecentMemberLogFileRefsByMember: undefined as
      | undefined
      | ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown[]>>>,
  };
  const service = new TeamMemberRuntimeAdvisoryService(logsFinder as never);
  const advisoryByFilePath = new Map<string, MemberRuntimeAdvisory | null>();
  const readRecentApiRetryAdvisory = vi
    .spyOn(service as never, 'readRecentApiRetryAdvisory' as never)
    .mockImplementation(async (...args: unknown[]) => {
      const filePath = String(args[0] ?? '');
      if (advisoryByFilePath.has(filePath)) {
        return advisoryByFilePath.get(filePath) ?? null;
      }
      return buildRetryingAdvisory(path.basename(filePath, '.jsonl'));
    });

  return { service, logsFinder, advisoryByFilePath, readRecentApiRetryAdvisory };
}

describe('TeamMemberRuntimeAdvisoryService', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setClaudeBasePathOverride(null);
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('returns active sdk retry advisory for a teammate log', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-advisory-'));
    setClaudeBasePathOverride(tmpDir);

    const teamName = 'signal-ops';
    const projectPath = '/Users/test/proj';
    const projectId = '-Users-test-proj';
    const leadSessionId = 'lead-session';

    await fs.mkdir(path.join(tmpDir, 'teams', teamName), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamName, 'config.json'),
      JSON.stringify({
        name: teamName,
        projectPath,
        leadSessionId,
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'alice', agentType: 'general-purpose' },
        ],
      }),
      'utf8'
    );

    const projectRoot = path.join(tmpDir, 'projects', projectId);
    await fs.mkdir(path.join(projectRoot, leadSessionId, 'subagents'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, `${leadSessionId}.jsonl`),
      `${JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', content: 'Start' },
      })}\n`,
      'utf8'
    );

    const nowIso = new Date().toISOString();
    await fs.writeFile(
      path.join(projectRoot, leadSessionId, 'subagents', 'agent-alice.jsonl'),
      [
        JSON.stringify({
          timestamp: nowIso,
          type: 'user',
          message: {
            role: 'user',
            content: 'You are alice, a reviewer on team "signal-ops" (signal-ops).',
          },
        }),
        JSON.stringify({
          timestamp: nowIso,
          type: 'system',
          subtype: 'api_error',
          retryInMs: 45_000,
          retryAttempt: 1,
          maxRetries: 10,
          error: {
            error: {
              error: {
                message: 'Gemini cli backend error: capacity exceeded.',
              },
            },
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const service = new TeamMemberRuntimeAdvisoryService();
    const advisory = await service.getMemberAdvisory(teamName, 'alice');

    expect(advisory).not.toBeNull();
    expect(advisory?.kind).toBe('sdk_retrying');
    expect(advisory?.reasonCode).toBe('quota_exhausted');
    expect(advisory?.message).toContain('capacity exceeded');
  });

  it.each([
    ['rate_limited', 'Provider returned 429 rate limit for this request.'],
    [
      'rate_limited',
      'All credentials for model claude-opus-4-6 are cooling down via provider claude.',
    ],
    ['auth_error', 'Authentication failed due to invalid API key.'],
    [
      'quota_exhausted',
      'Key limit exceeded (total limit). Manage it using https://openrouter.ai/settings/keys',
    ],
    ['codex_native_timeout', 'Codex native exec timed out after 120000ms.'],
    ['network_error', 'Fetch failed because the network connection timed out.'],
    ['filesystem_error', 'ENOSPC: no space left on device, write'],
    ['provider_overloaded', 'Service unavailable: provider temporarily unavailable (503).'],
    ['protocol_proof_missing', 'OpenCode created a reply without the required taskRefs metadata.'],
    ['backend_error', 'Unexpected backend blew up during request processing.'],
  ] as const)('classifies %s retry causes from api_error messages', async (expected, message) => {
    const service = new TeamMemberRuntimeAdvisoryService({} as never);
    const advisory = (service as any).extractApiRetryAdvisory(
      JSON.stringify({
        type: 'system',
        subtype: 'api_error',
        timestamp: '2099-04-09T10:00:00.000Z',
        retryInMs: 45_000,
        error: {
          error: {
            error: {
              message,
            },
          },
        },
      })
    ) as MemberRuntimeAdvisory | null;

    expect(advisory?.reasonCode).toBe(expected);
  });

  it('classifies missing api_error message text as unknown', () => {
    const service = new TeamMemberRuntimeAdvisoryService({} as never);
    const advisory = (service as any).extractApiRetryAdvisory(
      JSON.stringify({
        type: 'system',
        subtype: 'api_error',
        timestamp: '2099-04-09T10:00:00.000Z',
        retryInMs: 45_000,
      })
    ) as MemberRuntimeAdvisory | null;

    expect(advisory?.reasonCode).toBe('unknown');
  });

  it('keeps terminal API errors visible after retries stop', () => {
    const service = new TeamMemberRuntimeAdvisoryService({} as never);
    const observedAt = '2099-04-09T10:00:00.000Z';
    const advisory = (service as any).extractApiErrorAdvisory(
      JSON.stringify({
        type: 'assistant',
        timestamp: observedAt,
        isApiErrorMessage: true,
        error: 'unknown',
        message: {
          content: [
            {
              type: 'text',
              text: 'API Error: 500 {"error":{"message":"auth_unavailable: no auth available","type":"server_error"}}',
            },
          ],
        },
      }),
      Date.parse(observedAt)
    ) as MemberRuntimeAdvisory | null;

    expect(advisory).toMatchObject({
      kind: 'api_error',
      reasonCode: 'auth_error',
      statusCode: 500,
    });
    expect(advisory?.retryUntil).toBeUndefined();
    expect(advisory?.message).toContain('auth_unavailable');
  });

  it('treats Claude Code account access failures as auth errors', () => {
    const service = new TeamMemberRuntimeAdvisoryService({} as never);
    const observedAt = '2099-04-09T10:00:00.000Z';
    const advisory = (service as any).extractApiErrorAdvisory(
      JSON.stringify({
        type: 'assistant',
        timestamp: observedAt,
        isApiErrorMessage: true,
        error: 'authentication_failed',
        message: {
          content: [
            {
              type: 'text',
              text: 'Your account does not have access to Claude Code. Please run /login.',
            },
          ],
        },
      }),
      Date.parse(observedAt)
    ) as MemberRuntimeAdvisory | null;

    expect(advisory?.kind).toBe('api_error');
    expect(advisory?.reasonCode).toBe('auth_error');
  });

  it('surfaces recent OpenCode prompt delivery provider failures as member advisories', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-advisory-'));
    setClaudeBasePathOverride(tmpDir);

    const teamName = 'signal-ops';
    const laneId = 'secondary:opencode:bob';
    const nowIso = new Date().toISOString();
    const laneDir = path.join(
      tmpDir,
      'teams',
      teamName,
      '.opencode-runtime',
      'lanes',
      encodeURIComponent(laneId)
    );
    await fs.mkdir(laneDir, { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamName, '.opencode-runtime', 'lanes.json'),
      JSON.stringify({
        version: 1,
        updatedAt: nowIso,
        lanes: {
          [laneId]: { laneId, state: 'active', updatedAt: nowIso },
        },
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(laneDir, 'opencode-prompt-delivery-ledger.json'),
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: nowIso,
        data: [
          {
            id: 'opencode-prompt:test',
            teamName,
            memberName: 'bob',
            laneId,
            runId: 'run-1',
            runtimeSessionId: 'ses-1',
            inboxMessageId: 'msg-1',
            inboxTimestamp: nowIso,
            source: 'watcher',
            messageKind: null,
            replyRecipient: 'team-lead',
            actionMode: null,
            taskRefs: [],
            payloadHash: 'sha256:test',
            status: 'failed_terminal',
            responseState: 'empty_assistant_turn',
            attempts: 3,
            maxAttempts: 3,
            acceptanceUnknown: false,
            nextAttemptAt: null,
            lastAttemptAt: nowIso,
            lastObservedAt: nowIso,
            acceptedAt: nowIso,
            respondedAt: null,
            failedAt: nowIso,
            inboxReadCommittedAt: null,
            inboxReadCommitError: null,
            prePromptCursor: null,
            postPromptCursor: null,
            deliveredUserMessageId: 'delivered-1',
            observedAssistantMessageId: 'assistant-1',
            observedAssistantPreview: null,
            observedToolCallNames: [],
            observedVisibleMessageId: null,
            visibleReplyMessageId: null,
            visibleReplyInbox: null,
            visibleReplyCorrelation: null,
            lastReason: 'empty_assistant_turn',
            diagnostics: [
              'OpenCode bridge command timed out',
              'Latest assistant message msg_1 failed with APIError - Insufficient credits. Add more using https://openrouter.ai/settings/credits',
              'empty_assistant_turn',
            ],
            createdAt: nowIso,
            updatedAt: nowIso,
          },
        ],
      }),
      'utf8'
    );

    const service = new TeamMemberRuntimeAdvisoryService({
      findMemberLogs: vi.fn(async () => {
        throw new Error('log scan should not be needed when OpenCode ledger has an error');
      }),
    });
    const advisory = await service.getMemberAdvisory(teamName, 'bob');

    expect(advisory).toMatchObject({
      kind: 'api_error',
      reasonCode: 'quota_exhausted',
    });
    expect(advisory?.message).toContain('Insufficient credits');
    expect(advisory?.message).not.toContain('Latest assistant message');
  });

  it('keeps pending OpenCode free usage exhaustion visible while delivery is unresolved', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-17T21:44:45.000Z'));
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-advisory-'));
    setClaudeBasePathOverride(tmpDir);

    const teamName = 'forge-labs';
    const laneId = 'secondary:opencode:tom';
    const oldIso = '2026-05-17T21:44:34.000Z';
    const laneDir = path.join(
      tmpDir,
      'teams',
      teamName,
      '.opencode-runtime',
      'lanes',
      encodeURIComponent(laneId)
    );
    await fs.mkdir(laneDir, { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamName, '.opencode-runtime', 'lanes.json'),
      JSON.stringify({
        version: 1,
        updatedAt: oldIso,
        lanes: {
          [laneId]: { laneId, state: 'active', updatedAt: oldIso },
        },
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(laneDir, 'opencode-prompt-delivery-ledger.json'),
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: oldIso,
        data: [
          {
            id: 'opencode-prompt:free-usage-pending',
            teamName,
            memberName: 'tom',
            laneId,
            runId: 'run-1',
            runtimeSessionId: 'ses-1',
            inboxMessageId: 'msg-1',
            inboxTimestamp: oldIso,
            source: 'watcher',
            messageKind: null,
            replyRecipient: 'team-lead',
            actionMode: null,
            taskRefs: [],
            payloadHash: 'sha256:test',
            status: 'accepted',
            responseState: 'pending',
            attempts: 2,
            maxAttempts: 3,
            acceptanceUnknown: false,
            nextAttemptAt: '2026-05-17T21:44:37.000Z',
            lastAttemptAt: oldIso,
            lastObservedAt: oldIso,
            acceptedAt: '2026-05-17T21:40:21.000Z',
            respondedAt: null,
            failedAt: null,
            inboxReadCommittedAt: null,
            inboxReadCommitError: null,
            prePromptCursor: null,
            postPromptCursor: null,
            deliveredUserMessageId: 'msg-opencode-user',
            observedAssistantMessageId: 'msg-opencode-assistant',
            observedAssistantPreview: null,
            observedToolCallNames: [],
            observedVisibleMessageId: null,
            visibleReplyMessageId: null,
            visibleReplyInbox: null,
            visibleReplyCorrelation: null,
            lastReason: 'assistant_response_pending',
            diagnostics: [
              'OpenCode app MCP is connected for message delivery.',
              'OpenCode prompt_async accepted; response observation will continue through durable app-side ledger reconciliation.',
              'OpenCode session status retry - attempt=1 - Free usage exceeded, subscribe to Go https://opencode.ai/go - next=2026-05-18T00:00:00.502Z)',
            ],
            createdAt: oldIso,
            updatedAt: oldIso,
          },
        ],
      }),
      'utf8'
    );

    const service = new TeamMemberRuntimeAdvisoryService({
      findMemberLogs: vi.fn(async () => []),
    });
    const advisory = await service.getMemberAdvisory(teamName, 'tom');

    expect(advisory).toMatchObject({
      kind: 'api_error',
      reasonCode: 'quota_exhausted',
      retryUntil: '2026-05-18T00:00:00.502Z',
    });
    expect(advisory?.retryDelayMs).toBeGreaterThan(0);
    expect(advisory?.message).toContain('Free usage exceeded');
  });

  it('classifies terminal OpenCode protocol proof failures as warnings, not provider errors', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-advisory-'));
    setClaudeBasePathOverride(tmpDir);

    const teamName = 'relay-works';
    const laneId = 'secondary:opencode:jack';
    const nowIso = new Date().toISOString();
    const oldIso = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const laneDir = path.join(
      tmpDir,
      'teams',
      teamName,
      '.opencode-runtime',
      'lanes',
      encodeURIComponent(laneId)
    );
    await fs.mkdir(laneDir, { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamName, '.opencode-runtime', 'lanes.json'),
      JSON.stringify({
        version: 1,
        updatedAt: nowIso,
        lanes: {
          [laneId]: { laneId, state: 'active', updatedAt: nowIso },
        },
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(laneDir, 'opencode-prompt-delivery-ledger.json'),
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: oldIso,
        data: [
          {
            id: 'opencode-prompt:proof-missing',
            teamName,
            memberName: 'jack',
            laneId,
            runId: 'run-1',
            runtimeSessionId: 'ses-1',
            inboxMessageId: 'msg-1',
            inboxTimestamp: oldIso,
            source: 'watcher',
            messageKind: null,
            replyRecipient: 'team-lead',
            actionMode: null,
            taskRefs: [{ taskId: 'task-1', displayId: 'task-1', teamName }],
            payloadHash: 'sha256:test',
            status: 'failed_terminal',
            responseState: 'responded_non_visible_tool',
            attempts: 3,
            maxAttempts: 3,
            acceptanceUnknown: false,
            nextAttemptAt: null,
            lastAttemptAt: oldIso,
            lastObservedAt: oldIso,
            acceptedAt: oldIso,
            respondedAt: oldIso,
            failedAt: oldIso,
            inboxReadCommittedAt: null,
            inboxReadCommitError: null,
            prePromptCursor: null,
            postPromptCursor: null,
            deliveredUserMessageId: 'delivered-1',
            observedAssistantMessageId: 'assistant-1',
            observedAssistantPreview: null,
            observedToolCallNames: ['task_get'],
            observedVisibleMessageId: null,
            visibleReplyMessageId: null,
            visibleReplyInbox: null,
            visibleReplyCorrelation: null,
            lastReason: 'non_visible_tool_without_task_progress',
            diagnostics: ['non_visible_tool_without_task_progress'],
            createdAt: oldIso,
            updatedAt: oldIso,
          },
        ],
      }),
      'utf8'
    );

    const service = new TeamMemberRuntimeAdvisoryService({
      findMemberLogs: vi.fn(async () => []),
    });
    const advisory = await service.getMemberAdvisory(teamName, 'jack');

    expect(advisory).toMatchObject({
      kind: 'api_error',
      reasonCode: 'protocol_proof_missing',
      message: 'OpenCode used tools, but did not create a visible reply or task progress proof.',
    });
  });

  it('suppresses stale OpenCode prompt delivery advisories after a visible runtime reply exists', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-advisory-'));
    setClaudeBasePathOverride(tmpDir);

    const teamName = 'forge-labs';
    const laneId = 'secondary:opencode:jack';
    const laneDir = path.join(
      tmpDir,
      'teams',
      teamName,
      '.opencode-runtime',
      'lanes',
      encodeURIComponent(laneId)
    );
    await fs.mkdir(laneDir, { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'teams', teamName, 'inboxes'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamName, '.opencode-runtime', 'lanes.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2026-05-06T18:37:22.058Z',
        lanes: {
          [laneId]: { laneId, state: 'active', updatedAt: '2026-05-06T18:37:22.058Z' },
        },
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(laneDir, 'opencode-prompt-delivery-ledger.json'),
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: '2026-05-06T18:37:22.058Z',
        data: [
          {
            id: 'opencode-prompt:visible-required',
            teamName,
            memberName: 'jack',
            laneId,
            runId: 'run-1',
            runtimeSessionId: 'ses-1',
            inboxMessageId: 'comment-forward-1',
            inboxTimestamp: '2026-05-06T18:35:46.580Z',
            source: 'watcher',
            messageKind: null,
            replyRecipient: 'team-lead',
            actionMode: null,
            taskRefs: [],
            payloadHash: 'sha256:test',
            status: 'failed_terminal',
            responseState: 'responded_non_visible_tool',
            attempts: 3,
            maxAttempts: 3,
            acceptanceUnknown: false,
            nextAttemptAt: null,
            lastAttemptAt: '2026-05-06T18:37:22.019Z',
            lastObservedAt: '2026-05-06T18:37:22.019Z',
            acceptedAt: '2026-05-06T18:35:58.744Z',
            respondedAt: '2026-05-06T18:36:38.565Z',
            failedAt: '2026-05-06T18:37:22.056Z',
            inboxReadCommittedAt: null,
            inboxReadCommitError: null,
            prePromptCursor: null,
            postPromptCursor: null,
            deliveredUserMessageId: 'delivered-1',
            observedAssistantMessageId: 'assistant-1',
            observedAssistantPreview: null,
            observedToolCallNames: ['task_get'],
            observedVisibleMessageId: null,
            visibleReplyMessageId: null,
            visibleReplyInbox: null,
            visibleReplyCorrelation: null,
            lastReason: 'visible_reply_still_required',
            diagnostics: [
              'OpenCode bootstrap MCP did not complete required tools before assistant response: runtime_bootstrap_checkin, member_briefing',
              'visible_reply_still_required',
            ],
            createdAt: '2026-05-06T18:35:46.752Z',
            updatedAt: '2026-05-06T18:37:22.056Z',
          },
        ],
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamName, 'inboxes', 'team-lead.json'),
      JSON.stringify([
        {
          from: 'jack',
          to: 'team-lead',
          text: 'Готово, детали ниже.',
          timestamp: '2026-05-06T18:43:01.248Z',
          read: true,
          relayOfMessageId: 'comment-forward-1',
          source: 'runtime_delivery',
          messageId: 'visible-reply-1',
        },
      ]),
      'utf8'
    );

    const service = new TeamMemberRuntimeAdvisoryService({
      findMemberLogs: vi.fn(async () => []),
    });
    const advisory = await service.getMemberAdvisory(teamName, 'jack');

    expect(advisory).toBeNull();
  });

  it('suppresses stale OpenCode proof advisories after same-task member progress exists', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-advisory-'));
    setClaudeBasePathOverride(tmpDir);

    const teamName = 'mission-control';
    const laneId = 'secondary:opencode:bob';
    const taskId = '10d1c1b5-e8be-4dc9-a500-a7e2bc619c9e';
    const laneDir = path.join(
      tmpDir,
      'teams',
      teamName,
      '.opencode-runtime',
      'lanes',
      encodeURIComponent(laneId)
    );
    await fs.mkdir(laneDir, { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'tasks', teamName), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamName, '.opencode-runtime', 'lanes.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2026-05-08T06:37:47.470Z',
        lanes: {
          [laneId]: { laneId, state: 'active', updatedAt: '2026-05-08T06:37:47.470Z' },
        },
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(laneDir, 'opencode-prompt-delivery-ledger.json'),
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: '2026-05-08T06:37:47.470Z',
        data: [
          {
            id: 'opencode-prompt:task-progress-missing',
            teamName,
            memberName: 'bob',
            laneId,
            runId: 'run-1',
            runtimeSessionId: 'ses-1',
            inboxMessageId: 'task-assignment-1',
            inboxTimestamp: '2026-05-08T06:36:00.000Z',
            source: 'watcher',
            messageKind: null,
            replyRecipient: 'team-lead',
            actionMode: null,
            taskRefs: [{ taskId, displayId: '10d1c1b5', teamName }],
            payloadHash: 'sha256:test',
            status: 'failed_terminal',
            responseState: 'empty_assistant_turn',
            attempts: 3,
            maxAttempts: 3,
            acceptanceUnknown: false,
            nextAttemptAt: null,
            lastAttemptAt: '2026-05-08T06:37:30.000Z',
            lastObservedAt: '2026-05-08T06:37:33.167Z',
            acceptedAt: '2026-05-08T06:36:29.651Z',
            respondedAt: '2026-05-08T06:37:33.167Z',
            failedAt: '2026-05-08T06:37:47.470Z',
            inboxReadCommittedAt: null,
            inboxReadCommitError: null,
            prePromptCursor: null,
            postPromptCursor: null,
            deliveredUserMessageId: 'delivered-1',
            observedAssistantMessageId: 'assistant-1',
            observedAssistantPreview: null,
            observedToolCallNames: [],
            observedVisibleMessageId: null,
            visibleReplyMessageId: null,
            visibleReplyInbox: null,
            visibleReplyCorrelation: null,
            lastReason: 'empty_assistant_turn',
            diagnostics: ['empty_assistant_turn'],
            createdAt: '2026-05-08T06:36:00.000Z',
            updatedAt: '2026-05-08T06:37:47.470Z',
          },
        ],
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(tmpDir, 'tasks', teamName, `${taskId}.json`),
      JSON.stringify({
        id: taskId,
        displayId: '10d1c1b5',
        subject: 'Keyboard shortcuts',
        owner: 'bob',
        status: 'completed',
        updatedAt: '2026-05-08T06:40:55.128Z',
        comments: [
          {
            id: 'progress-comment-1',
            author: 'bob',
            text: 'Keyboard shortcuts implemented and verified.',
            createdAt: '2026-05-08T06:39:40.805Z',
            type: 'regular',
          },
        ],
        historyEvents: [
          {
            id: 'status-event-1',
            type: 'status_changed',
            from: 'in_progress',
            to: 'completed',
            actor: 'bob',
            timestamp: '2026-05-08T06:40:55.128Z',
          },
        ],
      }),
      'utf8'
    );

    const service = new TeamMemberRuntimeAdvisoryService({
      findMemberLogs: vi.fn(async () => []),
    });
    const advisory = await service.getMemberAdvisory(teamName, 'bob');

    expect(advisory).toBeNull();
  });

  it('suppresses stale OpenCode advisories when task refs can be inferred from the inbox comment', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-18T21:35:00.000Z'));
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-advisory-'));
    setClaudeBasePathOverride(tmpDir);

    const teamName = 'relay-works-69';
    const laneId = 'secondary:opencode:tom';
    const taskId = 'a7fd5f34-ff82-4ead-8089-34064454a623';
    const laneDir = path.join(
      tmpDir,
      'teams',
      teamName,
      '.opencode-runtime',
      'lanes',
      encodeURIComponent(laneId)
    );
    await fs.mkdir(laneDir, { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'teams', teamName, 'inboxes'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'tasks', teamName), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamName, '.opencode-runtime', 'lanes.json'),
      JSON.stringify({
        version: 1,
        updatedAt: '2026-05-18T21:27:58.582Z',
        lanes: {
          [laneId]: { laneId, state: 'active', updatedAt: '2026-05-18T21:27:58.582Z' },
        },
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(laneDir, 'opencode-prompt-delivery-ledger.json'),
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: '2026-05-18T21:27:58.582Z',
        data: [
          {
            id: 'opencode-prompt:dependency-comment',
            teamName,
            memberName: 'tom',
            laneId,
            runId: 'run-1',
            runtimeSessionId: 'ses-1',
            inboxMessageId: 'dependency-comment-1',
            inboxTimestamp: '2026-05-18T21:25:05.428Z',
            source: 'watcher',
            messageKind: null,
            replyRecipient: 'team-lead',
            actionMode: null,
            taskRefs: [],
            payloadHash: 'sha256:test',
            status: 'failed_terminal',
            responseState: 'session_stale',
            attempts: 1,
            maxAttempts: 3,
            acceptanceUnknown: false,
            nextAttemptAt: null,
            lastAttemptAt: '2026-05-18T21:25:27.592Z',
            lastObservedAt: '2026-05-18T21:27:58.582Z',
            acceptedAt: '2026-05-18T21:25:27.592Z',
            respondedAt: null,
            failedAt: '2026-05-18T21:27:58.582Z',
            inboxReadCommittedAt: null,
            inboxReadCommitError: null,
            prePromptCursor: null,
            postPromptCursor: null,
            deliveredUserMessageId: 'delivered-1',
            observedAssistantMessageId: null,
            observedAssistantPreview: null,
            observedToolCallNames: [],
            observedVisibleMessageId: null,
            visibleReplyMessageId: null,
            visibleReplyInbox: null,
            visibleReplyCorrelation: null,
            lastReason: 'opencode_session_stale_observe_loop_after_accepted_prompt',
            diagnostics: [
              'OpenCode API error',
              'OpenCode session stayed stale while observing an accepted prompt after 5 attempt(s).',
            ],
            createdAt: '2026-05-18T21:25:05.428Z',
            updatedAt: '2026-05-18T21:27:58.582Z',
          },
        ],
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamName, 'inboxes', 'tom.json'),
      JSON.stringify([
        {
          from: 'team-lead',
          to: 'tom',
          text: [
            '**Comment on task #a7fd5f34** _Calculator styles_',
            '',
            '> **Dependency resolved** - task #8dc34135 completed.',
            '> All blockers for #a7fd5f34 are resolved - this task is ready to start.',
          ].join('\n'),
          timestamp: '2026-05-18T21:25:05.428Z',
          read: false,
          summary: 'Comment on #a7fd5f34',
          messageId: 'dependency-comment-1',
          source: 'system_notification',
        },
      ]),
      'utf8'
    );
    await fs.writeFile(
      path.join(tmpDir, 'tasks', teamName, `${taskId}.json`),
      JSON.stringify({
        id: taskId,
        displayId: 'a7fd5f34',
        subject: 'Calculator styles',
        owner: 'tom',
        status: 'completed',
        updatedAt: '2026-05-18T21:25:21.453Z',
        comments: [
          {
            id: 'result-comment',
            author: 'tom',
            text: 'Styles completed and verified.',
            createdAt: '2026-05-18T21:25:18.441Z',
            type: 'regular',
          },
        ],
        historyEvents: [
          {
            id: 'completed-event',
            type: 'status_changed',
            from: 'in_progress',
            to: 'completed',
            actor: 'tom',
            timestamp: '2026-05-18T21:25:21.453Z',
          },
        ],
      }),
      'utf8'
    );

    const service = new TeamMemberRuntimeAdvisoryService({
      findMemberLogs: vi.fn(async () => []),
    });
    const advisory = await service.getMemberAdvisory(teamName, 'tom');

    expect(advisory).toBeNull();
  });

  it('ignores expired retry advisories', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-team-advisory-'));
    setClaudeBasePathOverride(tmpDir);

    const teamName = 'signal-ops';
    const projectPath = '/Users/test/proj';
    const projectId = '-Users-test-proj';
    const leadSessionId = 'lead-session';

    await fs.mkdir(path.join(tmpDir, 'teams', teamName), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'teams', teamName, 'config.json'),
      JSON.stringify({
        name: teamName,
        projectPath,
        leadSessionId,
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'alice', agentType: 'general-purpose' },
        ],
      }),
      'utf8'
    );

    const projectRoot = path.join(tmpDir, 'projects', projectId);
    await fs.mkdir(path.join(projectRoot, leadSessionId, 'subagents'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, `${leadSessionId}.jsonl`),
      `${JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', content: 'Start' },
      })}\n`,
      'utf8'
    );

    await fs.writeFile(
      path.join(projectRoot, leadSessionId, 'subagents', 'agent-alice.jsonl'),
      [
        JSON.stringify({
          timestamp: new Date(Date.now() - 60_000).toISOString(),
          type: 'user',
          message: {
            role: 'user',
            content: 'You are alice, a reviewer on team "signal-ops" (signal-ops).',
          },
        }),
        JSON.stringify({
          timestamp: new Date(Date.now() - 60_000).toISOString(),
          type: 'system',
          subtype: 'api_error',
          retryInMs: 5_000,
          retryAttempt: 1,
          maxRetries: 10,
          error: {
            error: {
              error: {
                message: 'Old retry window',
              },
            },
          },
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const service = new TeamMemberRuntimeAdvisoryService();
    await expect(service.getMemberAdvisory(teamName, 'alice')).resolves.toBeNull();
  });

  it('reuses batch cache within ttl and returns cloned advisory maps', async () => {
    const { service, logsFinder } = createStubbedServiceHarness();
    const members = [buildMember('Alice'), buildMember('Bob')];

    const first = await service.getMemberAdvisories('signal-ops', members);
    const second = await service.getMemberAdvisories('signal-ops', members);

    expect(logsFinder.findMemberLogs).toHaveBeenCalledTimes(2);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.get('Alice')).not.toBe(second.get('Alice'));
  });

  it('shares one in-flight batch request for concurrent identical calls', async () => {
    const { service, logsFinder } = createStubbedServiceHarness();
    const gate = createDeferred<void>();
    logsFinder.findMemberLogs.mockImplementation(async (_teamName: string, memberName: string) => {
      await gate.promise;
      return [{ filePath: `/logs/${memberName}.jsonl` }];
    });

    const firstRequest = service.getMemberAdvisories('signal-ops', [buildMember('Alice')]);
    const secondRequest = service.getMemberAdvisories('signal-ops', [buildMember('Alice')]);

    await vi.waitFor(() => expect(logsFinder.findMemberLogs).toHaveBeenCalledTimes(1));

    gate.resolve();
    const [first, second] = await Promise.all([firstRequest, secondRequest]);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  it('fetches only expired or missing members when building a batch', async () => {
    const { service, logsFinder } = createStubbedServiceHarness();

    await service.getMemberAdvisory('signal-ops', 'Alice');
    const memberCache = (
      service as unknown as {
        memberCache: Map<string, { value: MemberRuntimeAdvisory | null; expiresAt: number }>;
      }
    ).memberCache;
    memberCache.set('signal-ops::bob', {
      value: buildRetryingAdvisory('stale-bob'),
      expiresAt: Date.now() - 1,
    });

    const advisories = await service.getMemberAdvisories('signal-ops', [
      buildMember('Alice'),
      buildMember('Bob'),
      buildMember('Charlie'),
    ]);

    expect(logsFinder.findMemberLogs.mock.calls.map((call) => call[1])).toEqual([
      'Alice',
      'Bob',
      'Charlie',
    ]);
    expect(Array.from(advisories.keys())).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('uses batch member log refs once instead of scanning logs per missing member', async () => {
    const { service, logsFinder, advisoryByFilePath } = createStubbedServiceHarness();
    logsFinder.findRecentMemberLogFileRefsByMember = vi.fn(async () => [
      { memberName: 'Alice', filePath: '/logs/alice-new.jsonl', mtimeMs: 300 },
      { memberName: 'Alice', filePath: '/logs/alice-old.jsonl', mtimeMs: 100 },
      { memberName: 'Bob', filePath: '/logs/bob.jsonl', mtimeMs: 200 },
    ]);
    advisoryByFilePath.set('/logs/alice-new.jsonl', null);
    advisoryByFilePath.set('/logs/alice-old.jsonl', buildRetryingAdvisory('alice-old'));
    advisoryByFilePath.set('/logs/bob.jsonl', buildRetryingAdvisory('bob'));

    const advisories = await service.getMemberAdvisories('signal-ops', [
      buildMember('Alice'),
      buildMember('Bob'),
      buildMember('Charlie'),
    ]);

    expect(logsFinder.findRecentMemberLogFileRefsByMember).toHaveBeenCalledTimes(1);
    expect(logsFinder.findRecentMemberLogFileRefsByMember).toHaveBeenCalledWith(
      'signal-ops',
      ['Alice', 'Bob', 'Charlie'],
      expect.any(Number)
    );
    expect(logsFinder.findMemberLogs).not.toHaveBeenCalled();
    expect(advisories.get('Alice')?.message).toBe('retry:alice-old');
    expect(advisories.get('Bob')?.message).toBe('retry:bob');
    expect(advisories.has('Charlie')).toBe(false);

    await service.getMemberAdvisories('signal-ops', [
      buildMember('Alice'),
      buildMember('Bob'),
      buildMember('Charlie'),
    ]);
    expect(logsFinder.findRecentMemberLogFileRefsByMember).toHaveBeenCalledTimes(1);
  });

  it('falls back to per-member log scans when the batch log ref lookup fails', async () => {
    const { service, logsFinder } = createStubbedServiceHarness();
    logsFinder.findRecentMemberLogFileRefsByMember = vi.fn(async () => {
      throw new Error('batch unavailable');
    });

    const advisories = await service.getMemberAdvisories('signal-ops', [
      buildMember('Alice'),
      buildMember('Bob'),
    ]);

    expect(logsFinder.findRecentMemberLogFileRefsByMember).toHaveBeenCalledTimes(1);
    expect(logsFinder.findMemberLogs.mock.calls.map((call) => call[1])).toEqual(['Alice', 'Bob']);
    expect(Array.from(advisories.keys())).toEqual(['Alice', 'Bob']);
  });

  it('limits concurrent member advisory log scans', async () => {
    const { service, logsFinder } = createStubbedServiceHarness();
    let activeScans = 0;
    let maxActiveScans = 0;
    const activeGates: Deferred<void>[] = [];
    logsFinder.findMemberLogs.mockImplementation(async (_teamName: string, memberName: string) => {
      activeScans += 1;
      maxActiveScans = Math.max(maxActiveScans, activeScans);
      const gate = createDeferred<void>();
      activeGates.push(gate);
      await gate.promise;
      activeScans -= 1;
      return [{ filePath: `/logs/${memberName}.jsonl` }];
    });

    const request = service.getMemberAdvisories('signal-ops', [
      buildMember('Alice'),
      buildMember('Bob'),
      buildMember('Charlie'),
      buildMember('Tom'),
    ]);
    await vi.waitFor(() => {
      expect(logsFinder.findMemberLogs).toHaveBeenCalledTimes(2);
    });
    expect(maxActiveScans).toBe(2);

    activeGates.splice(0).forEach((gate) => gate.resolve());
    await vi.waitFor(() => {
      expect(logsFinder.findMemberLogs).toHaveBeenCalledTimes(4);
    });
    activeGates.splice(0).forEach((gate) => gate.resolve());
    await request;

    expect(maxActiveScans).toBeLessThanOrEqual(2);
  });

  it('caches null advisory batches and avoids repeated lookups within ttl', async () => {
    const { service, logsFinder } = createStubbedServiceHarness();
    logsFinder.findMemberLogs.mockResolvedValue([]);

    const first = await service.getMemberAdvisories('signal-ops', [buildMember('ghost')]);
    const second = await service.getMemberAdvisories('signal-ops', [buildMember('ghost')]);

    expect(first.size).toBe(0);
    expect(second.size).toBe(0);
    expect(logsFinder.findMemberLogs).toHaveBeenCalledTimes(1);
  });

  it('excludes removed members from batch signature and result', async () => {
    const { service, logsFinder } = createStubbedServiceHarness();

    const first = await service.getMemberAdvisories('signal-ops', [
      buildMember('Alice', Date.now()),
      buildMember('Bob'),
    ]);
    const second = await service.getMemberAdvisories('signal-ops', [buildMember('Bob')]);

    expect(Array.from(first.keys())).toEqual(['Bob']);
    expect(Array.from(second.keys())).toEqual(['Bob']);
    expect(logsFinder.findMemberLogs).toHaveBeenCalledTimes(1);
    expect(logsFinder.findMemberLogs).toHaveBeenCalledWith('signal-ops', 'Bob', expect.any(Number));
  });

  it('invalidates team batch cache when member set changes', async () => {
    const { service, logsFinder } = createStubbedServiceHarness();

    const first = await service.getMemberAdvisories('signal-ops', [buildMember('Alice')]);
    const second = await service.getMemberAdvisories('signal-ops', [
      buildMember('Alice'),
      buildMember('Bob'),
    ]);

    expect(Array.from(first.keys())).toEqual(['Alice']);
    expect(Array.from(second.keys())).toEqual(['Alice', 'Bob']);
    expect(logsFinder.findMemberLogs.mock.calls.map((call) => call[1])).toEqual(['Alice', 'Bob']);
  });
});
