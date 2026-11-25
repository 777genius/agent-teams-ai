import { join } from 'node:path';

import { HostSmartScheduleRuntimeAdapter } from '@features/agent-backend/main/adapters/output/HostSmartScheduleRuntimeAdapter';
import { captureHostProjectScheduleContext } from '@features/agent-backend/main/application/captureHostProjectScheduleContext';
import { captureHostScheduleTarget, restoreHostScheduleTarget } from '@features/agent-backend/main/application/captureHostScheduleTarget';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SmartScheduleDispatcher,
  type SmartScheduleRuntimePort,
} from '../../../../src/main/services/schedule/SmartScheduleDispatcher';
import { capturedHostTeamReadsFixture } from '../../../features/agent-backend/fixtures/capturedHostTeamReadsFixture';

import type { BackendProjectContextSnapshot } from '@features/agent-backend/contracts/projectContext';
import type { CapturedHostScheduleTarget } from '@features/agent-backend/main/application/captureHostScheduleTarget';
import type { DesktopBackendFeature } from '@features/agent-backend/main/composition/DesktopBackendFeature';
import type {
  Schedule,
  TeamAgentRuntimeSnapshot,
  TeamCreateRequest,
  TeamTask,
} from '@shared/types';

/** The logical team of a per-project team; its work really runs on the project copy. */
const LOGICAL = 'builders';
const COPY = 'ptc-token-a';

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    teamName: LOGICAL,
    executionMode: 'agent',
    taskFirst: true,
    targetMember: 'alice',
    cronExpression: '0 * * * *',
    timezone: 'UTC',
    status: 'active',
    warmUpMinutes: 0,
    maxConsecutiveFailures: 3,
    consecutiveFailures: 0,
    maxTurns: 5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    launchConfig: { cwd: '/work/a', prompt: 'Check bugs', providerId: 'anthropic' },
    ...overrides,
  };
}

function runtime(copy: string, alive: boolean): TeamAgentRuntimeSnapshot {
  const entry = (name: string, backendType?: 'lead') => ({
    memberName: name,
    alive,
    restartable: false,
    livenessKind: alive ? ('confirmed_bootstrap' as const) : ('not_found' as const),
    updatedAt: new Date().toISOString(),
    ...(backendType ? { backendType, pid: 5, pidSource: 'lead_process' as const } : {}),
  });
  return {
    teamName: copy,
    runId: alive ? 'run-1' : undefined,
    updatedAt: new Date().toISOString(),
    members: { lead: entry('lead', 'lead'), alice: entry('alice') },
  } as TeamAgentRuntimeSnapshot;
}

function makePort(alive: boolean): SmartScheduleRuntimePort {
  const saved: TeamCreateRequest = {
    teamName: COPY,
    cwd: '/work/a',
    providerId: 'anthropic',
    members: [{ name: 'alice' }],
  };
  return {
    isTeamAlive: vi.fn((team: string) => alive && team === COPY),
    isTeamLaunching: vi.fn(() => false),
    isTeamBusy: vi.fn(() => false),
    getRuntime: vi.fn(async (team: string) => runtime(team, alive && team === COPY)),
    getMemberStatuses: vi.fn(async () => ({ runId: 'run-1', statuses: {} })),
    getLeadName: vi.fn(async () => 'lead'),
    // The team definition (logical team) and the project copy each have their own saved request.
    getSavedRequest: vi.fn(async (team: string) =>
      team === COPY ? saved : team === LOGICAL ? { ...saved, teamName: LOGICAL } : null
    ),
    hasLaunchConfig: vi.fn(async (team: string) => team === COPY || team === LOGICAL),
    hasRunnableConfig: vi.fn(async (team: string) => team === COPY),
    hasActiveOwnedTask: vi.fn(() => false),
    getPreviousRuns: vi.fn(async () => []),
    getTask: vi.fn(async () => null),
    startTaskByUser: vi.fn(async () => ({ notifiedOwner: true })),
    attachMember: vi.fn(async () => undefined),
    createTask: vi.fn(async () => ({ id: 'task-1', displayId: '7', subject: 's', status: 'pending' } as TeamTask)),
    launchTeam: vi.fn(async () => ({ runId: 'native-run', launchStatus: 'started' as const })),
    runOneShot: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, summary: 'ok', durationMs: 1 })),
    resolveTarget: vi.fn(async () => ({
      kind: 'project' as const,
      executionTeamName: COPY,
      projectPath: '/work/a',
    })),
    launchProjectTeam: vi.fn(async () => ({ runId: 'copy-run', launchStatus: 'started' as const })),
  };
}

