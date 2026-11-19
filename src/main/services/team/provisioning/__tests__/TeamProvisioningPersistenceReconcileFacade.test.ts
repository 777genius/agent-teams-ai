import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  recordOwnedUnixProcessGroup,
  recordVerifiedCliProcessRelease,
} from '@main/utils/cliProcessCustody';
import { getTeamsBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as launchWrites from '../../atomicWrite';
import { createPersistedLaunchSnapshot } from '../../TeamLaunchStateEvaluator';
import { TeamLaunchStateStore } from '../../TeamLaunchStateStore';
import { captureLegacyNativeStopPublication } from '../LegacyNativeStopPublication';
import { captureLegacyNativeStop, readLegacyNativeStopRelease } from '../LegacyNativeStopRelease';
import { TeamProvisioningLaunchStateStoreBoundary } from '../TeamProvisioningLaunchStateStoreBoundary';
import {
  createTeamProvisioningLiveLaunchSnapshotBoundary,
  type TeamProvisioningLiveLaunchSnapshotRun,
} from '../TeamProvisioningLiveLaunchSnapshotBoundaryFactory';
import { type TeamProvisioningPersistedLaunchReconcilePortsInput } from '../TeamProvisioningPersistedLaunchReconcilePorts';
import {
  createTeamProvisioningPersistenceReconcileFacadeFromService,
  TeamProvisioningPersistenceReconcileFacade,
  type TeamProvisioningPersistenceReconcileFacadePorts,
  type TeamProvisioningPersistenceReconcileFacadeServiceHost,
  type TeamProvisioningPersistenceReconcileRun,
} from '../TeamProvisioningPersistenceReconcileFacade';
import { createTeamProvisioningPrimaryBootstrapTruthReportingBoundary } from '../TeamProvisioningPrimaryBootstrapTruthReportingPortsFactory';

import type { LegacyNativeStopRun } from '../LegacyNativeStopRelease';
import type {
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  TeamMember,
} from '@shared/types';
import type { ChildProcess } from 'node:child_process';

const at = '2026-01-01T00:00:00.000Z';

interface TestRun extends TeamProvisioningPersistenceReconcileRun {
  startedAt: string;
}

function member(
  name: string,
  overrides: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name,
    launchState: 'starting',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    lastEvaluatedAt: at,
    ...overrides,
  };
}

function snapshot(input: {
  members: Record<string, PersistedTeamLaunchMemberState>;
  expectedMembers?: readonly string[];
  updatedAt?: string;
}): PersistedTeamLaunchSnapshot {
  return createPersistedLaunchSnapshot({
    teamName: 'demo',
    expectedMembers: input.expectedMembers ?? Object.keys(input.members),
    launchPhase: 'active',
    members: input.members,
    updatedAt: input.updatedAt ?? at,
  });
}

function run(overrides: Partial<TestRun> = {}): TestRun {
  return {
    teamName: 'demo',
    runId: 'run-1',
    isLaunch: true,
    provisioningComplete: false,
    startedAt: at,
    ...overrides,
  };
}

