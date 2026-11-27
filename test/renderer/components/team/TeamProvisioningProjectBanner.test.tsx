import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { hostTeamRunId, hostTeamSelectionKey } from '@features/agent-backend/contracts';
import { TeamProvisioningBanner } from '@renderer/components/team/TeamProvisioningBanner';
import { clearAllTeamLocalStateEpochs } from '@renderer/store/team/teamLocalStateEpoch';
import { resetContextScopedRequestEpochForTests } from '@renderer/store/utils/contextScopedRequestEpoch';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createStore, useStore as useZustandStore } from 'zustand';

import type { AppState } from '@renderer/store/types';
import type { TeamViewSnapshot } from '@shared/types';
import type { StoreApi } from 'zustand';

const logical = hostTeamSelectionKey('TEST-logical');
const physical = hostTeamSelectionKey('TEST-project-a');
const other = hostTeamSelectionKey('TEST-project-b');
const run = hostTeamRunId('TEST-project-a', 'TEST-launch-a', 'TEST-roster');
const otherRun = hostTeamRunId('TEST-project-b', 'TEST-launch-b', 'TEST-roster');
const timestamp = '2026-11-27T19:54:23.805Z';
type State = Pick<
  AppState,
  | 'activeContextId'
  | 'isContextSwitching'
  | 'provisioningRuns'
  | 'currentRuntimeRunIdByTeam'
  | 'currentProvisioningRunIdByTeam'
  | 'ignoredRuntimeRunIds'
  | 'ignoredProvisioningRunIds'
  | 'selectedTeamName'
  | 'selectedTeamData'
  | 'teamDataCacheByName'
  | 'memberSpawnStatusesByTeam'
  | 'memberSpawnSnapshotsByTeam'
  | 'teamAgentRuntimeByTeam'
  | 'leadActivityByTeam'
  | 'provisioningErrorByTeam'
  | 'clearProvisioningError'
  | 'cancelProvisioning'
  | 'retryFailedOpenCodeSecondaryLanes'
  | 'restartMember'
>;
let state: State;
let store: StoreApi<State>;
const restart = vi.fn<AppState['restartMember']>();
const copy = vi.fn<(text: string) => Promise<void>>();
const diagnostics = vi.hoisted(() => vi.fn());
const roots: ReturnType<typeof createRoot>[] = [];

