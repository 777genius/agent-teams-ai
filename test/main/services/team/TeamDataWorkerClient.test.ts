import { afterEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const skipResponsesForOps = new Set<string>();
  const throwPostMessageForOps = new Set<string>();
  const workers: Array<{
    messages: unknown[];
    handlers: Map<string, (value: unknown) => void>;
    postMessage: (message: unknown) => void;
    on: (event: string, handler: (value: unknown) => void) => void;
    terminate: () => Promise<void>;
  }> = [];
  const createMockWorker = vi.fn().mockImplementation(() => {
    const worker = {
      messages: [] as unknown[],
      handlers: new Map<string, (value: unknown) => void>(),
      postMessage(message: unknown) {
        const request = message as { id: string; op: string; payload?: { teamName?: string } };
        if (throwPostMessageForOps.has(request.op)) {
          throw new Error(`post failed for ${request.op}`);
        }
        worker.messages.push(message);
        if (skipResponsesForOps.has(request.op)) return;
        queueMicrotask(() => {
          const handler = worker.handlers.get('message');
          if (!handler) return;
          handler({
            id: request.id,
            ok: true,
            result:
              request.op === 'getTeamData'
                ? { teamName: request.payload?.teamName, config: { name: 'Team' } }
                : request.op === 'getMessagesPage'
                  ? { messages: [], nextCursor: null, hasMore: false, feedRevision: 'rev-1' }
                  : null,
          });
        });
      },
      on(event: string, handler: (value: unknown) => void) {
        worker.handlers.set(event, handler);
      },
      terminate: vi.fn(async () => undefined),
    };
    workers.push(worker);
    return worker;
  });
  return {
    workers,
    createMockWorker,
    skipResponsesForOps,
    throwPostMessageForOps,
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

vi.mock('node:worker_threads', () => ({
  Worker: hoisted.createMockWorker,
  default: {
    Worker: hoisted.createMockWorker,
  },
}));

describe('TeamDataWorkerClient', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    hoisted.workers.length = 0;
    hoisted.skipResponsesForOps.clear();
    hoisted.throwPostMessageForOps.clear();
  });

  it('deduplicates concurrent getTeamData calls for the same team', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    const client = new TeamDataWorkerClient();

    const [first, second] = await Promise.all([
      client.getTeamData('my-team'),
      client.getTeamData('my-team'),
    ]);

    expect(first).toEqual(second);
    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages).toHaveLength(1);
    expect(hoisted.workers[0].messages[0]).toMatchObject({
      op: 'getTeamData',
      payload: { teamName: 'my-team' },
    });

    client.dispose();
  });

  it('does not deduplicate thin and full getTeamData calls together', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    const client = new TeamDataWorkerClient();

    await Promise.all([
      client.getTeamData('my-team'),
      client.getTeamData('my-team', { includeMemberBranches: false }),
    ]);

    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages).toHaveLength(2);
    expect(hoisted.workers[0].messages[0]).toMatchObject({
      op: 'getTeamData',
      payload: { teamName: 'my-team' },
    });
    expect(hoisted.workers[0].messages[0]).not.toMatchObject({
      payload: { options: expect.anything() },
    });
    expect(hoisted.workers[0].messages[1]).toMatchObject({
      op: 'getTeamData',
      payload: { teamName: 'my-team', options: { includeMemberBranches: false } },
    });

    client.dispose();
  });

  it('deduplicates explicit full getTeamData options with the default request', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    const client = new TeamDataWorkerClient();

    await Promise.all([
      client.getTeamData('my-team'),
      client.getTeamData('my-team', { includeMemberBranches: true }),
    ]);

    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages).toHaveLength(1);
    expect(hoisted.workers[0].messages[0]).toMatchObject({
      op: 'getTeamData',
      payload: { teamName: 'my-team' },
    });
    expect(hoisted.workers[0].messages[0]).not.toMatchObject({
      payload: { options: expect.anything() },
    });

    client.dispose();
  });

  it('deduplicates concurrent thin getTeamData calls for the same team', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    const client = new TeamDataWorkerClient();

    const [first, second] = await Promise.all([
      client.getTeamData('my-team', { includeMemberBranches: false }),
      client.getTeamData('my-team', { includeMemberBranches: false }),
    ]);

    expect(first).toEqual(second);
    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages).toHaveLength(1);
    expect(hoisted.workers[0].messages[0]).toMatchObject({
      op: 'getTeamData',
      payload: { teamName: 'my-team', options: { includeMemberBranches: false } },
    });

    client.dispose();
  });

  it('does not queue warmup behind an already running worker', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    const client = new TeamDataWorkerClient();

    await client.getTeamData('my-team');
    await client.prewarm();

    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages).toHaveLength(1);
    expect(hoisted.workers[0].messages[0]).toMatchObject({
      op: 'getTeamData',
      payload: { teamName: 'my-team' },
    });

    client.dispose();
  });

  it('serializes distinct heavy requests before posting them to the worker', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    hoisted.skipResponsesForOps.add('getTeamData');
    const client = new TeamDataWorkerClient();

    const first = client.getTeamData('my-team');
    const second = client.getMessagesPage('my-team', { cursor: null, limit: 50 });

    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages).toHaveLength(1);
    expect(hoisted.workers[0].messages[0]).toMatchObject({
      op: 'getTeamData',
      payload: { teamName: 'my-team' },
    });

    const firstRequest = hoisted.workers[0].messages[0] as { id: string };
    hoisted.workers[0].handlers.get('message')?.({
      id: firstRequest.id,
      ok: true,
      result: { teamName: 'my-team', config: { name: 'Team' } },
      diag: { op: 'getTeamData', totalMs: 1 },
    });

    await first;
    expect(hoisted.workers[0].messages).toHaveLength(2);
    expect(hoisted.workers[0].messages[1]).toMatchObject({
      op: 'getMessagesPage',
      payload: { teamName: 'my-team', options: { cursor: null, limit: 50 } },
    });
    await second;

    client.dispose();
  });

  it('sends best-effort team config invalidation to the worker', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    const client = new TeamDataWorkerClient();
    await client.getTeamData('my-team');
    hoisted.workers[0].messages.length = 0;

    client.invalidateTeamConfig('my-team');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages).toHaveLength(1);
    expect(hoisted.workers[0].messages[0]).toMatchObject({
      op: 'invalidateTeamConfig',
      payload: { teamName: 'my-team' },
    });

    client.dispose();
  });

  // The UI reads advisories through this worker instance, so the launch-start
  // reset has to reach it as a run-stamped payload, not a plain invalidation.
  it('sends a run-stamped advisory reset to the worker', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    const client = new TeamDataWorkerClient();
    await client.getTeamData('my-team');
    hoisted.workers[0].messages.length = 0;

    client.resetMemberRuntimeAdvisoriesForNewRun('my-team', 1_724_780_000_000);
    client.resetMemberRuntimeAdvisoriesForNewRun('../escape', 1_724_780_000_000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hoisted.workers[0].messages).toHaveLength(1);
    expect(hoisted.workers[0].messages[0]).toMatchObject({
      op: 'invalidateMemberRuntimeAdvisory',
      payload: { teamName: 'my-team', runStartedAtMs: 1_724_780_000_000 },
    });
    expect(hoisted.workers[0].messages[0]).not.toHaveProperty('payload.memberName');

    client.dispose();
  });

  // Every respawn builds a fresh in-memory TeamDataService, so the worker's run
  // scope starts empty. Without a replay the new worker re-derives the dead
  // run's advisories and the member card resurrects the previous run's error.
  it('replays the advisory run-scope floor into a respawned worker before the first read', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    const client = new TeamDataWorkerClient();
    await client.getTeamData('my-team');

    client.resetMemberRuntimeAdvisoriesForNewRun('my-team', 1_724_780_000_000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A clean exit is not fatal, so the next request respawns immediately.
    hoisted.workers[0].handlers.get('exit')?.(0);

    await client.getTeamData('my-team');

    expect(hoisted.workers).toHaveLength(2);
    expect(hoisted.workers[1].messages).toHaveLength(2);
    expect(hoisted.workers[1].messages[0]).toMatchObject({
      op: 'invalidateMemberRuntimeAdvisory',
      payload: { teamName: 'my-team', runStartedAtMs: 1_724_780_000_000 },
    });
    expect(hoisted.workers[1].messages[1]).toMatchObject({
      op: 'getTeamData',
      payload: { teamName: 'my-team' },
    });

    client.dispose();
  });

  it('defers an advisory reset issued with no live worker and replays it on the next spawn', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    const client = new TeamDataWorkerClient();

    client.resetMemberRuntimeAdvisoriesForNewRun('my-team', 1_724_780_000_000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hoisted.workers).toHaveLength(0);
    expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain(
      'advisory run-scope reset not delivered team=my-team runStartedAtMs=1724780000000 liveWorker=false replayOnNextWorkerSpawn=true'
    );
    vi.mocked(console.warn).mockClear();

    await client.getTeamData('my-team');

    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages[0]).toMatchObject({
      op: 'invalidateMemberRuntimeAdvisory',
      payload: { teamName: 'my-team', runStartedAtMs: 1_724_780_000_000 },
    });

    client.dispose();
  });

  it('replays only the latest floor per team and does not replay a rejected team name', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    const client = new TeamDataWorkerClient();

    client.resetMemberRuntimeAdvisoriesForNewRun('my-team', 1_724_780_000_000);
    client.resetMemberRuntimeAdvisoriesForNewRun('my-team', 1_724_781_000_000);
    client.resetMemberRuntimeAdvisoriesForNewRun('../escape', 1_724_780_000_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    vi.mocked(console.warn).mockClear();

    await client.getTeamData('my-team');

    expect(hoisted.workers[0].messages).toHaveLength(2);
    expect(hoisted.workers[0].messages[0]).toMatchObject({
      op: 'invalidateMemberRuntimeAdvisory',
      payload: { teamName: 'my-team', runStartedAtMs: 1_724_781_000_000 },
    });

    client.dispose();
  });

  it('deduplicates concurrent getMessagesPage calls with the same page key', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    const client = new TeamDataWorkerClient();

    const [first, second] = await Promise.all([
      client.getMessagesPage('my-team', { cursor: null, limit: 50 }),
      client.getMessagesPage('my-team', { cursor: null, limit: 50 }),
    ]);

    expect(first).toEqual(second);
    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages).toHaveLength(1);
    expect(hoisted.workers[0].messages[0]).toMatchObject({
      op: 'getMessagesPage',
      payload: { teamName: 'my-team', options: { cursor: null, limit: 50 } },
    });

    client.dispose();
  });

  it('does not deduplicate getMessagesPage calls with different live overlays', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    const client = new TeamDataWorkerClient();

    await Promise.all([
      client.getMessagesPage('my-team', {
        cursor: null,
        limit: 50,
        liveMessages: [
          {
            from: 'team-lead',
            text: 'first',
            timestamp: '2026-02-23T10:00:00.000Z',
            read: true,
            source: 'lead_process',
            messageId: 'live-1',
          },
        ],
      }),
      client.getMessagesPage('my-team', {
        cursor: null,
        limit: 50,
        liveMessages: [
          {
            from: 'team-lead',
            text: 'second',
            timestamp: '2026-02-23T10:00:01.000Z',
            read: true,
            source: 'lead_process',
            messageId: 'live-2',
          },
        ],
      }),
    ]);

    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages).toHaveLength(2);
    expect(hoisted.workers[0].messages[0]).toMatchObject({
      op: 'getMessagesPage',
      payload: {
        teamName: 'my-team',
        options: {
          cursor: null,
          limit: 50,
          liveMessages: [expect.objectContaining({ messageId: 'live-1' })],
        },
      },
    });
    expect(hoisted.workers[0].messages[1]).toMatchObject({
      op: 'getMessagesPage',
      payload: {
        teamName: 'my-team',
        options: {
          cursor: null,
          limit: 50,
          liveMessages: [expect.objectContaining({ messageId: 'live-2' })],
        },
      },
    });

    client.dispose();
  });

  it('does not deduplicate live overlays that differ only by text content', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    const client = new TeamDataWorkerClient();

    await Promise.all([
      client.getMessagesPage('my-team', {
        cursor: null,
        limit: 50,
        liveMessages: [
          {
            from: 'team-lead',
            text: 'same identity first text',
            timestamp: '2026-02-23T10:00:00.000Z',
            read: true,
            source: 'lead_process',
            messageId: 'live-same',
          },
        ],
      }),
      client.getMessagesPage('my-team', {
        cursor: null,
        limit: 50,
        liveMessages: [
          {
            from: 'team-lead',
            text: 'same identity second text',
            timestamp: '2026-02-23T10:00:00.000Z',
            read: true,
            source: 'lead_process',
            messageId: 'live-same',
          },
        ],
      }),
    ]);

    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages).toHaveLength(2);

    client.dispose();
  });

  it('does not deduplicate live overlays that differ only by routing metadata', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    const client = new TeamDataWorkerClient();

    await Promise.all([
      client.getMessagesPage('my-team', {
        cursor: null,
        limit: 50,
        liveMessages: [
          {
            from: 'team-lead',
            to: 'member-a',
            text: 'same text',
            timestamp: '2026-02-23T10:00:00.000Z',
            read: true,
            source: 'lead_process',
            messageId: 'live-same',
            leadSessionId: 'lead-session-a',
            conversationId: 'conversation-a',
            replyToConversationId: 'reply-a',
          },
        ],
      }),
      client.getMessagesPage('my-team', {
        cursor: null,
        limit: 50,
        liveMessages: [
          {
            from: 'team-lead',
            to: 'member-b',
            text: 'same text',
            timestamp: '2026-02-23T10:00:00.000Z',
            read: true,
            source: 'lead_process',
            messageId: 'live-same',
            leadSessionId: 'lead-session-b',
            conversationId: 'conversation-b',
            replyToConversationId: 'reply-b',
          },
        ],
      }),
    ]);

    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages).toHaveLength(2);

    client.dispose();
  });

  it('caps live overlay payloads before queueing worker message-page calls', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    const client = new TeamDataWorkerClient();
    const liveMessages = Array.from({ length: 205 }, (_, index) => ({
      from: 'team-lead',
      text: `live ${index}`,
      timestamp: new Date(Date.UTC(2026, 1, 23, 10, 0, index)).toISOString(),
      read: true,
      source: 'lead_process' as const,
      messageId: `live-${index}`,
    }));

    await client.getMessagesPage('my-team', {
      cursor: null,
      limit: 50,
      liveMessages,
    });

    const postedMessage = hoisted.workers[0].messages[0] as {
      payload?: { options?: { liveMessages?: { messageId?: string }[] } };
    };
    const workerOptions = postedMessage.payload?.options;
    if (!workerOptions) {
      throw new Error('Expected worker message-page options');
    }
    expect(workerOptions.liveMessages).toHaveLength(200);
    expect(workerOptions.liveMessages?.map((message) => message.messageId)).toContain('live-204');
    expect(workerOptions.liveMessages?.map((message) => message.messageId)).toContain('live-5');
    expect(workerOptions.liveMessages?.map((message) => message.messageId)).not.toContain('live-4');

    client.dispose();
  });

  it('sends best-effort message feed invalidation to the worker', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    const client = new TeamDataWorkerClient();
    await client.getTeamData('my-team');
    hoisted.workers[0].messages.length = 0;

    client.invalidateTeamMessageFeed('my-team');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages).toHaveLength(1);
    expect(hoisted.workers[0].messages[0]).toMatchObject({
      op: 'invalidateTeamMessageFeed',
      payload: { teamName: 'my-team' },
    });

    client.dispose();
  });

  it('keeps in-flight getMessagesPage dedupe when invalidating message feed', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    const client = new TeamDataWorkerClient();

    const first = client.getMessagesPage('my-team', { cursor: null, limit: 50 });
    client.invalidateTeamMessageFeed('my-team');
    const second = client.getMessagesPage('my-team', { cursor: null, limit: 50 });

    await Promise.all([first, second]);

    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages.map((message) => (message as { op: string }).op)).toEqual([
      'getMessagesPage',
      'invalidateTeamMessageFeed',
    ]);

    client.dispose();
  });

  it('keeps in-flight getTeamData dedupe when invalidating team config', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    const client = new TeamDataWorkerClient();

    const first = client.getTeamData('my-team');
    client.invalidateTeamConfig('my-team');
    const second = client.getTeamData('my-team');

    await Promise.all([first, second]);

    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages.map((message) => (message as { op: string }).op)).toEqual([
      'getTeamData',
      'invalidateTeamConfig',
    ]);

    client.dispose();
  });

  it('keeps both thin and full getTeamData dedupe when invalidating team config', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    const client = new TeamDataWorkerClient();

    const firstFull = client.getTeamData('my-team');
    const firstThin = client.getTeamData('my-team', { includeMemberBranches: false });
    client.invalidateTeamConfig('my-team');
    const secondFull = client.getTeamData('my-team');
    const secondThin = client.getTeamData('my-team', { includeMemberBranches: false });

    await Promise.all([firstFull, firstThin, secondFull, secondThin]);

    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages.map((message) => (message as { op: string }).op)).toEqual([
      'getTeamData',
      'invalidateTeamConfig',
      'getTeamData',
    ]);

    const payloads = hoisted.workers[0].messages.map(
      (message) => (message as { payload: unknown }).payload
    );
    expect(payloads).toEqual([
      { teamName: 'my-team' },
      { teamName: 'my-team' },
      { teamName: 'my-team', options: { includeMemberBranches: false } },
    ]);

    client.dispose();
  });

  it('deduplicates concurrent getMemberActivityMeta calls for the same team', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    const client = new TeamDataWorkerClient();

    const [first, second] = await Promise.all([
      client.getMemberActivityMeta('my-team'),
      client.getMemberActivityMeta('my-team'),
    ]);

    expect(first).toEqual(second);
    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages).toHaveLength(1);
    expect(hoisted.workers[0].messages[0]).toMatchObject({
      op: 'getMemberActivityMeta',
      payload: { teamName: 'my-team' },
    });

    client.dispose();
  });

  it('rejects and clears thin and full getTeamData requests on dispose', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    hoisted.skipResponsesForOps.add('getTeamData');
    const client = new TeamDataWorkerClient();

    const full = client.getTeamData('my-team');
    const thin = client.getTeamData('my-team', { includeMemberBranches: false });

    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages).toHaveLength(1);

    client.dispose();

    await expect(full).rejects.toThrow('Client disposed');
    await expect(thin).rejects.toThrow('Client disposed');

    hoisted.skipResponsesForOps.delete('getTeamData');

    await client.getTeamData('my-team');
    expect(hoisted.workers).toHaveLength(2);
    expect(hoisted.workers[1].messages).toHaveLength(1);

    client.dispose();
  });

  it('does not restart the worker immediately after a fatal worker OOM', async () => {
    vi.useFakeTimers();
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    hoisted.skipResponsesForOps.add('getTeamData');
    const client = new TeamDataWorkerClient();

    const first = client.getTeamData('my-team');
    expect(hoisted.workers).toHaveLength(1);

    const fatal = Object.assign(
      new Error('Worker terminated due to reaching memory limit: JS heap out of memory'),
      { code: 'ERR_WORKER_OUT_OF_MEMORY' }
    );
    hoisted.workers[0].handlers.get('error')?.(fatal);

    await expect(first).rejects.toThrow('Worker terminated due to reaching memory limit');

    const second = client.getTeamData('my-team');
    await expect(second).rejects.toThrow('Team data worker recovering after fatal failure');
    expect(hoisted.workers).toHaveLength(1);

    hoisted.skipResponsesForOps.delete('getTeamData');
    await vi.advanceTimersByTimeAsync(30_001);
    await client.getTeamData('my-team');
    expect(hoisted.workers).toHaveLength(2);

    client.dispose();
  });

  it('classifies worker exits as fatal only for non-zero exit codes', async () => {
    const { isTeamDataWorkerFatalError } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');

    expect(isTeamDataWorkerFatalError(new Error('Worker exited with code 0'))).toBe(false);
    expect(isTeamDataWorkerFatalError(new Error('Worker exited with code 1'))).toBe(true);
    expect(isTeamDataWorkerFatalError(new Error('Worker exited with code 9'))).toBe(true);
  });

  it('clears pending state when worker postMessage throws synchronously', async () => {
    vi.useFakeTimers();
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    hoisted.throwPostMessageForOps.add('getTeamData');
    const client = new TeamDataWorkerClient();

    await expect(client.getTeamData('my-team')).rejects.toThrow('post failed for getTeamData');
    expect(hoisted.workers).toHaveLength(1);

    hoisted.throwPostMessageForOps.delete('getTeamData');
    await vi.advanceTimersByTimeAsync(30_001);
    await client.getTeamData('my-team');

    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages).toHaveLength(1);

    client.dispose();
  });

  it('does not spawn a worker only to send config invalidation', async () => {
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    const client = new TeamDataWorkerClient();

    client.invalidateTeamConfig('my-team');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hoisted.workers).toHaveLength(0);
  });

  it('does not attach a timeout that can kill the worker for best-effort invalidation', async () => {
    vi.useFakeTimers();
    const { TeamDataWorkerClient } =
      await import('../../../../src/main/services/team/TeamDataWorkerClient');
    const client = new TeamDataWorkerClient();
    await client.getTeamData('my-team');
    hoisted.workers[0].messages.length = 0;
    hoisted.skipResponsesForOps.add('invalidateTeamMessageFeed');

    client.invalidateTeamMessageFeed('my-team');
    await vi.advanceTimersByTimeAsync(31_000);

    expect(hoisted.workers[0].messages).toHaveLength(1);
    expect(hoisted.workers[0].terminate).not.toHaveBeenCalled();

    client.dispose();
  });
});
