import { writeFile } from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'en'), getPath: vi.fn(() => '/tmp'), isPackaged: false },
  Notification: Object.assign(vi.fn(), { isSupported: vi.fn(() => false) }),
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));
vi.mock('@main/services/team/TeamMembersMetaStore', () => ({
  TeamMembersMetaStore: vi.fn(() => ({ getMeta: vi.fn(async () => null) })),
}));
vi.mock('@main/services/team/TeamDataWorkerClient', () => ({
  getTeamDataWorkerClient: () => ({
    invalidateTeamConfig: vi.fn(),
    invalidateMemberRuntimeAdvisory: vi.fn(),
  }),
}));
const tails = vi.hoisted(() => ({ release: vi.fn(async () => ({ diagnostics: [] as string[] })) }));
vi.mock('@main/services/team/lifecycle/teamForceStopFlow', async (original) => ({
  ...(await original<typeof import('@main/services/team/lifecycle/teamForceStopFlow')>()),
  releaseSharedRuntimeResourcesAfterStop: tails.release,
}));
// Only the external process reaper is substituted. Store, shared Stop flow,
// route/IPC registration and publication queues execute their real code.
vi.mock('@main/services/team/lifecycle/teamLeadProcessTreeReap', () => ({
  reapCursorAgentLeadTreesForStoppedTeam: vi.fn(async () => ({ killedPids: [], diagnostics: [] })),
}));
import { registerTeamRoutes } from '@main/http/teams';
import { readTeamLaunchFreshness } from '@main/services/team/TeamLaunchFreshness';
import { createPersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';
import {
  TeamLaunchStateStore,
  withTeamLaunchStatePublicationLock,
} from '@main/services/team/TeamLaunchStateStore';
import { getTeamsBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import Fastify from 'fastify';

import {
  initializeTeamHandlers,
  registerTeamHandlers,
  removeTeamHandlers,
} from '../../../../src/main/ipc/teams';
import { TEAM_FORCE_STOP, TEAM_STOP } from '../../../../src/preload/constants/ipcChannels';

import type { HttpServices } from '@main/http';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const team = 'stop-publication-callers';
describe('Stop publication admission through real IPC/HTTP wrappers', () => {
  let temp: string;
  const store = new TeamLaunchStateStore();
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const ipc = {
    handle: (key: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(key, fn),
    removeHandler: (key: string) => handlers.delete(key),
  };
  const runtime = {
    stopTeam: vi.fn(async () => {}),
    getAliveTeams: () => [],
    isTeamAlive: () => true,
    getRuntimeState: async () => ({ state: 'stopped' }),
  };
  beforeEach(async () => {
    temp = await mkdtemp('/tmp/stop-publication-callers-');
    setClaudeBasePathOverride(temp);
    await mkdir(path.join(getTeamsBasePath(), team), { recursive: true });
    await store.beginLaunch(team, 'original', ['alice'], () => true);
    initializeTeamHandlers(
      { getTeamData: vi.fn(async () => ({ members: [] })) } as never,
      { runtime } as never
    );
    registerTeamHandlers(ipc as never);
    tails.release.mockReset();
    tails.release.mockResolvedValue({ diagnostics: [] });
    runtime.stopTeam.mockClear();
  });
  afterEach(async () => {
    removeTeamHandlers(ipc as never);
    handlers.clear();
    setClaudeBasePathOverride(null);
    await rm(temp, { recursive: true, force: true });
  });
  async function invoke(surface: string, force: boolean) {
    if (surface === 'ipc') {
      const result = await handlers.get(force ? TEAM_FORCE_STOP : TEAM_STOP)!({}, team);
      expect(result).toMatchObject({ success: true });
      return;
    }
    const app = Fastify();
    registerTeamRoutes(app, { teamApis: { runtime } } as unknown as HttpServices);
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/teams/${team}/${force ? 'force-stop' : 'stop'}`,
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  }
  it.each([
    ['ipc', false],
    ['ipc', true],
    ['http', false],
    ['http', true],
  ] as const)(
    '%s force=%s: an older cleanup tail preserves a finished successor and its heartbeats',
    async (surface, force) => {
      const entered = deferred(),
        release = deferred();
      tails.release.mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return { diagnostics: [] };
      });
      const stopping = invoke(surface, force);
      await entered.promise;
      expect(runtime.stopTeam).toHaveBeenCalledOnce();
      expect(await store.beginLaunch(team, 'successor', ['alice'], () => true)).toBe(true);
      const successor = createPersistedLaunchSnapshot({
        teamName: team,
        expectedMembers: ['alice'],
        launchPhase: 'finished',
        members: {},
      });
      expect(await store.write(team, successor, { runId: 'successor' })).toBe(true);
      release.resolve();
      await stopping;
      const reopened = new TeamLaunchStateStore();
      expect(await reopened.read(team)).toMatchObject({
        publicationRunId: 'successor',
        launchPhase: 'finished',
      });
      expect(await reopened.isStopped(team)).toBe(false);
      expect(await readTeamLaunchFreshness(team)).toMatchObject({
        kind: 'launch',
        runId: 'successor',
      });
      expect(
        JSON.parse(
          await readFile(path.join(getTeamsBasePath(), team, 'launch-summary.json'), 'utf8')
        ).publicationRunId
      ).toBe('successor');
      expect(await reopened.write(team, { ...successor, publicationRunId: 'successor' })).toBe(
        true
      );
    }
  );

  it('a newly requested shared Stop revokes an older begin waiting in the publication queue', async () => {
    const entered = deferred(),
      release = deferred();
    const held = withTeamLaunchStatePublicationLock(team, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const launch = store.beginLaunch(team, 'pending-before-stop', ['alice'], () => true);
    const stopping = invoke('ipc', false);
    // IPC admission is synchronous, before it waits for the held queue.
    release.resolve();
    await held;
    expect(await launch).toBe(false);
    await stopping;
    expect(await store.isStopped(team)).toBe(true);
    expect(await readTeamLaunchFreshness(team)).toMatchObject({
      kind: 'stop',
      stoppedRunId: 'original',
    });
  });

  it.each([
    ['ipc', false],
    ['ipc', true],
    ['http', false],
    ['http', true],
  ] as const)(
    '%s force=%s: logs unreadable admission and attempts scoped Stop without unscoped cleanup',
    async (surface, force) => {
      const freshnessPath = path.join(getTeamsBasePath(), team, 'launch-freshness.json');
      await writeFile(freshnessPath, '{corrupt');
      await invoke(surface, force);
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(
        surface === 'ipc' ? '[IPC:teams]' : '[HTTP:teams]',
        expect.stringContaining(`[${team}] Stopped-state admission failed:`)
      );
      vi.mocked(console.warn).mockClear();
      expect(runtime.stopTeam).toHaveBeenCalledOnce();
      expect(await readFile(freshnessPath, 'utf8')).toBe('{corrupt');
      expect((await store.read(team))?.publicationRunId).toBe('original');
    }
  );

  it('an older Stop cannot acquire a newer Stop admission by finishing late', async () => {
    const old = await store.beginStop(team);
    const newer = await store.beginStop(team);
    await store.markStopped(team, newer);
    const freshness = await readTeamLaunchFreshness(team);
    await new TeamLaunchStateStore().markStopped(team, old);
    expect(await readTeamLaunchFreshness(team)).toEqual(freshness);
  });
});