vi.mock('@renderer/store', () => ({
  useStore: Object.assign((select: (value: State) => unknown) => useZustandStore(store, select), {
    getState: () => state,
  }),
}));
vi.mock('@renderer/store/slices/teamSlice', async () => ({
  ...(await import('@renderer/store/team/teamDataSelectors')),
  getCurrentProvisioningProgressForTeam: (
    await import('@renderer/store/team/teamProvisioningRunIdentity')
  ).getCurrentProvisioningProgressForTeam,
}));
vi.mock('@renderer/api', () => ({
  api: { teams: { getLaunchFailureDiagnostics: diagnostics } },
}));
vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) =>
    React.createElement('button', { type: 'button', ...props }, children),
}));
vi.mock('@renderer/components/chat/viewers/MarkdownViewer', () => ({
  MarkdownViewer: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('@renderer/components/team/CliLogsRichView', () => ({
  CliLogsRichView: ({ cliLogsTail }: { cliLogsTail: string }) => <div>{cliLogsTail}</div>,
}));
vi.mock('@renderer/components/team/StepProgressBar', () => ({
  StepProgressBar: () => <div data-testid="stepper" />,
}));

function data(teamName: string, isAlive: boolean): TeamViewSnapshot {
  return {
    teamName,
    isAlive,
    config: { name: teamName },
    tasks: [],
    processes: [],
    kanbanState: { teamName, reviewers: [], tasks: {} },
    members: [
      { name: 'Lead', agentType: 'team-lead', taskCount: 0, currentTaskId: null },
      { name: 'alice', providerId: 'opencode', taskCount: 0, currentTaskId: null },
    ],
  };
}
function selectRun(target = physical, runId = run) {
  state.provisioningRuns[runId] = {
    teamName: logical,
    runId,
    state: 'ready',
    message: 'TEST launch completed',
    startedAt: timestamp,
    updatedAt: timestamp,
    configReady: true,
  };
  state.currentProvisioningRunIdByTeam[logical] = runId;
  state.currentRuntimeRunIdByTeam[logical] = runId;
  state.currentRuntimeRunIdByTeam[target] = runId;
  state.currentProvisioningRunIdByTeam[target] = null;
  state.memberSpawnSnapshotsByTeam[logical] = {
    runId,
    expectedMembers: ['alice'],
    statuses: {
      alice: {
        status: 'online',
        launchState: 'confirmed_alive',
        bootstrapConfirmed: true,
        runtimeAlive: true,
      },
    },
  };
  state.memberSpawnStatusesByTeam[logical] = state.memberSpawnSnapshotsByTeam[logical].statuses;
  state.teamAgentRuntimeByTeam[target] = {
    teamName: target,
    runId,
    updatedAt: timestamp,
    members: {
      alice: {
        memberName: 'alice',
        alive: true,
        restartable: true,
        providerId: 'opencode',
        runtimeModel: 'TEST-captured-model',
        updatedAt: timestamp,
      },
    },
  };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetContextScopedRequestEpochForTests();
  clearAllTeamLocalStateEpochs();
  restart.mockReset().mockResolvedValue(undefined);
  copy.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  diagnostics.mockReset().mockImplementation(async (teamName: string, runId: string) => ({
    teamName,
    runId,
    source: 'captured-host',
    observations: [],
    files: [],
  }));
  state = {
    activeContextId: 'local',
    isContextSwitching: false,
    provisioningRuns: {},
    currentRuntimeRunIdByTeam: {},
    currentProvisioningRunIdByTeam: {},
    ignoredRuntimeRunIds: {},
    ignoredProvisioningRunIds: {},
    selectedTeamName: physical,
    selectedTeamData: data(physical, true),
    teamDataCacheByName: { [logical]: data(logical, false), [other]: data(other, true) },
    memberSpawnStatusesByTeam: {},
    memberSpawnSnapshotsByTeam: {},
    teamAgentRuntimeByTeam: {},
    leadActivityByTeam: {},
    provisioningErrorByTeam: {},
    clearProvisioningError: vi.fn(),
    cancelProvisioning: vi.fn().mockResolvedValue(undefined),
    retryFailedOpenCodeSecondaryLanes: vi.fn(),
    restartMember: restart,
  };
  selectRun();
  store = createStore(() => state);
});
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
async function mount(target = physical, owner = logical) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const render = async (runtimeTeamName = target) => {
    await act(async () => {
      store.setState({ ...state }, true);
      root.render(<TeamProvisioningBanner teamName={owner} runtimeTeamName={runtimeTeamName} />);
    });
  };
  await render();
  return { host, render };
}
async function copyDiagnostics(host: HTMLElement) {
  const button = host.querySelector<HTMLButtonElement>('[aria-label="Copy diagnostics"]');
  expect(button).not.toBeNull();
  await act(async () => button!.click());
  return copy.mock.calls.at(-1)![0];
}
it('shows the exact live project while its logical definition is offline and copies physical diagnostics', async () => {
  const progress = state.provisioningRuns[run];
  const { host } = await mount();
  expect(host.textContent).toMatch(/Team is ready\.|Team launched/);
  const copied = await copyDiagnostics(host);
  expect(diagnostics).toHaveBeenCalledWith(physical, run);
  expect(copied).toContain(physical);
  expect(copied).toContain('TEST-captured-model');
  expect(copied).not.toContain(logical);
  expect(state.provisioningRuns[run]).toBe(progress);
  expect(state.currentProvisioningRunIdByTeam[physical]).toBeNull();
});
it('withholds stopped success and recovers on the same mount without rewriting progress', async () => {
  const progress = state.provisioningRuns[run];
  const { host, render } = await mount();
  expect(host.querySelector('[data-testid="stepper"]')).not.toBeNull();
  state.selectedTeamData!.isAlive = false;
  await render();
  expect(host.textContent).toBe('');
  state.selectedTeamData!.isAlive = true;
  await render();
  expect(host.textContent).toMatch(/Team is ready\.|Team launched/);
  expect(state.provisioningRuns[run]).toBe(progress);
});
it.each([
  'other-project',
  'wrong-owner',
  'malformed',
  'legacy',
  'pending',
  'stale-pointer',
] as const)('does not show foreign or unbound ready progress: %s', async (kind) => {
  if (kind === 'other-project') selectRun(other, otherRun);
  if (kind === 'wrong-owner') state.provisioningRuns[run].teamName = other;
  if (kind === 'malformed') state.provisioningRuns[run].runId = 'host-run:bad';
  if (kind === 'legacy') state.provisioningRuns[run].runId = 'legacy-run';
  if (kind === 'pending')
    state.provisioningRuns[run].runId = 'pending:' + logical + ':TEST-attempt';
  if (kind === 'stale-pointer') state.currentRuntimeRunIdByTeam[physical] = otherRun;
  const { host } = await mount();
  expect(host.textContent).toBe('');
  expect(diagnostics).not.toHaveBeenCalled();
  expect(restart).not.toHaveBeenCalled();
});
it.each(['team', 'run'] as const)(
  'rejects a stale runtime snapshot %s despite a matching current pointer',
  async (field) => {
    const snapshot = state.teamAgentRuntimeByTeam[physical];
    if (field === 'team') snapshot.teamName = other;
    else snapshot.runId = otherRun;
    snapshot.members.alice.runtimeModel = 'TEST-stale-runtime';
    const { host } = await mount();
    expect(await copyDiagnostics(host)).not.toContain('TEST-stale-runtime');
  }
);
it('rejects wrong-run logical spawn details and keeps the physical roster', async () => {
  state.teamDataCacheByName[logical].members.push({
    name: 'TEST-definition-only',
    taskCount: 0,
    currentTaskId: null,
  });
  state.memberSpawnSnapshotsByTeam[logical] = {
    runId: otherRun,
    statuses: {
      'TEST-stale-spawn': {
        status: 'error',
        launchState: 'failed_to_start',
        error: 'TEST-foreign-failure',
      },
    },
  };
  state.memberSpawnStatusesByTeam[logical] = state.memberSpawnSnapshotsByTeam[logical].statuses;
  const { host } = await mount();
  const copied = await copyDiagnostics(host);
  expect(copied).not.toContain('TEST-stale-spawn');
  expect(copied).not.toContain('TEST-definition-only');
  expect(copied).toContain('alice');
});
it.each(['assembling', 'failed'] as const)(
  'keeps same-project %s diagnostics before physical hydration',
  async (phase) => {
    state.provisioningRuns[run].state = phase;
    state.provisioningRuns[run].message = 'TEST early launch outcome';
    delete state.currentRuntimeRunIdByTeam[physical];
    state.selectedTeamData!.isAlive = false;
    state.teamAgentRuntimeByTeam[physical].members.alice.runtimeModel = 'TEST-unconfirmed-runtime';
    state.memberSpawnSnapshotsByTeam[logical].statuses.alice = {
      status: 'error',
      launchState: 'failed_to_start',
      runtimeAlive: false,
      error: 'TEST-no-allocation',
      hostFailedMemberRetry: {
        runId: run,
        memberId: 'alice',
        generation: null,
        attemptId: 'TEST-failed',
        noAllocation: true,
      },
    };
    const { host } = await mount();
    expect(host.querySelector('[data-testid="stepper"]')).not.toBeNull();
    const copied = await copyDiagnostics(host);
    expect(copied).toContain('TEST-no-allocation');
    expect(copied).not.toContain('TEST-unconfirmed-runtime');
    expect(host.textContent).not.toContain('Retry failed OpenCode teammates');
  }
);
it('does not attach an old retry completion to a newly viewed project', async () => {
  const captured = {
    runId: run,
    memberId: 'alice',
    generation: 'TEST-generation',
    attemptId: 'TEST-failed',
    noAllocation: false,
  };
  state.memberSpawnSnapshotsByTeam[logical].statuses.alice = {
    status: 'error',
    launchState: 'failed_to_start',
    runtimeAlive: false,
    hostFailedMemberRetry: captured,
  };
  let release!: () => void;
  restart.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  const { host, render } = await mount();
  const retry = [...host.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Retry failed OpenCode teammates')
  );
  expect(retry).toBeDefined();
  await act(async () => retry!.click());
  expect(restart.mock.calls).toEqual([[physical, 'alice', undefined, captured]]);
  selectRun(other, otherRun);
  await render(other);
  await act(async () => release());
  expect(host.textContent).toMatch(/Team is ready\.|Team launched/);
  expect(host.textContent).not.toMatch(/Restart requested|Team launch changed|Retrying OpenCode/);
  expect(restart).toHaveBeenCalledTimes(1);
});

it('does not carry a dismissed project banner into the next project on the same mount', async () => {
  const { host, render } = await mount();
  const dismiss = host.querySelector('svg.lucide-x')?.closest('button');
  expect(dismiss).toBeDefined();
  await act(async () => dismiss!.click());
  expect(host.textContent).toBe('');
  selectRun(other, otherRun);
  await render(other);
  expect(host.textContent).toMatch(/Team is ready\.|Team launched/);
});

it('preserves legacy progress and diagnostics without treating its runtime name as a Host pair', async () => {
  const legacy = 'TEST-legacy';
  const legacyRun = 'legacy-run';
  state.provisioningRuns[legacyRun] = {
    ...state.provisioningRuns[run],
    teamName: legacy,
    runId: legacyRun,
  };
  state.currentProvisioningRunIdByTeam[legacy] = legacyRun;
  state.teamDataCacheByName[legacy] = data(legacy, true);
  const { host } = await mount('TEST-legacy-child', legacy);
  expect(host.querySelector('[data-testid="stepper"]')).not.toBeNull();
  await copyDiagnostics(host);
  expect(diagnostics).toHaveBeenCalledWith(legacy, legacyRun);
});