describe('SmartScheduleDispatcher for a per-project team', () => {
  let port: SmartScheduleRuntimePort;
  let dispatcher: SmartScheduleDispatcher;
  const notCancelled = () => false;

  beforeEach(() => {
    port = makePort(true);
    dispatcher = new SmartScheduleDispatcher(port);
  });

  it('creates and starts the task on the project copy of the live team, not on the logical name', async () => {
    const outcome = await dispatcher.dispatch(makeSchedule(), 'run-a', notCancelled);
    // The run records which copy holds the task, so its "Open task" link finds it.
    expect(outcome).toMatchObject({ kind: 'dispatched', taskId: 'task-1', executionTeamName: COPY });
    expect(port.createTask).toHaveBeenCalledWith(COPY, expect.objectContaining({ owner: 'alice' }));
    expect(port.createTask).not.toHaveBeenCalledWith(LOGICAL, expect.anything());
    expect(port.startTaskByUser).toHaveBeenCalledWith(COPY, 'task-1', expect.anything());
    expect(port.isTeamAlive).not.toHaveBeenCalledWith(LOGICAL);
  });

  it('records a refusal as a skip, never as a failure, and touches nothing', async () => {
    port.resolveTarget = vi.fn(async () => ({ kind: 'refused' as const, reason: 'Launch the team in this project first' }));
    const outcome = await dispatcher.dispatch(makeSchedule(), 'run-b', notCancelled);
    expect(outcome).toEqual({ kind: 'skipped', summary: 'Launch the team in this project first' });
    expect(port.createTask).not.toHaveBeenCalled();
    expect(port.launchTeam).not.toHaveBeenCalled();
    expect(port.launchProjectTeam).not.toHaveBeenCalled();
  });

  it('launches a stopped project copy through the project-context path with the logical team', async () => {
    port = makePort(false);
    dispatcher = new SmartScheduleDispatcher(port);
    // The task is on the board of the copy; the launch is routed, never the raw native launch.
    const launchedFlag = { value: false };
    port.getRuntime = vi.fn(async (team: string) => runtime(team, team === COPY && launchedFlag.value));
    port.launchProjectTeam = vi.fn(async () => {
      launchedFlag.value = true;
      return { runId: 'run-1', launchStatus: 'started' as const };
    });
    port.isTeamAlive = vi.fn((team: string) => team === COPY && launchedFlag.value);

    const outcome = await dispatcher.dispatch(makeSchedule(), 'run-c', notCancelled);
    expect(port.createTask).toHaveBeenCalledWith(COPY, expect.anything());
    expect(port.launchProjectTeam).toHaveBeenCalledTimes(1);
    expect(port.launchTeam).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('dispatched');
  });

  it('turns a launch refusal after the task was saved into a skip that names the task', async () => {
    port = makePort(false);
    dispatcher = new SmartScheduleDispatcher(port);
    port.launchProjectTeam = vi.fn(async () => ({ refused: 'This team is running in another project' }));
    const outcome = await dispatcher.dispatch(makeSchedule(), 'run-d', notCancelled);
    expect(outcome.kind).toBe('skipped');
    expect((outcome as { summary: string }).summary).toContain('This team is running in another project');
    expect((outcome as { taskId?: string }).taskId).toBe('task-1');
  });

  it('serialises dispatches of the same logical team even though they run on a copy', async () => {
    let release: () => void = () => undefined;
    port.createTask = vi.fn(() => new Promise<TeamTask>((resolve) => {
      release = () => resolve({ id: 't', displayId: '1', subject: 's', status: 'pending' } as TeamTask);
    }));
    const first = dispatcher.dispatch(makeSchedule(), 'run-e1', notCancelled);
    await vi.waitFor(() => expect(port.createTask).toHaveBeenCalled());
    const second = await dispatcher.dispatch(makeSchedule({ id: 'schedule-2' }), 'run-e2', notCancelled);
    expect(second).toEqual({ kind: 'skipped', summary: 'Another schedule is already dispatching this team' });
    release();
    await first;
  });

  // The instructions the user reviewed in the dialog are those of the team definition (the
  // logical team). The project copy keeps its own, sticky, copy of them.
  describe('saved instructions review', () => {
    const withPrompts = (logical: string | undefined, copy: string | undefined) => {
      port = makePort(false);
      port.getSavedRequest = vi.fn(async (team: string) => {
        if (team === COPY) {
          return { teamName: COPY, cwd: '/work/a', providerId: 'anthropic', prompt: copy, members: [{ name: 'alice' }] } as TeamCreateRequest;
        }
        return team === LOGICAL
          ? ({ teamName: LOGICAL, cwd: '/work/a', providerId: 'anthropic', prompt: logical, members: [{ name: 'alice' }] } as TeamCreateRequest)
          : null;
      });
      port.launchProjectTeam = vi.fn(async () => ({ refused: 'stop here' }));
      dispatcher = new SmartScheduleDispatcher(port);
    };
    const REVIEW = 'Review historical team instructions before enabling task-first launch';

    it('does not ask for a review the dialog never offered: only the copy has old instructions', async () => {
      withPrompts(undefined, 'Old launch instructions kept by the copy');
      const outcome = await dispatcher.dispatch(makeSchedule(), 'run-r1', notCancelled);
      expect((outcome as { summary: string }).summary).not.toBe(REVIEW);
      expect(port.createTask).toHaveBeenCalledWith(COPY, expect.anything());
    });

    it('asks for the review when the team definition has old instructions', async () => {
      withPrompts('Old team instructions', undefined);
      const outcome = await dispatcher.dispatch(makeSchedule(), 'run-r2', notCancelled);
      expect(outcome).toEqual({ kind: 'skipped', summary: REVIEW });
      expect(port.createTask).not.toHaveBeenCalled();
    });

    it('proceeds once the instructions of the team definition were reviewed', async () => {
      withPrompts('Old team instructions', 'Copy instructions');
      const outcome = await dispatcher.dispatch(
        makeSchedule({ reviewedSavedPrompt: true }), 'run-r3', notCancelled
      );
      expect((outcome as { summary: string }).summary).not.toBe(REVIEW);
      expect(port.createTask).toHaveBeenCalledWith(COPY, expect.anything());
    });

    it('fails closed when the team definition cannot be read', async () => {
      withPrompts(undefined, undefined);
      port.getSavedRequest = vi.fn(async (team: string) =>
        team === COPY
          ? ({ teamName: COPY, cwd: '/work/a', providerId: 'anthropic', members: [{ name: 'alice' }] } as TeamCreateRequest)
          : null
      );
      const outcome = await dispatcher.dispatch(makeSchedule(), 'run-r4', notCancelled);
      expect(outcome.kind).toBe('skipped');
      expect(port.createTask).not.toHaveBeenCalled();
    });
  });

  it('keeps ordinary teams on their own name when there is no target port', async () => {
    const plain = makePort(true);
    delete plain.resolveTarget;
    delete plain.launchProjectTeam;
    plain.isTeamAlive = vi.fn(() => true);
    plain.getRuntime = vi.fn(async () => runtime(LOGICAL, true));
    plain.getSavedRequest = vi.fn(async () => ({
      teamName: LOGICAL, cwd: '/work/a', providerId: 'anthropic', members: [{ name: 'alice' }],
    } as TeamCreateRequest));
    const outcome = await new SmartScheduleDispatcher(plain).dispatch(makeSchedule(), 'run-f', notCancelled);
    expect(outcome.kind).toBe('dispatched');
    expect(outcome).not.toHaveProperty('executionTeamName');
    expect(plain.createTask).toHaveBeenCalledWith(LOGICAL, expect.anything());
  });

  it('runs the one-shot agent mode without any team target when the team is stopped', async () => {
    port = makePort(false);
    port.isTeamAlive = vi.fn(() => false);
    dispatcher = new SmartScheduleDispatcher(port);
    const outcome = await dispatcher.dispatch(
      makeSchedule({ taskFirst: undefined, targetMember: undefined }), 'run-g', notCancelled
    );
    expect(outcome.kind).toBe('one_shot');
    expect(port.runOneShot).toHaveBeenCalledTimes(1);
  });
});