function createPorts<TRun extends TestRun = TestRun>(
  overrides: Partial<TeamProvisioningPersistenceReconcileFacadePorts<TRun>> = {}
): TeamProvisioningPersistenceReconcileFacadePorts<TRun> {
  const launchStateStoreBoundary: TeamProvisioningPersistenceReconcileFacadePorts<TRun>['launchStateStoreBoundary'] =
    {
      clearPersistedLaunchState: vi.fn(async () => undefined),
      canClearPersistedLaunchStateForRun: vi.fn(() => true),
      clearPersistedLaunchStateNow: vi.fn(async () => undefined),
      writeLaunchStateSnapshot: vi.fn(
        async (_teamName: string, launchSnapshot: PersistedTeamLaunchSnapshot) => launchSnapshot
      ),
      writeLaunchStateSnapshotNow: vi.fn(
        async (_teamName: string, launchSnapshot: PersistedTeamLaunchSnapshot) => ({
          snapshot: launchSnapshot,
          wrote: true,
        })
      ),
      isLaunchStateNoopRefreshDue: vi.fn(() => false),
      enqueue: vi.fn(<T>(_teamName: string, operation: () => Promise<T>) =>
        operation()
      ) as TeamProvisioningPersistenceReconcileFacadePorts<TRun>['launchStateStoreBoundary']['enqueue'],
    };
  return {
    launchStateStoreBoundary,
    readLaunchState: vi.fn(async () => null),
    getRun: vi.fn(() => undefined),
    readMembersMeta: vi.fn(async () => []),
    overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState: vi.fn(async () => undefined),
    buildLiveLaunchSnapshotForRun: vi.fn(() => null),
    invalidateRuntimeSnapshotCaches: vi.fn(() => undefined),
    reconcile: {
      getTrackedRunId: vi.fn(() => 'run-1'),
      recoverStaleMixedSecondaryLaunchSnapshot: vi.fn(async () => null),
      applyOpenCodeSecondaryEvidenceOverlay: vi.fn(
        async (input: { snapshot: PersistedTeamLaunchSnapshot }) => input.snapshot
      ),
      applyOpenCodeSecondaryBootstrapStallOverlay: vi.fn(
        (launchSnapshot: PersistedTeamLaunchSnapshot | null) => launchSnapshot
      ),
      getLiveTeamAgentRuntimeMetadata: vi.fn(async () => new Map()),
      readPersistedRuntimeMembers: vi.fn(() => []),
      resolveExpectedLaunchMemberName: vi.fn(
        (expectedMembers: readonly string[] | undefined, candidateName: string) =>
          expectedMembers?.find((memberName) => memberName === candidateName) ?? null
      ),
      findBootstrapRuntimeProofObservedAt: vi.fn(async () => null),
      findBootstrapTranscriptOutcome: vi.fn(async () => null),
    },
    ...overrides,
  };
}

