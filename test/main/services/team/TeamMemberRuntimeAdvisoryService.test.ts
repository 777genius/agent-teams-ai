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
    ['network_error', 'Fetch failed because the network connection timed out.'],
    ['provider_overloaded', 'Service unavailable: provider temporarily unavailable (503).'],
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
    await Promise.resolve();

    expect(logsFinder.findMemberLogs).toHaveBeenCalledTimes(1);

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
