import { describe, expect, it, vi } from 'vitest';

import {
  createProjectLaunchProbe,
  isProjectCopyLaunching,
  launchInProjectContext,
  TeamProjectContextCreateCoordinator,
  trackProjectCopyLaunch,
} from '../../../src/features/team-project-context/main';
import { assertReadyProjectCopy } from '../../../src/features/team-project-context/main/projectCopyRouting';

import type { ProjectContextProgressMapper } from '../../../src/features/team-project-context/main';
import type {
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
} from '../../../src/shared/types';

const progress = (state: TeamProvisioningProgress['state']): TeamProvisioningProgress => ({
  runId: 'run-1',
  teamName: 'ptc-copy',
  state,
  message: state,
  startedAt: '2026-11-21T00:00:00.000Z',
  updatedAt: '2026-11-21T00:00:01.000Z',
});

/** A promise and the function that settles it, to hold a step of a launch open. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

describe('launches of project copies', () => {
  // Window at the end: the provisioning run is gone once the run reports ready, but the copy is
  // confirmed asynchronously; until then a pending copy must still read as being launched.
  it('ends a launch only after the confirmed ready progress was delivered', async () => {
    const launch = trackProjectCopyLaunch('ptc-end-window');
    const confirmation = gate();
    const delivered: string[] = [];
    const confirmingMapper: ProjectContextProgressMapper = (next, deliver) => {
      if (next.state !== 'ready') return deliver(next);
      void confirmation.opened.then(() => deliver(next));
    };
    const report = launch.settleOn(confirmingMapper);

    report(progress('validating'), (next) => delivered.push(next.state));
    expect(isProjectCopyLaunching('ptc-end-window')).toBe(true);
    report(progress('ready'), (next) => delivered.push(next.state));
    launch.watchRun(() => false);
    expect(isProjectCopyLaunching('ptc-end-window')).toBe(true);
    confirmation.open();
    await confirmation.opened;
    await Promise.resolve();
    expect(delivered).toEqual(['validating', 'ready']);
    expect(isProjectCopyLaunching('ptc-end-window')).toBe(false);
  });

  // Window at the start: the copy is reserved and materialized before its provisioning run exists.
  it('counts a created copy as launched from its reservation until its run failed', async () => {
    const materializing = gate();
    const reports: ((next: TeamProvisioningProgress) => void)[] = [];
    const seen: boolean[] = [];
    const address = { logicalTeamName: 'team', projectPath: '/work/a' };
    const reserved = {
      ...address,
      executionTeamName: 'ptc-start-window',
      mode: 'per_project' as const,
      workContextId: 'context-1',
      state: 'reserved' as const,
    };
    const coordinator = new TeamProjectContextCreateCoordinator({
      createLogicalDraft: () => Promise.resolve(),
      withLogicalTeamLock: (_team, operation) => operation(),
      reserve: () => Promise.resolve(reserved),
      releaseUnusedReservation: () => Promise.resolve(false),
      assertOtherContextsStopped: () => Promise.resolve(),
      ensurePhysicalDraft: async () => {
        seen.push(isProjectCopyLaunching('ptc-start-window'));
        await materializing.opened;
        return reserved;
      },
      createNativeTeam: (_request, report) => {
        reports.push(report);
        return Promise.resolve({ runId: 'run-1' });
      },
      isProvisioningLaunchActive: () => true,
      confirmReady: () => Promise.resolve(reserved),
    });
    const created = coordinator.create(
      { teamName: 'team', cwd: '/work/a', projectContextMode: 'per_project', members: [] },
      () => undefined
    );
    await Promise.resolve();
    await Promise.resolve();
    materializing.open();
    await created;
    expect(seen).toEqual([true]);
    expect(isProjectCopyLaunching('ptc-start-window')).toBe(true);
    reports[0](progress('failed'));
    expect(isProjectCopyLaunching('ptc-start-window')).toBe(false);
  });

  it('ends a launch that started no run of its own, and one whose launch threw', async () => {
    const request = { teamName: 'team', cwd: '/work/a' } as TeamLaunchRequest;
    const portsFor = (copy: string) => ({
      getSavedRequest: () => Promise.resolve(null),
      prepare: () =>
        Promise.resolve({
          request: { ...request, teamName: copy },
          mapProgress: ((next, deliver) => deliver(next)) as ProjectContextProgressMapper,
          launch: trackProjectCopyLaunch(copy),
        }),
      rememberRunIdentity: () => undefined,
      isProvisioningLaunchActive: () => true,
    });
    await launchInProjectContext(request, portsFor('ptc-already-running'), {
      invoke: () =>
        Promise.resolve({
          runId: 'run-0',
          launchStatus: 'already_running',
          alreadyRunning: true,
        } as TeamLaunchResponse),
      started: (result) => result,
    });
    expect(isProjectCopyLaunching('ptc-already-running')).toBe(false);
    await expect(
      launchInProjectContext(request, portsFor('ptc-threw'), {
        invoke: () => Promise.reject(new Error('provider refused')),
        started: () => null,
      })
    ).rejects.toThrow('provider refused');
    expect(isProjectCopyLaunching('ptc-threw')).toBe(false);
  });

  it('reads a pending copy as being launched while its launch is tracked or its team runs', () => {
    const alive = new Set(['ptc-alive']);
    const probe = createProjectLaunchProbe((name) => alive.has(name));
    const launch = trackProjectCopyLaunch('ptc-tracked');
    expect([probe('ptc-tracked'), probe('ptc-alive'), probe('ptc-failed')]).toEqual([
      true,
      true,
      false,
    ]);
    launch.end();
    launch.end();
    expect(probe('ptc-tracked')).toBe(false);
  });

  it('clears a launch with no terminal progress once its provisioning run disappears', async () => {
    let active = true;
    const copy = 'ptc-silent-cancellation';
    const request = { teamName: 'team', cwd: '/sandbox/a' } as TeamLaunchRequest;
    const ports = {
      getSavedRequest: () => Promise.resolve(null),
      prepare: () => Promise.resolve({
        request: { ...request, teamName: copy },
        mapProgress: ((next, deliver) => deliver(next)) as ProjectContextProgressMapper,
        launch: trackProjectCopyLaunch(copy),
      }),
      isProvisioningLaunchActive: () => active,
      rememberRunIdentity: () => undefined,
    };
    const launcher = { invoke: () => Promise.resolve({ runId: 'run' }), started: (result: TeamLaunchResponse) => result };
    const context = { id: 'context', projectKey: '/sandbox/a', executionTeamName: copy, state: 'reserved' as const, projectPath: '/sandbox/a' };
    const board = () => assertReadyProjectCopy({ isLaunching: createProjectLaunchProbe() }, 'team', '/sandbox/a', context);
    await launchInProjectContext(request, ports, launcher);
    expect(isProjectCopyLaunching(copy)).toBe(true);
    expect(board).toThrow(expect.objectContaining({ code: 'PROJECT_LAUNCH_PENDING' }));
    active = false;
    expect(isProjectCopyLaunching(copy)).toBe(false);
    expect(board).toThrow(expect.objectContaining({ code: 'PROJECT_LAUNCH_INCOMPLETE' }));
    active = true;
    await launchInProjectContext(request, ports, launcher);
    expect(isProjectCopyLaunching(copy)).toBe(true);
    active = false;
    expect(isProjectCopyLaunching(copy)).toBe(false);
  });

  it('keeps independent overlapping launches and ends one when delivery throws', () => {
    const first = trackProjectCopyLaunch('ptc-overlap');
    const second = trackProjectCopyLaunch('ptc-overlap');
    const report = first.settleOn((next, deliver) => deliver(next));
    expect(() => report(progress('failed'), () => { throw new Error('delivery failed'); }))
      .toThrow('delivery failed');
    expect(isProjectCopyLaunching('ptc-overlap')).toBe(true);
    second.end();
    expect(isProjectCopyLaunching('ptc-overlap')).toBe(false);
  });

  it('reclaims a stopped launch even when no caller checks its board', () => {
    vi.useFakeTimers();
    try {
      let active = true;
      const launch = trackProjectCopyLaunch('ptc-no-readers');
      launch.watchRun(() => active);
      vi.advanceTimersByTime(30_000);
      expect(vi.getTimerCount()).toBe(1);
      active = false;
      vi.advanceTimersByTime(30_000);
      expect(vi.getTimerCount()).toBe(0);
      expect(isProjectCopyLaunching('ptc-no-readers')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