describe('TeamProvisioningPersistenceReconcileFacade', () => {
  it('persists run launch snapshots through the queued boundary and filters removed members', async () => {
    const rawSnapshot = snapshot({
      expectedMembers: ['Builder', 'Removed'],
      members: {
        Builder: member('Builder'),
        Removed: member('Removed'),
      },
    });
    const metaMembers: TeamMember[] = [
      { name: 'Builder', joinedAt: 1 },
      { name: 'Removed', joinedAt: 1, removedAt: 2 },
    ];
    const ports = createPorts({
      readMembersMeta: vi.fn(async () => metaMembers),
      buildLiveLaunchSnapshotForRun: vi.fn(() => rawSnapshot),
    });
    const facade = new TeamProvisioningPersistenceReconcileFacade(ports);
    const targetRun = run();

    const result = await facade.persistLaunchStateSnapshot(targetRun, 'finished');

    expect(ports.launchStateStoreBoundary.enqueue).toHaveBeenCalledWith(
      'demo',
      expect.any(Function),
      {
        coalesce: { subject: targetRun, key: 'persist-launch-snapshot:finished' },
      }
    );
    expect(
      ports.overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState
    ).toHaveBeenCalledWith(targetRun);
    expect(ports.buildLiveLaunchSnapshotForRun).toHaveBeenCalledWith(targetRun, 'finished');
    const [writeCall] = vi.mocked(ports.launchStateStoreBoundary.writeLaunchStateSnapshotNow).mock
      .calls as [[string, PersistedTeamLaunchSnapshot, { allowNoopSkip: true; runId: string }]];
    const writtenSnapshot = writeCall[1];
    expect(writtenSnapshot.expectedMembers).toEqual(['Builder']);
    expect(Object.keys(writtenSnapshot.members)).toEqual(['Builder']);
    expect(ports.launchStateStoreBoundary.writeLaunchStateSnapshotNow).toHaveBeenCalledWith(
      'demo',
      writtenSnapshot,
      { allowNoopSkip: true, runId: 'run-1', metaMembers }
    );
    expect(ports.invalidateRuntimeSnapshotCaches).toHaveBeenCalledWith('demo');
    expect(result).toBe(writtenSnapshot);
  });

  it('clears persisted launch state instead of writing absent or finished clean snapshots', async () => {
    const cleanSnapshot = snapshot({
      members: {
        Builder: member('Builder', {
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
        }),
      },
    });
    const ports = createPorts();
    const facade = new TeamProvisioningPersistenceReconcileFacade(ports);

    await expect(facade.persistLaunchStateSnapshot(run(), 'active')).resolves.toBeNull();
    expect(ports.launchStateStoreBoundary.clearPersistedLaunchStateNow).toHaveBeenCalledWith(
      'demo',
      { expectedRunId: 'run-1' }
    );
    expect(ports.launchStateStoreBoundary.writeLaunchStateSnapshotNow).not.toHaveBeenCalled();

    vi.mocked(ports.buildLiveLaunchSnapshotForRun).mockReturnValue(cleanSnapshot);
    const published = await facade.persistLaunchStateSnapshot(run(), 'finished');
    expect(published).toMatchObject({
      teamLaunchState: 'clean_success',
      summary: { confirmedCount: 1, pendingCount: 0 },
      members: { Builder: { launchState: 'confirmed_alive', bootstrapConfirmed: true } },
    });

    expect(ports.launchStateStoreBoundary.clearPersistedLaunchStateNow).toHaveBeenCalledTimes(2);
    expect(ports.launchStateStoreBoundary.writeLaunchStateSnapshotNow).not.toHaveBeenCalled();
  });

  it.each(['successor', 'stop'])(
    'does not resurrect cleaned success during a %s in final reporting',
    async (transition) => {
      const clean = {
        ...snapshot({
          members: {
            Builder: member('Builder', {
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
            }),
          },
        }),
        launchPhase: 'finished' as const,
      };
      let disk: PersistedTeamLaunchSnapshot | null = clean;
      const ports = createPorts({ buildLiveLaunchSnapshotForRun: vi.fn(() => clean) });
      vi.mocked(ports.launchStateStoreBoundary.clearPersistedLaunchStateNow).mockImplementation(
        async () => {
          disk = null;
        }
      );
      const facade = new TeamProvisioningPersistenceReconcileFacade(ports);
      const target = {
        ...run(),
        effectiveMembers: [{ name: 'Builder' }],
        memberSpawnStatuses: new Map(),
      };
      const evidence = await facade.persistLaunchStateSnapshot(target, 'finished');
      expect(evidence?.teamLaunchState).toBe('clean_success');
      expect(disk).toBeNull();
      let completeRead!: (value: PersistedTeamLaunchSnapshot) => void;
      const writeLaunchStateSnapshot = vi.fn(
        async (_team: string, next: PersistedTeamLaunchSnapshot) => {
          disk = next;
          return next;
        }
      );
      const reporting = createTeamProvisioningPrimaryBootstrapTruthReportingBoundary({
        service: {
          isOpenCodeSecondaryLaneMemberInRun: () => false,
          syncMemberTaskActivityForRuntimeTransition: vi.fn(),
          syncMemberLaunchGraceCheck: vi.fn(),
          syncRunMemberSpawnStatusesFromSnapshot: vi.fn(),
        },
        readBootstrapLaunchSnapshot: () =>
          new Promise((resolve) => {
            completeRead = resolve;
          }),
        writeLaunchStateSnapshot,
        nowIso: () => '2026-01-01T00:00:02.000Z',
        logger: { warn: vi.fn() },
      });
      const finishing = reporting.reconcileFinalLaunchReportingSnapshot(target, evidence);
      const successor =
        transition === 'successor' ? snapshot({ members: { Builder: member('Builder') } }) : null;
      disk = successor;
      completeRead(clean);
      const result = await finishing;
      expect(result).not.toBe(evidence);
      expect(result?.teamLaunchState).toBe('clean_success');
      expect(writeLaunchStateSnapshot).not.toHaveBeenCalled();
      expect(disk).toBe(successor);
    }
  );

  it('passes facade-owned persistence ports into the reconcile runner', async () => {
    const persistedSnapshot = snapshot({
      members: {
        Builder: member('Builder'),
      },
    });
    const runPersistedLaunchReconcile = vi.fn(
      async (_teamName: string, input: TeamProvisioningPersistedLaunchReconcilePortsInput) => {
        await expect(input.readLaunchState('demo')).resolves.toBe(persistedSnapshot);
        await expect(input.readMembersMeta('demo')).resolves.toEqual([]);
        expect(input.getTrackedRunId('demo')).toBe('run-1');
        await input.writeLaunchStateSnapshot('demo', persistedSnapshot, { runId: 'run-1' });
        await input.clearPersistedLaunchState('demo', { expectedRunId: 'run-1' });
        return { snapshot: persistedSnapshot, statuses: {} };
      }
    );
    const ports = createPorts({
      readLaunchState: vi.fn(async () => persistedSnapshot),
      runPersistedLaunchReconcile,
    });
    const facade = new TeamProvisioningPersistenceReconcileFacade(ports);

    await expect(facade.reconcilePersistedLaunchState('demo')).resolves.toEqual({
      snapshot: persistedSnapshot,
      statuses: {},
    });

    expect(runPersistedLaunchReconcile).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({
        readLaunchState: expect.any(Function),
        readMembersMeta: expect.any(Function),
        writeLaunchStateSnapshot: expect.any(Function),
        clearPersistedLaunchState: expect.any(Function),
        getTrackedRunId: expect.any(Function),
      })
    );
    expect(ports.launchStateStoreBoundary.writeLaunchStateSnapshot).toHaveBeenCalledWith(
      'demo',
      persistedSnapshot,
      { runId: 'run-1' }
    );
    expect(ports.launchStateStoreBoundary.clearPersistedLaunchState).toHaveBeenCalledWith('demo', {
      expectedRunId: 'run-1',
    });
  });

  it('wires the tracked run of the service into the reconcile ports', async () => {
    const basePorts = createPorts();
    const getTrackedRunId = vi.fn(() => 'run-tracked');
    const service = {
      ...basePorts.reconcile,
      getTrackedRunId,
      runs: new Map<string, TestRun>(),
      launchStateStore: { read: async () => null },
      membersMetaStore: { getMembers: async () => [] },
      launchStateStoreBoundary: basePorts.launchStateStoreBoundary,
      primaryBootstrapTruthReporting: {
        overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState: async () => undefined,
      },
      buildLiveLaunchSnapshotForRun: () => null,
      invalidateRuntimeSnapshotCaches: vi.fn(),
    } satisfies TeamProvisioningPersistenceReconcileFacadeServiceHost<TestRun>;

    const facade = createTeamProvisioningPersistenceReconcileFacadeFromService(service);
    await facade.reconcilePersistedLaunchState('demo');

    expect(getTrackedRunId).toHaveBeenCalledWith('demo');
  });

  describe('persistLaunchStateSnapshot coalescing through a real boundary', () => {
    function createRealBoundary(): TeamProvisioningLaunchStateStoreBoundary {
      return new TeamProvisioningLaunchStateStoreBoundary({
        launchStateStore: {
          read: vi.fn(async () => null),
          write: vi.fn(async () => true),
          clear: vi.fn(async () => undefined),
        },
        membersMetaStore: { getMembers: vi.fn(async () => []) },
        getTrackedRunId: vi.fn(() => 'run-1'),
        applyOpenCodeSecondaryEvidenceOverlay: vi.fn(async ({ snapshot: input }) => input),
        applyBootstrapStallOverlay: vi.fn(() => null),
        areSnapshotsSemanticallyEqual: vi.fn(() => false),
        clearBootstrapState: vi.fn(async () => undefined),
        invalidateRuntimeSnapshotCaches: vi.fn(() => undefined),
        logDebug: vi.fn(() => undefined),
        nowMs: vi.fn(() => Date.parse(at)),
      });
    }

    function deferred<T = void>(): {
      promise: Promise<T>;
      resolve(value: T | PromiseLike<T>): void;
    } {
      let resolve!: (value: T | PromiseLike<T>) => void;
      const promise = new Promise<T>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    }

    it('collapses two synchronous requests for the same run and phase into a single build', async () => {
      const gate = deferred<void>();
      const overlay = vi.fn(async () => {
        await gate.promise;
      });
      const buildLiveLaunchSnapshotForRun = vi.fn(() =>
        snapshot({ members: { Builder: member('Builder') } })
      );
      const facade = new TeamProvisioningPersistenceReconcileFacade<TestRun>({
        launchStateStoreBoundary: createRealBoundary(),
        readLaunchState: vi.fn(async () => null),
        getRun: vi.fn(() => undefined),
        readMembersMeta: vi.fn(async () => []),
        overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState: overlay,
        buildLiveLaunchSnapshotForRun,
        invalidateRuntimeSnapshotCaches: vi.fn(),
        reconcile: {} as TeamProvisioningPersistenceReconcileFacadePorts<TestRun>['reconcile'],
      });
      const targetRun = run();

      const first = facade.persistLaunchStateSnapshot(targetRun, 'finished');
      const second = facade.persistLaunchStateSnapshot(targetRun, 'finished');
      gate.resolve();
      await Promise.all([first, second]);

      expect(overlay).toHaveBeenCalledTimes(1);
      expect(buildLiveLaunchSnapshotForRun).toHaveBeenCalledTimes(1);
    });

    it('does not collapse requests for the same run with different phases', async () => {
      const overlay = vi.fn(async () => undefined);
      const buildLiveLaunchSnapshotForRun = vi.fn(() =>
        snapshot({ members: { Builder: member('Builder') } })
      );
      const facade = new TeamProvisioningPersistenceReconcileFacade<TestRun>({
        launchStateStoreBoundary: createRealBoundary(),
        readLaunchState: vi.fn(async () => null),
        getRun: vi.fn(() => undefined),
        readMembersMeta: vi.fn(async () => []),
        overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState: overlay,
        buildLiveLaunchSnapshotForRun,
        invalidateRuntimeSnapshotCaches: vi.fn(),
        reconcile: {} as TeamProvisioningPersistenceReconcileFacadePorts<TestRun>['reconcile'],
      });
      const targetRun = run();

      const first = facade.persistLaunchStateSnapshot(targetRun, 'finished');
      const second = facade.persistLaunchStateSnapshot(targetRun, 'active');
      await Promise.all([first, second]);

      expect(overlay).toHaveBeenCalledTimes(2);
      expect(buildLiveLaunchSnapshotForRun).toHaveBeenCalledTimes(2);
    });
  });
});