const hostFixtures: ReturnType<typeof capturedHostTeamReadsFixture>[] = [];
afterEach(() => { for (const f of hostFixtures.splice(0)) f.dispose(); });

/** Real saved rosters and original binding captures; project transport/runtime observations are finite ports. */
async function hostProjectFixture(alive: boolean) {
  const f = capturedHostTeamReadsFixture(); hostFixtures.push(f);
  const logical = f.addTeam({ name: 'logical', projectContextMode: 'per_project' });
  const projectPath = join(f.root, 'TEST-history');
  const child = f.addTeam({ name: 'history', projectContext: {
    logicalHandleId: logical.connection.handle.handleId, workContextId: 'TEST-history-context', projectPath,
  } });
  const feature = f.feature as DesktopBackendFeature;
  const identity = await captureHostScheduleTarget(feature, f.scope.contextId, logical.key,
    { isCurrent: f.scope.isCurrent });
  const original = await restoreHostScheduleTarget(feature, logical.key, identity, f.scope.isCurrent);
  const view: BackendProjectContextSnapshot = { kind: 'team-project-context',
    view: { mode: 'per_project', state: 'ready', executionTeamName: child.key,
      workContextId: 'TEST-history-context', projectPath },
    histories: [{ executionTeamName: child.key, workContextId: 'TEST-history-context', projectPath }],
  };
  const invoke = vi.fn<CapturedHostScheduleTarget['invoke']>(async request => {
    if (request.operation === 'team.project-context.read') return { ok: true, value: view };
    if (request.operation === 'team.project-context.prepare') return { ok: true, value: {
      ...view, prepared: { executionHandle: child.connection.handle,
        rosterCommandId: 'TEST-original-project-roster', sourceRevision: logical.human.readRoster().revision },
    } };
    return original.invoke(request);
  });
  const target = { ...original, invoke };
  const project = (await captureHostProjectScheduleContext({ feature, logical: target,
    projectPath, runId: 'TEST-original-run' }))!;
  const run = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, summary: 'TEST result', durationMs: 1 }));
  const adapter = new HostSmartScheduleRuntimeAdapter({ target, selection: logical.key,
    project, runId: 'TEST-original-run', getPreviousRuns: async () => [], runOneShot: run });
  vi.spyOn(adapter, 'isTeamLaunching').mockResolvedValue(false);
  vi.spyOn(adapter, 'isTeamBusy').mockResolvedValue(false);
  vi.spyOn(adapter, 'isTeamAlive').mockResolvedValue(alive);
  const request = { runId: 'TEST-original-run', config: { cwd: projectPath, prompt: 'TEST original input' } };
  return { f, logical, child, feature, target, project, projectPath, invoke, adapter, run, request };
}

