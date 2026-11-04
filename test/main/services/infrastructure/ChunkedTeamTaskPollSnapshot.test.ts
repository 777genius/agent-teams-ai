import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CrossPlatformFileChangeSource } from '../../../../src/main/services/infrastructure/CrossPlatformFileChangeSource';
import {
  ChunkedTeamTaskPollSnapshot,
  collectTasksPollSnapshot,
  collectTeamsPollSnapshot,
} from '../../../../src/main/services/infrastructure/TeamTaskPollSnapshot';

let root = '';

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'chunked-task-poll-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

async function writeFile(team: string, name = 'task.json', data = '{}'): Promise<void> {
  const file = path.join(root, team, name);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, data);
}

function createHarness(kind: 'tasks' | 'teams', priority: { current: ReadonlySet<string> | null }) {
  const snapshots = new ChunkedTeamTaskPollSnapshot(
    root,
    kind === 'tasks' ? collectTasksPollSnapshot : collectTeamsPollSnapshot,
    2
  );
  const events: { type: 'change' | 'rename'; path: string }[] = [];
  const source = new CrossPlatformFileChangeSource({
    name: `test-${kind}`,
    pollIntervalMs: 60_000,
    collectPollSnapshot: () => snapshots.snapshot(source.isPollingPrimed, priority.current),
    emitPolledChange: (type, relativePath) => events.push({ type, path: relativePath }),
    isOwnerActive: () => true,
    isWatchLimitError: () => false,
    requestRetry: () => {},
  });
  return { source, events };
}

describe('chunked fallback team and task snapshots', () => {
  it.each(['tasks', 'teams'] as const)(
    'polls live %s on every tick while historical changes eventually arrive',
    async (kind) => {
      for (let index = 0; index < 6; index += 1) {
        await writeFile(`team-${index}`, kind === 'teams' ? 'config.json' : 'task.json');
      }
      const priority = { current: new Set(['team-5']) };
      const { source, events } = createHarness(kind, priority);
      try {
        source.startPolling();
        await vi.waitFor(() => expect(source.isPollingPrimed).toBe(true));
        const file = kind === 'teams' ? 'config.json' : 'task.json';
        await writeFile('team-5', file, '{"updated":true}');
        await source.pollOnce();
        expect(events).toEqual([{ type: 'change', path: `team-5/${file}` }]);

        await writeFile('team-4', file, '{"updated":true}');
        await source.pollOnce();
        expect(events.map((event) => event.path)).toEqual([`team-5/${file}`]);
        await source.pollOnce();
        expect(events.map((event) => event.path)).toEqual([
          `team-5/${file}`,
          `team-4/${file}`,
        ]);
      } finally {
        source.stop();
      }
    }
  );

  it('emits a historical deletion once after all slices, without false intermediate deletions', async () => {
    for (let index = 0; index < 6; index += 1) await writeFile(`team-${index}`);
    const { source, events } = createHarness('tasks', { current: new Set() });
    try {
      source.startPolling();
      await vi.waitFor(() => expect(source.isPollingPrimed).toBe(true));
      await fsp.unlink(path.join(root, 'team-2', 'task.json'));
      await source.pollOnce();
      await source.pollOnce();
      expect(events).toEqual([]);
      await source.pollOnce();
      expect(events).toEqual([{ type: 'rename', path: 'team-2/task.json' }]);
      for (let index = 0; index < 3; index += 1) await source.pollOnce();
      expect(events).toHaveLength(1);
    } finally {
      source.stop();
    }
  });

  it('detects a newly live team during an unfinished historical cycle', async () => {
    for (let index = 0; index < 6; index += 1) await writeFile(`team-${index}`);
    const priority: { current: ReadonlySet<string> | null } = { current: new Set() };
    const { source, events } = createHarness('tasks', priority);
    try {
      source.startPolling();
      await vi.waitFor(() => expect(source.isPollingPrimed).toBe(true));
      await source.pollOnce();
      await writeFile('new-team');
      priority.current = new Set(['new-team']);
      await source.pollOnce();
      expect(events).toContainEqual({ type: 'rename', path: 'new-team/task.json' });
    } finally {
      source.stop();
    }
  });

  it('re-primes a complete baseline when fallback is restarted', async () => {
    for (let index = 0; index < 6; index += 1) await writeFile(`team-${index}`);
    const { source, events } = createHarness('tasks', { current: new Set() });
    try {
      source.startPolling();
      await vi.waitFor(() => expect(source.isPollingPrimed).toBe(true));
      await source.pollOnce();
      source.stop();
      await writeFile('new-team');
      source.startPolling();
      await vi.waitFor(() => expect(source.isPollingPrimed).toBe(true));
      expect(events).toEqual([]);
    } finally {
      source.stop();
    }
  });

  it('preserves all-team polling when no live scope provider is registered', async () => {
    for (let index = 0; index < 6; index += 1) await writeFile(`team-${index}`);
    const { source, events } = createHarness('tasks', { current: null });
    try {
      source.startPolling();
      await vi.waitFor(() => expect(source.isPollingPrimed).toBe(true));
      await writeFile('team-5', 'task.json', '{"updated":true}');
      await source.pollOnce();
      expect(events).toContainEqual({ type: 'change', path: 'team-5/task.json' });
    } finally {
      source.stop();
    }
  });

  it('retries a failed slice before advancing its cursor', async () => {
    for (let index = 0; index < 5; index += 1) await writeFile(`team-${index}`);
    let failNext = false;
    const requested: string[][] = [];
    const snapshots = new ChunkedTeamTaskPollSnapshot(
      root,
      async (dir, names) => {
        requested.push([...names ?? []]);
        if (failNext) {
          failNext = false;
          throw new Error('temporary failure');
        }
        return collectTasksPollSnapshot(dir, names);
      },
      2
    );
    await snapshots.snapshot(false, new Set());
    await snapshots.snapshot(true, new Set());
    failNext = true;
    await expect(snapshots.snapshot(true, new Set())).rejects.toThrow('temporary failure');
    await snapshots.snapshot(true, null);
    expect(requested.at(-2)).toEqual(['team-2', 'team-3']);
    expect(requested.at(-1)).toEqual(['team-2', 'team-3']);
  });
});
