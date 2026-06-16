import { afterEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const skipResponsesForOps = new Set<string>();
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
        worker.messages.push(message);
        const request = message as { id: string; op: string; payload?: { teamName?: string } };
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
  });

  it('deduplicates concurrent getTeamData calls for the same team', async () => {
    const { TeamDataWorkerClient } = await import(
      '../../../../src/main/services/team/TeamDataWorkerClient'
    );
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
    const { TeamDataWorkerClient } = await import(
      '../../../../src/main/services/team/TeamDataWorkerClient'
    );
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
    const { TeamDataWorkerClient } = await import(
      '../../../../src/main/services/team/TeamDataWorkerClient'
    );
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
    const { TeamDataWorkerClient } = await import(
      '../../../../src/main/services/team/TeamDataWorkerClient'
    );
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
    const { TeamDataWorkerClient } = await import(
      '../../../../src/main/services/team/TeamDataWorkerClient'
    );
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

  it('sends best-effort team config invalidation to the worker', async () => {
    const { TeamDataWorkerClient } = await import(
      '../../../../src/main/services/team/TeamDataWorkerClient'
    );
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

  it('deduplicates concurrent getMessagesPage calls with the same page key', async () => {
    const { TeamDataWorkerClient } = await import(
      '../../../../src/main/services/team/TeamDataWorkerClient'
    );
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
    const { TeamDataWorkerClient } = await import(
      '../../../../src/main/services/team/TeamDataWorkerClient'
    );
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

  it('sends best-effort message feed invalidation to the worker', async () => {
    const { TeamDataWorkerClient } = await import(
      '../../../../src/main/services/team/TeamDataWorkerClient'
    );
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

  it('clears in-flight getMessagesPage dedupe when invalidating message feed', async () => {
    const { TeamDataWorkerClient } = await import(
      '../../../../src/main/services/team/TeamDataWorkerClient'
    );
    const client = new TeamDataWorkerClient();

    const first = client.getMessagesPage('my-team', { cursor: null, limit: 50 });
    client.invalidateTeamMessageFeed('my-team');
    const second = client.getMessagesPage('my-team', { cursor: null, limit: 50 });

    await Promise.all([first, second]);

    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages.map((message) => (message as { op: string }).op)).toEqual([
      'getMessagesPage',
      'invalidateTeamMessageFeed',
      'getMessagesPage',
    ]);

    client.dispose();
  });

  it('clears in-flight getTeamData dedupe when invalidating team config', async () => {
    const { TeamDataWorkerClient } = await import(
      '../../../../src/main/services/team/TeamDataWorkerClient'
    );
    const client = new TeamDataWorkerClient();

    const first = client.getTeamData('my-team');
    client.invalidateTeamConfig('my-team');
    const second = client.getTeamData('my-team');

    await Promise.all([first, second]);

    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages.map((message) => (message as { op: string }).op)).toEqual([
      'getTeamData',
      'invalidateTeamConfig',
      'getTeamData',
    ]);

    client.dispose();
  });

  it('clears both thin and full getTeamData dedupe when invalidating team config', async () => {
    const { TeamDataWorkerClient } = await import(
      '../../../../src/main/services/team/TeamDataWorkerClient'
    );
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
      'getTeamData',
      'invalidateTeamConfig',
      'getTeamData',
      'getTeamData',
    ]);

    const payloads = hoisted.workers[0].messages.map(
      (message) => (message as { payload: unknown }).payload
    );
    expect(payloads).toEqual([
      { teamName: 'my-team' },
      { teamName: 'my-team', options: { includeMemberBranches: false } },
      { teamName: 'my-team' },
      { teamName: 'my-team' },
      { teamName: 'my-team', options: { includeMemberBranches: false } },
    ]);

    client.dispose();
  });

  it('rejects and clears thin and full getTeamData requests on dispose', async () => {
    const { TeamDataWorkerClient } = await import(
      '../../../../src/main/services/team/TeamDataWorkerClient'
    );
    hoisted.skipResponsesForOps.add('getTeamData');
    const client = new TeamDataWorkerClient();

    const full = client.getTeamData('my-team');
    const thin = client.getTeamData('my-team', { includeMemberBranches: false });

    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages).toHaveLength(2);

    client.dispose();

    await expect(full).rejects.toThrow('Client disposed');
    await expect(thin).rejects.toThrow('Client disposed');

    hoisted.skipResponsesForOps.delete('getTeamData');

    await client.getTeamData('my-team');
    expect(hoisted.workers).toHaveLength(2);
    expect(hoisted.workers[1].messages).toHaveLength(1);

    client.dispose();
  });

  it('does not spawn a worker only to send config invalidation', async () => {
    const { TeamDataWorkerClient } = await import(
      '../../../../src/main/services/team/TeamDataWorkerClient'
    );
    const client = new TeamDataWorkerClient();

    client.invalidateTeamConfig('my-team');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hoisted.workers).toHaveLength(0);
  });

  it('does not attach a timeout that can kill the worker for best-effort invalidation', async () => {
    vi.useFakeTimers();
    const { TeamDataWorkerClient } = await import(
      '../../../../src/main/services/team/TeamDataWorkerClient'
    );
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
