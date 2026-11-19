// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemberWorkSyncTeamOperationGate } from '../../../../src/features/member-work-sync/core/application/MemberWorkSyncTeamOperationGate';
import {
  captureLegacySourceReadFence,
  createLegacySourceWorkSyncAdmission,
  withLegacySourceReadFence,
} from '../../../../src/features/member-work-sync/main/composition/legacySourceWorkSyncAdmission';
import { MemberWorkSyncEventQueue } from '../../../../src/features/member-work-sync/main/infrastructure/MemberWorkSyncEventQueue';
import { QuiescingMemberWorkSyncAuditJournal } from '../../../../src/features/member-work-sync/main/infrastructure/QuiescingMemberWorkSyncAuditJournal';
import {
  captureDesktopNativeStopWorkSyncFence,
  createDesktopWorkSyncSourceAdmission,
} from '../../../../src/main/composition/createDesktopStoppedImportContext';
import { readLegacyNativeStopRelease } from '../../../../src/main/services/team/provisioning/LegacyNativeStopRelease';
import {
  prepareNativeStopTeamFlow,
  stopTeamFlow,
} from '../../../../src/main/services/team/provisioning/TeamProvisioningStopFlow';
import { TeamProvisioningTransientRunState } from '../../../../src/main/services/team/provisioning/TeamProvisioningTransientRunState';
import { TeamLaunchStateStore } from '../../../../src/main/services/team/TeamLaunchStateStore';
import { readTeamLaunchFreshness } from '../../../../src/main/services/team/TeamLaunchFreshness';
import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import { TeamTaskWriter } from '../../../../src/main/services/team/TeamTaskWriter';
import {
  recordOwnedUnixProcessGroup,
  recordVerifiedCliProcessRelease,
} from '../../../../src/main/utils/cliProcessCustody';
import {
  getTasksBasePath,
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';

import type { MemberWorkSyncTeamOperationAdmission } from '../../../../src/features/member-work-sync/core/application/MemberWorkSyncTeamOperationGate';
import type { LegacyNativeStopPublication } from '../../../../src/main/services/team/provisioning/LegacyNativeStopPublication';
import type { LegacyNativeStopRun } from '../../../../src/main/services/team/provisioning/LegacyNativeStopRelease';
import type {
  TeamProvisioningStopRun,
  TeamProvisioningStopTeamPorts,
} from '../../../../src/main/services/team/provisioning/TeamProvisioningStopFlow';
import type { ChildProcess } from 'node:child_process';

const roots: string[] = [];
const queues: MemberWorkSyncEventQueue[] = [];
const pendingStops: Promise<void>[] = [];
const barriers: (() => void)[] = [];
afterEach(async () => {
  for (const release of barriers.splice(0)) release();
  for (const queue of queues.splice(0)) await queue.stop();
  await Promise.allSettled(pendingStops.splice(0));
  setClaudeBasePathOverride(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  barriers.push(resolve);
  return { promise, resolve };
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-native-stop-ordering-')));
  roots.push(root);
  setClaudeBasePathOverride(root);
  const teamName = 'test-original-solo',
    teamDir = join(getTeamsBasePath(), teamName);
  mkdirSync(teamDir, { recursive: true });
  const write = (file: string, value: unknown) =>
    writeFileSync(join(teamDir, file), JSON.stringify(value));
  const child = { pid: 44101 } as ChildProcess;
  const processIdentity = {
    pid: 44101,
    parentPid: 1,
    processGroupId: 44101,
    startIdentity: 'TEST-original-birth',
  };
  recordOwnedUnixProcessGroup(child, processIdentity);
  const run = {
    teamName,
    runId: 'TEST-original-run',
    child,
    detectedSessionId: 'TEST-original-session',
    expectedMembers: [],
    allEffectiveMembers: [],
    mixedSecondaryLanes: [],
    request: { providerId: 'anthropic', members: [] },
    anthropicApiKeyHelper: null,
    processKilled: false,
    cancelRequested: false,
    onProgress: vi.fn(),
  } satisfies LegacyNativeStopRun & TeamProvisioningStopRun;
  write('config.json', {
    name: teamName,
    leadAgentId: `team-lead@${teamName}`,
    leadSessionId: run.detectedSessionId,
    sessionHistory: [run.detectedSessionId],
    language: 'en',
    projectPathHistory: ['/TEST/project'],
    members: [
      {
        name: 'team-lead',
        agentType: 'team-lead',
        agentId: `team-lead@${teamName}`,
        providerId: 'anthropic',
      },
    ],
  });
  write('members.meta.json', { version: 1, members: [] });
  write('team.meta.json', { version: 1, cwd: '/TEST/project', createdAt: 1 });
  write('launch-state.json', {
    version: 2,
    teamName,
    publicationRunId: run.runId,
    leadSessionId: run.detectedSessionId,
    expectedMembers: [],
    members: {},
  });
  write('launch-freshness.json', { version: 1, teamName, kind: 'launch', runId: run.runId });
  const runs = new Map([[run.runId, run]]),
    tracked = new Map([[teamName, run.runId]]);
  // Only the team-lock port is used; its actual reentrant ownership implementation executes below.
  const lock = new TeamProvisioningTransientRunState({ teamOpLocks: new Map() } as never);
  const events: string[] = [],
    drainEntered = deferred();
  const gate = new MemberWorkSyncTeamOperationGate();
  let ownerCurrent = true;
  const policy = createDesktopWorkSyncSourceAdmission(
    {
      withTeamIdentityFence: (_name, operation) => operation(),
    },
    () => ownerCurrent
  );
  const source = createLegacySourceWorkSyncAdmission(gate, policy);
  let work: (admission: MemberWorkSyncTeamOperationAdmission) => Promise<void> = async () =>
    undefined;
  let auditWork: () => Promise<void> = async () => undefined;
  const audit = new QuiescingMemberWorkSyncAuditJournal({ append: () => auditWork() });
  const queue = new MemberWorkSyncEventQueue({
    captureExecutionScope: source.bindExecution,
    quietWindowMs: 0,
    isTeamActive: () => false,
    reconcileInactiveTeams: true,
    reconcile: (request) => source.run(request.teamName, work),
    maxRetryAttempts: 0,
  });
  queues.push(queue);
  const fencePorts = {
    gate,
    ingress: source,
    queue,
    audit,
    router: { awaitTeamIdle: async () => undefined },
    isCurrent: () => ownerCurrent,
  };
  const feature = {
    captureNativeStopFence: (name: string) => captureLegacySourceReadFence(name, fencePorts),
  };
  let currentFeature: typeof feature | null = feature;
  const ports: TeamProvisioningStopTeamPorts<typeof run> = {
    cancelOpenCodePromptDeliveries: vi.fn(async () => undefined),
    invalidateRuntimeSnapshotCaches: vi.fn(),
    pauseActiveIntervalsForTeam: vi.fn(() => {
      events.push('pause-original');
    }),
    stopPersistentTeamMembers: vi.fn(),
    openCodeRuntimeDeliveryAdvisory: { cancelTeam: vi.fn() },
    getTrackedRunId: (name) => tracked.get(name) ?? null,
    getAliveRunId: (name) => tracked.get(name) ?? null,
    runs,
    runtimeAdapterProgressByRunId: new Map(),
    isCancellableRuntimeAdapterProgress: () => false,
    cancelRuntimeAdapterProvisioning: async () => undefined,
    cleanupAnthropicApiKeyHelperMaterialForStoppedTeam: async () => undefined,
    runtimeAdapterRunByTeam: new Map(),
    withTeamLock: (name, operation) => lock.withTeamLock(name, operation),
    stopOpenCodeRuntimeAdapterTeam: async () => undefined,
    hasSecondaryRuntimeRuns: () => false,
    stopMixedSecondaryRuntimeLanes: async () => undefined,
    provisioningRunByTeam: tracked,
    deleteAliveRunId: (name) => {
      tracked.delete(name);
    },
    killTeamProcess: vi.fn(),
    killTeamProcessAndWait: vi.fn(async () => {
      events.push('native-stop-once');
      recordVerifiedCliProcessRelease(child, [processIdentity]);
    }),
    updateProgress: (current, state, message) => ({
      runId: current.runId,
      teamName,
      state,
      message,
      startedAt: '2026-11-19T03:00:00.000Z',
      updatedAt: '2026-11-19T03:00:00.000Z',
    }),
    cleanupRun: vi.fn((old) => {
      events.push('cleanup-original');
      if (runs.get(old.runId) === old) runs.delete(old.runId);
      if (tracked.get(teamName) === old.runId) tracked.delete(teamName);
    }),
    logger: { info: vi.fn() },
  };
  // Use the real public Stop, existing compatibility facade, native flow, publication
  // store and custody reader. The only native process is the original synthetic child.
  const service: Pick<TeamProvisioningService, 'stopTeam'> = Object.create(
    TeamProvisioningService.prototype
  );
  Object.assign(service, {
    stopTeamGenerationByTeam: new Map(),
    runs,
    runtimeAdapterRunByTeam: ports.runtimeAdapterRunByTeam,
    runTracking: { getTrackedRunId: ports.getTrackedRunId },
    getSecondaryRuntimeRuns: () => [],
    withTeamLock: ports.withTeamLock,
    captureNativeStopSourceFence: (name: string) => {
      const original = captureDesktopNativeStopWorkSyncFence(() => currentFeature, name)!;
      return {
        ...original,
        async drain() {
          events.push('drain-unlocked');
          drainEntered.resolve();
          await original.drain();
        },
      };
    },
    stopFlowBoundaryValue: {
      stopTeam: (name: string, publication?: LegacyNativeStopPublication) =>
        stopTeamFlow(name, ports, publication),
      prepareNativeStop: (name: string, publication: LegacyNativeStopPublication) =>
        prepareNativeStopTeamFlow(name, ports, publication),
    },
  });
  return {
    root,
    teamName,
    teamDir,
    run,
    runs,
    tracked,
    lock,
    gate,
    source,
    queue,
    policy,
    ports,
    events,
    service,
    stop() {
      const result = service.stopTeam(teamName);
      pendingStops.push(result);
      void result.catch(() => undefined);
      return result;
    },
    drainEntered,
    fencePorts,
    audit,
    write,
    store: new TeamLaunchStateStore(),
    readProof: () => readLegacyNativeStopRelease(teamDir, teamName),
    setWork: (next: typeof work) => {
      work = next;
    },
    setAudit: (next: typeof auditWork) => {
      auditWork = next;
    },
    replaceFeature: () => {
      currentFeature = { captureNativeStopFence: feature.captureNativeStopFence };
    },
    revokeOwner: () => {
      ownerCurrent = false;
    },
    async enqueue(delay = 0) {
      await source.scan([teamName], async () => {
        expect(
          queue.enqueue({
            teamName,
            memberName: 'team-lead',
            triggerReason: 'manual_refresh',
            runAfterMs: delay,
          })
        ).toBe(true);
      });
    },
  };
}

describe.skipIf(process.platform === 'win32')(
  'original Main native Stop with owned WorkSync drain',
  () => {
    it('waits for physical writer and audit tails outside the lock, then publishes once and fences a queued original writer', async () => {
      const f = fixture(),
        entered = deferred(),
        physical = deferred(),
        auditEntered = deferred(),
        auditRelease = deferred();
      const oldExecution = f.source.captureExecution(f.teamName)!;
      f.setAudit(async () => {
        auditEntered.resolve();
        await auditRelease.promise;
      });
      f.setWork(async (admission) => {
        admission.trackSettling(
          physical.promise.then(() =>
            f.lock.withTeamLock(f.teamName, async () => {
              await f.policy.current(f.teamName).publish(async () => {
                f.write('team.meta.json', {
                  version: 1,
                  cwd: '/TEST/project',
                  createdAt: 1,
                  description: 'TEST product history',
                });
                f.events.push('physical-writer-settled');
              });
              void f.audit.append({
                timestamp: '2026-11-19T03:00:00.000Z',
                teamName: f.teamName,
                memberName: 'team-lead',
                event: 'team_inactive',
                source: 'reconciler',
              });
            })
          )
        );
        entered.resolve();
      });
      await f.enqueue();
      await entered.promise;
      let settled = false;
      const stopping = f.stop().then(() => {
        settled = true;
      });
      await f.drainEntered.promise;
      expect(f.ports.killTeamProcessAndWait).toHaveBeenCalledOnce();
      expect(f.events).toEqual([
        'pause-original',
        'native-stop-once',
        'pause-original',
        'drain-unlocked',
      ]);
      await f.lock.withTeamLock(f.teamName, async () => {
        expect(f.readProof()).toBeNull();
      });
      physical.resolve();
      await auditEntered.promise;
      expect(settled).toBe(false);
      expect(f.readProof()).toBeNull();
      auditRelease.resolve();
      await stopping;
      const proof = f.readProof();
      expect(proof?.target).toMatchObject({
        runId: f.run.runId,
        sessionId: f.run.detectedSessionId,
      });
      expect(f.ports.cleanupRun).toHaveBeenCalledOnce();
      expect(() => oldExecution.run(() => f.policy.current(f.teamName))).toThrow('read-only');
      expect(f.policy.capture(f.teamName).kind).toBe('read-only');
      await new TeamTaskWriter().createTask(f.teamName, {
        id: '1',
        subject: 'TEST task after Stop',
        description: '',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      });
      expect(
        JSON.parse(readFileSync(join(getTasksBasePath(), f.teamName, '1.json'), 'utf8')).subject
      ).toBe('TEST task after Stop');
      expect(f.readProof()).toEqual(proof);
    });

    it('drains an original queued job at its unchanged due time without parking it or admitting a new job', async () => {
      const f = fixture(),
        work = vi.fn(async () => undefined);
      f.setWork(work);
      await f.enqueue(40);
      const due = f.queue.getDiagnostics().nextRunAt;
      const stopping = f.stop();
      await f.drainEntered.promise;
      expect(f.queue.getDiagnostics().nextRunAt).toBe(due);
      await expect(
        f.source.run(f.teamName.toUpperCase(), async () => undefined)
      ).rejects.toMatchObject({ name: 'MemberWorkSyncTeamQuiescedError' });
      await stopping;
      expect(work).toHaveBeenCalledOnce();
      expect(f.queue.getDiagnostics()).toMatchObject({
        queued: 0,
        running: 0,
        reconciled: 1,
        quiesced: 0,
        dropped: 0,
      });
      expect(f.readProof()).not.toBeNull();
    });

    it('refuses an old Stop after a same-name successor acquires the unlocked drain interval', async () => {
      const f = fixture(),
        entered = deferred(),
        release = deferred();
      f.setWork(async () => {
        entered.resolve();
        await release.promise;
      });
      await f.enqueue();
      await entered.promise;
      const stopping = f.stop();
      const rejected = expect(stopping).rejects.toThrow('owner changed');
      await f.drainEntered.promise;
      const successor = {
        ...f.run,
        runId: 'TEST-successor-run',
        child: { pid: 44102 } as ChildProcess,
        detectedSessionId: 'TEST-successor-session',
      };
      await f.lock.withTeamLock(f.teamName, async () => {
        f.runs.set(successor.runId, successor);
        f.tracked.set(f.teamName, successor.runId);
        expect(await f.store.beginLaunch(f.teamName, successor.runId, [], () => true)).toBe(true);
      });
      release.resolve();
      await rejected;
      expect(f.ports.cleanupRun).not.toHaveBeenCalled();
      expect(f.ports.pauseActiveIntervalsForTeam).toHaveBeenCalledTimes(2);
      expect(f.ports.killTeamProcessAndWait).toHaveBeenCalledOnce();
      expect(f.runs.get(successor.runId)).toBe(successor);
      expect(await readTeamLaunchFreshness(f.teamName)).toMatchObject({
        kind: 'launch',
        runId: successor.runId,
      });
      expect(f.readProof()).toBeNull();
    });

    it('does not publish or clean after replacing the original WorkSync feature during drain', async () => {
      const f = fixture(),
        entered = deferred(),
        release = deferred();
      f.setWork(async () => {
        entered.resolve();
        await release.promise;
      });
      await f.enqueue();
      await entered.promise;
      const stopping = f.stop(),
        rejected = expect(stopping).rejects.toThrow('WorkSync owner changed');
      await f.drainEntered.promise;
      f.replaceFeature();
      release.resolve();
      await rejected;
      expect(f.ports.cleanupRun).not.toHaveBeenCalled();
      expect(f.readProof()).toBeNull();
      await expect(f.gate.run(f.teamName, async () => 'own closure released')).resolves.toBe(
        'own closure released'
      );
    });

    it('retains the original process witness for an explicit same-run Retry Stop after a partial stopped publication', async () => {
      const f = fixture(),
        entered = deferred(),
        release = deferred();
      f.setWork(async () => {
        entered.resolve();
        await release.promise;
      });
      await f.enqueue();
      await entered.promise;
      const first = f.stop(),
        rejected = expect(first).rejects.toThrow('WorkSync owner changed');
      await f.drainEntered.promise;
      f.replaceFeature();
      release.resolve();
      await rejected;
      expect(f.ports.killTeamProcessAndWait).toHaveBeenCalledOnce();
      await f.store.markStopped(f.teamName);
      expect(f.readProof()).toBeNull();
      expect(await readTeamLaunchFreshness(f.teamName)).toMatchObject({
        kind: 'stop',
        stoppedRunId: f.run.runId,
      });
      await f.stop();
      expect(f.readProof()?.target).toMatchObject({
        runId: f.run.runId,
        sessionId: f.run.detectedSessionId,
      });
      expect(f.ports.killTeamProcessAndWait).toHaveBeenCalledTimes(2);
      expect(f.ports.cleanupRun).toHaveBeenCalledOnce();
    });

    it('uses the same read fence for queued work and preserves an independent restore closure on refusal', async () => {
      const f = fixture(),
        other = f.gate.beginOwnedTeamQuiesce(f.teamName);
      await f.enqueue(5);
      const read = vi.fn(async () => undefined);
      try {
        await expect(
          withLegacySourceReadFence(f.teamName.toUpperCase(), read, f.fencePorts)
        ).rejects.toMatchObject({ name: 'MemberWorkSyncTeamQuiescedError' });
        expect(read).not.toHaveBeenCalled();
        expect(f.queue.getDiagnostics()).toMatchObject({ queued: 1, quiesced: 1, dropped: 0 });
        await expect(f.gate.run(f.teamName, async () => undefined)).rejects.toMatchObject({
          name: 'MemberWorkSyncTeamQuiescedError',
        });
      } finally {
        other.release();
      }
      await expect(f.gate.run(f.teamName, async () => 'restore alone released')).resolves.toBe(
        'restore alone released'
      );
    });
  }
);