describe.skipIf(process.platform === 'win32')(
  'owned solo publication through the real Main snapshot and store owners',
  () => {
    const roots: string[] = [];
    afterEach(async () => {
      vi.restoreAllMocks();
      setClaudeBasePathOverride(null);
      await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function fixture() {
      const root = await mkdtemp(join(tmpdir(), 'TEST-solo-launch-publication-'));
      roots.push(root);
      setClaudeBasePathOverride(root);
      const teamsBasePath = getTeamsBasePath();
      const teamName = 'TEST-solo',
        teamDir = join(teamsBasePath, teamName);
      await mkdir(teamDir, { recursive: true });
      const child = { pid: 44101, exitCode: null, signalCode: null, killed: false } as ChildProcess;
      const identity = {
        pid: child.pid!,
        parentPid: 1,
        processGroupId: child.pid!,
        startIdentity: 'TEST-original-birth',
      };
      recordOwnedUnixProcessGroup(child, identity);
      const target: TestRun & TeamProvisioningLiveLaunchSnapshotRun & LegacyNativeStopRun = {
        ...run(),
        teamName,
        runId: 'TEST-original-run',
        isLaunch: false,
        child,
        provisioningComplete: true,
        detectedSessionId: 'TEST-original-session',
        expectedMembers: [],
        allEffectiveMembers: [],
        mixedSecondaryLanes: [],
        request: { providerId: 'anthropic', members: [] },
        cancelRequested: false,
        processKilled: false,
        processClosed: false,
        memberSpawnStatuses: new Map(),
      };
      const current: { run: typeof target | undefined } = { run: target };
      await writeFile(
        join(teamDir, 'config.json'),
        JSON.stringify({
          name: teamName,
          leadAgentId: `team-lead@${teamName}`,
          leadSessionId: target.detectedSessionId,
          members: [
            {
              name: 'team-lead',
              agentType: 'team-lead',
              agentId: `team-lead@${teamName}`,
              providerId: 'anthropic',
            },
          ],
        })
      );
      await writeFile(
        join(teamDir, 'team.meta.json'),
        JSON.stringify({
          version: 1,
          cwd: '/TEST/workspace',
          createdAt: 1,
        })
      );
      await writeFile(
        join(teamDir, 'members.meta.json'),
        JSON.stringify({ version: 1, members: [] })
      );

      const store = new TeamLaunchStateStore();
      const boundary = new TeamProvisioningLaunchStateStoreBoundary({
        launchStateStore: store,
        membersMetaStore: { getMembers: async () => [] },
        getTrackedRunId: () => current.run?.runId,
        applyOpenCodeSecondaryEvidenceOverlay: async ({ snapshot: value }) => value,
        applyBootstrapStallOverlay: (value) => value,
        areSnapshotsSemanticallyEqual: () => false,
        clearBootstrapState: async () => undefined,
        invalidateRuntimeSnapshotCaches: () => undefined,
        logDebug: () => undefined,
        nowMs: () => Date.now(),
      });
      const live = createTeamProvisioningLiveLaunchSnapshotBoundary<typeof target>({
        getPersistedLaunchMemberNames: (value) => value.expectedMembers,
        pauseMemberTaskActivityForRuntimeLoss: () => undefined,
        buildMixedPersistedLaunchSnapshotForRun: () => null,
        buildRuntimeSpawnStatusRecord: (value) => Object.fromEntries(value.memberSpawnStatuses),
        invalidateMemberSpawnStatusesCache: () => undefined,
        emitTeamChange: () => undefined,
        getRun: () => current.run,
        maybeFireTeamLaunchedNotificationWhenAllMembersJoined: async () => undefined,
      });
      const ports = createPorts<typeof target>({
        launchStateStoreBoundary: boundary,
        readLaunchState: (name) => store.read(name),
        getRun: (id) => (current.run?.runId === id ? current.run : undefined),
        buildLiveLaunchSnapshotForRun: (value, phase) =>
          live.buildLiveLaunchSnapshotForRun(value, phase),
      });
      ports.reconcile.getTrackedRunId = () => current.run?.runId;
      const facade = new TeamProvisioningPersistenceReconcileFacade(ports);
      return {
        teamName,
        teamDir,
        teamsBasePath,
        child,
        identity,
        run: target,
        current,
        store,
        ports,
        facade,
      };
    }

    it('publishes an original solo Create, retains live reads, and enables only its exact owned Stop proof', async () => {
      const f = await fixture();
      expect(await f.store.readResult(f.teamName)).toEqual({ status: 'absent' });
      // No test writes launch-state/freshness: this is the same real composition as Main.
      await f.facade.persistLaunchStateSnapshot(f.run, 'finished');
      await f.facade.persistLaunchStateSnapshot(f.run, 'finished');
      expect(await f.store.read(f.teamName)).toMatchObject({
        version: 2,
        publicationRunId: f.run.runId,
        leadSessionId: f.run.detectedSessionId,
        launchPhase: 'finished',
        expectedMembers: [],
        members: {},
        teamLaunchState: 'clean_success',
      });
      expect(JSON.parse(await readFile(join(f.teamDir, 'launch-freshness.json'), 'utf8'))).toEqual({
        version: 1,
        teamName: f.teamName,
        kind: 'launch',
        runId: f.run.runId,
      });
      const session = f.run.detectedSessionId,
        runId = f.run.runId;
      f.run.detectedSessionId = 'TEST-foreign-session';
      expect(captureLegacyNativeStop(f.teamsBasePath, f.run, () => true)).toBeNull();
      f.run.detectedSessionId = session;
      f.run.runId = 'TEST-foreign-run';
      expect(captureLegacyNativeStop(f.teamsBasePath, f.run, () => true)).toBeNull();
      f.run.runId = runId;
      const captured = captureLegacyNativeStop(f.teamsBasePath, f.run, () => true);
      expect(captured).not.toBeNull();
      expect(captured!.complete()).toBeNull();
      const stop = captureLegacyNativeStopPublication({
        teamsBasePath: f.teamsBasePath,
        run: f.run,
        current: () =>
          f.current.run === f.run && f.run.runId === runId && f.run.detectedSessionId === session,
        beginStop: (name) => f.store.beginStop(name),
        publishStopped: async (name, authority, proof) => {
          await f.store.markStopped(name, authority, proof);
          return readLegacyNativeStopRelease(f.teamDir, name) !== null;
        },
      });
      expect(stop).not.toBeNull();
      recordVerifiedCliProcessRelease(f.child, [f.identity]);
      f.child.exitCode = 0;
      f.run.processClosed = true;
      expect(await stop!.complete()).toBe(true);
      expect(readLegacyNativeStopRelease(f.teamDir, f.teamName)).toMatchObject({
        target: { teamName: f.teamName, runId, sessionId: session, rootPid: f.child.pid },
        process: { rootStartIdentity: f.identity.startIdentity },
      });
      expect(await f.store.readResult(f.teamName)).toEqual({ status: 'absent' });
      await f.facade.persistLaunchStateSnapshot(f.run, 'finished');
      expect(await f.store.readResult(f.teamName)).toEqual({ status: 'absent' });
    });

    it.each(['stop', 'replacement', 'session', 'cancelled', 'closed', 'custody'] as const)(
      'refuses a solo completion whose original %s changes during the first await',
      async (change) => {
        const f = await fixture();
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        f.ports.overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState = async () => {
          entered();
          await gate;
        };
        const pending = f.facade.persistLaunchStateSnapshot(f.run, 'finished');
        await started;
        if (change === 'stop') await f.store.markStopped(f.teamName);
        if (change === 'replacement') f.current.run = { ...f.run };
        if (change === 'session') f.run.detectedSessionId = 'TEST-successor-session';
        if (change === 'cancelled') f.run.cancelRequested = true;
        if (change === 'closed') f.run.processClosed = true;
        if (change === 'custody')
          recordOwnedUnixProcessGroup(f.child, {
            ...f.identity,
            startIdentity: 'TEST-replaced-birth',
          });
        release();
        expect(await pending).toBeNull();
        expect(await f.store.readResult(f.teamName)).toEqual({ status: 'absent' });
        if (change !== 'stop')
          await expect(readFile(join(f.teamDir, 'launch-freshness.json'))).rejects.toMatchObject({
            code: 'ENOENT',
          });
      }
    );

    it('rolls back the real solo publication if ownership changes after its first file commit', async () => {
      const f = await fixture();
      const write = launchWrites.atomicWriteAsync;
      vi.spyOn(launchWrites, 'atomicWriteAsync').mockImplementation(
        async (path, content, options) => {
          await write(path, content, options);
          if (path === join(f.teamDir, 'launch-state.json')) f.current.run = { ...f.run };
        }
      );
      expect(await f.facade.persistLaunchStateSnapshot(f.run, 'finished')).toBeNull();
      for (const file of ['launch-state.json', 'launch-summary.json', 'launch-freshness.json']) {
        await expect(readFile(join(f.teamDir, file))).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(captureLegacyNativeStop(f.teamsBasePath, f.run, () => true)).toBeNull();
    });

    it('keeps unreadable solo roster metadata unknown instead of authorizing an empty roster', async () => {
      const f = await fixture();
      f.ports.readMembersMeta = async () => {
        throw new Error('TEST metadata unavailable');
      };
      expect(await f.facade.persistLaunchStateSnapshot(f.run, 'finished')).toBeNull();
      expect(await f.store.readResult(f.teamName)).toEqual({ status: 'absent' });
      await expect(readFile(join(f.teamDir, 'launch-freshness.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  }
);