it.each([true, false])('retains the original standalone project target when selected history live=%s', async alive => {
  const f = await hostProjectFixture(alive);
  await expect(f.adapter.runOneShot(f.request)).resolves.toMatchObject({ exitCode: 0 });
  expect(f.run).toHaveBeenCalledExactlyOnceWith(f.request, f.child.human.readRoster().revision,
    expect.objectContaining({ target: expect.objectContaining({ handleId: f.child.connection.handle.handleId,
      ownerResourceRef: f.logical.connection.ownerResourceRef }) }));
  const prepares = f.invoke.mock.calls.filter(([request]) => request.operation === 'team.project-context.prepare');
  expect(prepares).toHaveLength(alive ? 0 : 1);
  if (!alive) expect(prepares[0]?.[0]).toEqual({ operation: 'team.project-context.prepare',
    commandId: 'TEST-original-run:project', payload: { projectPath: f.projectPath,
      expectedRevision: f.logical.human.readRoster().revision } });
  expect(f.f.router.request.mock.calls.every(([, request]) => request.method === 'team.roster.read')).toBe(true);
});

it('refuses standalone dispatch after original owner revocation during repeated project admission', async () => {
  const f = await hostProjectFixture(true), resolve = f.project.resolve.bind(f.project);
  let resolutions = 0;
  vi.spyOn(f.project, 'resolve').mockImplementation(async () => {
    const result = await resolve();
    if (++resolutions === 2) f.f.revokeContext();
    return result;
  });
  await expect(f.adapter.runOneShot(f.request)).rejects.toThrow('Original scheduled team is unavailable');
  expect(f.run).not.toHaveBeenCalled();
  expect(f.invoke.mock.calls.some(([request]) => request.operation === 'team.project-context.prepare')).toBe(false);
});

it('does not admit a changed project folder or a replacement child owner', async () => {
  const f = await hostProjectFixture(false);
  await expect(captureHostProjectScheduleContext({ feature: f.feature, logical: f.target,
    projectPath: f.projectPath, folderChange: { from: f.projectPath, cwd: join(f.f.root, 'TEST-other') } }))
    .rejects.toThrow('The project of a schedule can not be changed');
  f.child.connection.ownerResourceRef = 'TEST-replacement-owner';
  await expect(f.project.resolve()).rejects.toThrow('Scheduled project owner changed');
  expect(f.run).not.toHaveBeenCalled();
});

it('retains one project preparation and rejects a different definition for the original occurrence', async () => {
  const f = await hostProjectFixture(false), revision = f.logical.human.readRoster().revision;
  const first = await f.project.prepare(revision), repeated = await f.project.prepare(revision);
  expect(repeated).toBe(first);
  expect(first.rosterCommandId).toBe('TEST-original-project-roster');
  expect(() => f.project.prepare('TEST-different-revision')).toThrow('Original scheduled project definition changed');
  expect(f.invoke.mock.calls.filter(([request]) => request.operation === 'team.project-context.prepare')).toHaveLength(1);
});
