import { describe, expect, it, vi } from 'vitest';

import {
  clearSecondaryRuntimeRuns,
  createMixedSecondaryLaneStateForMember,
  createMixedSecondaryLaneStates,
  createSecondaryRuntimeRunStore,
  deleteSecondaryRuntimeRun,
  getCurrentOpenCodeRuntimeRunId,
  getMixedSecondaryLaunchPhase,
  getSecondaryRuntimeRuns,
  hasSecondaryRuntimeRuns,
  type MixedSecondaryRuntimeLaneState,
  removeRunAllEffectiveMember,
  type SecondaryRuntimeRunEntry,
  type SecondaryRuntimeRunProvisioningRun,
  setSecondaryRuntimeRun,
  upsertRunAllEffectiveMember,
} from '../TeamProvisioningSecondaryRuntimeRuns';

import type { TeamRuntimeLaunchResult } from '../../runtime/TeamRuntimeAdapter';
import type { PlannedRuntimeMember, TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import type { TeamCreateRequest, TeamProvisioningProgress } from '@shared/types';

const baseRequest = {
  teamName: 'team-a',
  cwd: '/repo',
  providerId: 'codex',
  members: [],
} as unknown as TeamCreateRequest;

function member(
  name: string,
  providerId: 'codex' | 'opencode',
  extra: Omit<Partial<TeamCreateRequest['members'][number]>, 'providerId'> = {}
): PlannedRuntimeMember {
  return {
    name,
    role: 'engineer',
    providerId,
    ...extra,
  } as PlannedRuntimeMember;
}

function runtimeResult(teamLaunchState: TeamRuntimeLaunchResult['teamLaunchState']) {
  return {
    runId: 'run-a',
    teamName: 'team-a',
    launchPhase: 'active',
    teamLaunchState,
    members: {},
    warnings: [],
    diagnostics: [],
  } as TeamRuntimeLaunchResult;
}

function lane(
  state: MixedSecondaryRuntimeLaneState['state'],
  result: TeamRuntimeLaunchResult | null = null
): MixedSecondaryRuntimeLaneState {
  return {
    laneId: 'secondary:opencode:bob',
    providerId: 'opencode',
    member: member('bob', 'opencode'),
    runId: result?.runId ?? null,
    state,
    result,
    warnings: [],
    diagnostics: [],
  };
}

function progress(state: TeamProvisioningProgress['state']): TeamProvisioningProgress {
  return {
    runId: 'run-pending',
    teamName: 'team-a',
    state,
    message: 'pending',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
  };
}

describe('TeamProvisioningSecondaryRuntimeRuns', () => {
  describe('mixed secondary lane state', () => {
    it('builds queued lane states from mixed OpenCode side lane plans', () => {
      const bob = member('bob', 'opencode', { model: 'minimax' });
      const plan: TeamRuntimeLanePlan = {
        mode: 'mixed_opencode_side_lanes',
        primaryMembers: [member('alice', 'codex')],
        allMembers: [member('alice', 'codex'), bob],
        sideLanes: [{ laneId: 'secondary:opencode:bob', providerId: 'opencode', member: bob }],
      };

      expect(createMixedSecondaryLaneStates(plan)).toEqual([
        {
          laneId: 'secondary:opencode:bob',
          providerId: 'opencode',
          member: bob,
          runId: null,
          state: 'queued',
          result: null,
          warnings: [],
          diagnostics: [],
        },
      ]);
    });

    it('returns no side lanes for primary-only plans', () => {
      expect(
        createMixedSecondaryLaneStates({
          mode: 'primary_only',
          primaryMembers: [member('alice', 'codex')],
          allMembers: [member('alice', 'codex')],
          sideLanes: [],
        })
      ).toEqual([]);
    });

    it('reuses the existing lane id when rebuilding a member lane state', () => {
      const run: Pick<SecondaryRuntimeRunProvisioningRun, 'request' | 'mixedSecondaryLanes'> = {
        request: { ...baseRequest, providerId: 'opencode' },
        mixedSecondaryLanes: [
          {
            ...lane('launching'),
            laneId: 'secondary:opencode:bob-custom',
            member: member('bob', 'opencode'),
          },
        ],
      };

      expect(createMixedSecondaryLaneStateForMember(run, member('bob', 'opencode'))).toMatchObject({
        laneId: 'secondary:opencode:bob-custom',
        state: 'queued',
        result: null,
      });
    });

    it('keeps mixed secondary launch active until every lane has a terminal non-pending result', () => {
      expect(getMixedSecondaryLaunchPhase({ mixedSecondaryLanes: [lane('queued')] })).toBe(
        'active'
      );
      expect(
        getMixedSecondaryLaunchPhase({
          mixedSecondaryLanes: [lane('finished', runtimeResult('partial_pending'))],
        })
      ).toBe('active');
      expect(
        getMixedSecondaryLaunchPhase({
          mixedSecondaryLanes: [lane('finished', runtimeResult('clean_success'))],
        })
      ).toBe('finished');
    });
  });

  describe('run member bookkeeping', () => {
    it('keeps primary members in effective and expected lists while side-lane members stay all-effective only', () => {
      const run: SecondaryRuntimeRunProvisioningRun = {
        request: { ...baseRequest, members: [] },
        allEffectiveMembers: [],
        effectiveMembers: [],
        expectedMembers: [],
      };
      upsertRunAllEffectiveMember(run, member('Alice', 'codex'));
      upsertRunAllEffectiveMember(run, member('Bob', 'opencode'));

      expect(run.request.members.map((candidate) => candidate.name)).toEqual(['Alice', 'Bob']);
      expect(run.allEffectiveMembers?.map((candidate) => candidate.name)).toEqual(['Alice', 'Bob']);
      expect(run.effectiveMembers?.map((candidate) => candidate.name)).toEqual(['Alice']);
      expect(run.expectedMembers).toEqual(['Alice']);
    });

    it('upserts and removes members by normalized name across all run lists', () => {
      const run: SecondaryRuntimeRunProvisioningRun = {
        request: { ...baseRequest, members: [member('Alice', 'codex')] },
        allEffectiveMembers: [member('Alice', 'codex')],
        effectiveMembers: [member('Alice', 'codex')],
        expectedMembers: ['Alice'],
      };
      upsertRunAllEffectiveMember(run, member(' alice ', 'codex', { model: 'gpt-5' }));
      removeRunAllEffectiveMember(run, 'ALICE');

      expect(run.request.members).toEqual([]);
      expect(run.allEffectiveMembers).toEqual([]);
      expect(run.effectiveMembers).toEqual([]);
      expect(run.expectedMembers).toEqual([]);
    });
  });

  describe('secondary runtime run map', () => {
    it('sets, lists, deletes, and clears secondary runtime runs by team and lane', () => {
      const runs = new Map<string, Map<string, SecondaryRuntimeRunEntry>>();

      setSecondaryRuntimeRun(runs, {
        teamName: 'team-a',
        runId: 'run-1',
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
        cwd: '/repo/bob',
      });
      setSecondaryRuntimeRun(runs, {
        teamName: 'team-a',
        runId: 'run-2',
        providerId: 'opencode',
        laneId: 'secondary:opencode:tom',
        memberName: 'tom',
      });

      expect(hasSecondaryRuntimeRuns(runs, 'team-a')).toBe(true);
      expect(getSecondaryRuntimeRuns(runs, 'team-a')).toEqual([
        expect.objectContaining({ runId: 'run-1', laneId: 'secondary:opencode:bob' }),
        expect.objectContaining({ runId: 'run-2', laneId: 'secondary:opencode:tom' }),
      ]);

      deleteSecondaryRuntimeRun(runs, 'team-a', 'secondary:opencode:bob');
      expect(getSecondaryRuntimeRuns(runs, 'team-a')).toEqual([
        expect.objectContaining({ runId: 'run-2', laneId: 'secondary:opencode:tom' }),
      ]);

      clearSecondaryRuntimeRuns(runs, 'team-a');
      expect(hasSecondaryRuntimeRuns(runs, 'team-a')).toBe(false);
    });

    it('creates a store that dismisses OpenCode tool approvals when deleting or clearing runs', () => {
      const runs = new Map<string, Map<string, SecondaryRuntimeRunEntry>>();
      const clearOpenCodeRuntimeToolApprovals = vi.fn();
      const store = createSecondaryRuntimeRunStore({
        secondaryRuntimeRunByTeam: runs,
        ports: { clearOpenCodeRuntimeToolApprovals },
      });

      store.setSecondaryRuntimeRun({
        teamName: 'team-a',
        runId: 'run-1',
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
      });
      store.setSecondaryRuntimeRun({
        teamName: 'team-a',
        runId: 'run-2',
        providerId: 'opencode',
        laneId: 'secondary:opencode:tom',
        memberName: 'tom',
      });

      expect(store.hasSecondaryRuntimeRuns('team-a')).toBe(true);

      store.deleteSecondaryRuntimeRun('team-a', 'secondary:opencode:bob');
      expect(clearOpenCodeRuntimeToolApprovals).toHaveBeenCalledWith('team-a', {
        laneId: 'secondary:opencode:bob',
        emitDismiss: true,
      });
      expect(store.getSecondaryRuntimeRuns('team-a')).toEqual([
        expect.objectContaining({ runId: 'run-2', laneId: 'secondary:opencode:tom' }),
      ]);

      store.clearSecondaryRuntimeRuns('team-a');
      expect(clearOpenCodeRuntimeToolApprovals).toHaveBeenCalledWith('team-a', {
        emitDismiss: true,
      });
      expect(store.hasSecondaryRuntimeRuns('team-a')).toBe(false);
    });

    it('resolves current OpenCode run ids from primary and secondary runtime maps', () => {
      const shouldRouteOpenCodeToRuntimeAdapter = vi.fn(() => true);
      const isCancellableRuntimeAdapterProgress = vi.fn(() => true);
      const runs = new Map<string, { request: TeamCreateRequest }>([
        ['run-tracked', { request: { ...baseRequest, providerId: 'opencode' } }],
      ]);
      const secondaryRuns = new Map<string, Map<string, SecondaryRuntimeRunEntry>>();
      setSecondaryRuntimeRun(secondaryRuns, {
        teamName: 'team-a',
        runId: 'run-secondary',
        providerId: 'opencode',
        laneId: 'secondary:opencode:bob',
        memberName: 'bob',
      });

      expect(
        getCurrentOpenCodeRuntimeRunId({
          teamName: 'team-a',
          laneId: 'primary',
          trackedRunId: 'run-tracked',
          runs,
          provisioningRunByTeam: new Map(),
          runtimeAdapterProgressByRunId: new Map(),
          runtimeAdapterRunByTeam: new Map(),
          secondaryRuntimeRunByTeam: secondaryRuns,
          shouldRouteOpenCodeToRuntimeAdapter,
          isCancellableRuntimeAdapterProgress,
        })
      ).toBe('run-tracked');
      expect(shouldRouteOpenCodeToRuntimeAdapter).toHaveBeenCalled();

      expect(
        getCurrentOpenCodeRuntimeRunId({
          teamName: 'team-a',
          laneId: 'primary',
          trackedRunId: 'run-pending',
          runs: new Map(),
          provisioningRunByTeam: new Map([['team-a', 'run-pending']]),
          runtimeAdapterProgressByRunId: new Map([['run-pending', progress('spawning')]]),
          runtimeAdapterRunByTeam: new Map(),
          secondaryRuntimeRunByTeam: secondaryRuns,
          shouldRouteOpenCodeToRuntimeAdapter: () => false,
          isCancellableRuntimeAdapterProgress,
        })
      ).toBe('run-pending');

      expect(
        getCurrentOpenCodeRuntimeRunId({
          teamName: 'team-a',
          laneId: 'primary',
          trackedRunId: null,
          runs: new Map(),
          provisioningRunByTeam: new Map(),
          runtimeAdapterProgressByRunId: new Map(),
          runtimeAdapterRunByTeam: new Map([
            ['team-a', { runId: 'run-primary-runtime', providerId: 'opencode' }],
          ]),
          secondaryRuntimeRunByTeam: secondaryRuns,
          shouldRouteOpenCodeToRuntimeAdapter: () => false,
          isCancellableRuntimeAdapterProgress,
        })
      ).toBe('run-primary-runtime');

      expect(
        getCurrentOpenCodeRuntimeRunId({
          teamName: 'team-a',
          laneId: 'secondary:opencode:bob',
          trackedRunId: null,
          runs: new Map(),
          provisioningRunByTeam: new Map(),
          runtimeAdapterProgressByRunId: new Map(),
          runtimeAdapterRunByTeam: new Map(),
          secondaryRuntimeRunByTeam: secondaryRuns,
          shouldRouteOpenCodeToRuntimeAdapter: () => false,
          isCancellableRuntimeAdapterProgress,
        })
      ).toBe('run-secondary');
    });
  });
});
