// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { RETAINED_LEGACY_LAUNCH_CHANNEL } from '../../../src/features/agent-backend/contracts';
import { createDesktopStoppedTeamOperations } from '../../../src/main/composition/createDesktopStoppedTeamOperations';
import { registerDesktopStoppedTeamIpc } from '../../../src/main/ipc/registerDesktopStoppedTeamIpc';
import {
  configureOriginalRuntimeLaunchAdmission,
  withOriginalRuntimeLaunchAdmission,
} from '../../../src/main/services/runtime/OriginalRuntimeScope';
import { TeamProvisioningService } from '../../../src/main/services/team/TeamProvisioningService';
import { addLogSink } from '../../../src/shared/utils/logger';

import type { StoppedTeamImportResult } from '../../../src/features/agent-backend/contracts';
import type {
  CapturedRetainedLegacyRuntime,
  DesktopBackendFeature,
} from '../../../src/features/agent-backend/main';
import type { CaptureRetainedLegacyRuntime } from '../../../src/main/composition/createDesktopStoppedTeamOperations';
import type { IpcMain } from 'electron';

const state = vi.hoisted(() => ({
  root: '/TEST-unconfigured',
  import: vi.fn<() => Promise<StoppedTeamImportResult>>(),
}));
vi.mock('@main/utils/pathDecoder', async (original) => ({
  ...(await original<typeof import('../../../src/main/utils/pathDecoder')>()),
  getClaudeBasePath: () => join(state.root, 'claude'),
  getTeamsBasePath: () => join(state.root, 'claude', 'teams'),
  getTasksBasePath: () => join(state.root, 'claude', 'tasks'),
  getAppDataPath: () => join(state.root, 'app'),
}));
vi.mock('@features/agent-backend/main', async (original) => ({
  ...(await original<typeof import('../../../src/features/agent-backend/main')>()),
  importStoppedLegacyTeam: () => state.import(),
}));
const roots: string[] = [];
afterEach(() => {
  configureOriginalRuntimeLaunchAdmission((_team, operation) => operation(() => {}));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function fixture() {
  state.root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-original-admission-')));
  roots.push(state.root);
  const teamName = 'test-original';
  mkdirSync(join(state.root, 'claude', 'teams', teamName), { recursive: true });
  let shell: { feature: DesktopBackendFeature; selected: boolean } = {
    feature: {} as DesktopBackendFeature,
    selected: false,
  };
  const owner = createDesktopStoppedTeamOperations(() => shell);
  // The import result below is a finite controlled owner callback, not native release evidence.
  owner.configure(
    { backup: {} as never, data: {} as never, provisioning: {} as never },
    () => true
  );
  const captureStoppedImport = vi.fn(async () => ({}));
  const importedOwner = {
    feature: { captureStoppedImport } as unknown as DesktopBackendFeature,
    selected: true,
  };
  const importTeam = () => {
    shell = importedOwner;
    return owner.import(importedOwner, 'local', { action: 'prepare', teamName }, () => true);
  };
  return {
    owner,
    teamName,
    importedOwner,
    captureStoppedImport,
    importTeam,
    configureRuntime: (captureRuntime: CaptureRetainedLegacyRuntime) =>
      owner.configure(
        { backup: {} as never, data: {} as never, provisioning: {} as never },
        () => true,
        captureRuntime
      ),
    retained: (request: unknown) => {
      shell = importedOwner;
      return owner.retained(importedOwner, 'local', request, () => true);
    },
    replaceSource: () => {
      const team = join(state.root, 'claude', 'teams', teamName);
      renameSync(team, `${team}-old`);
      mkdirSync(team);
    },
    selectOriginal: () => {
      shell = { feature: {} as DesktopBackendFeature, selected: false };
    },
    selectHost: () => {
      shell = importedOwner;
    },
  };
}

describe('actual Main import publication versus direct original Launch admission', () => {
  it.each(['published', 'unknown'] as const)(
    'rechecks a queued direct Launch after an earlier %s import',
    async (kind) => {
      const f = fixture(),
        entered = deferred(),
        gate = deferred(),
        launch = vi.fn(async () => ({ runId: 'TEST-native' }));
      state.import.mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
        return kind === 'unknown'
          ? { ok: false, reason: 'held', outcome: 'unknown' }
          : { ok: true, selection: 'host-team:TEST-imported' };
      });
      const importing = f.importTeam();
      await entered.promise;
      f.selectOriginal();
      const launching = withOriginalRuntimeLaunchAdmission(f.teamName, launch);
      gate.resolve();
      await importing;
      await expect(launching).rejects.toMatchObject({ reason: 'import-not-absent' });
      expect(launch).not.toHaveBeenCalled();
      await f.owner.shutdown();
    }
  );
  it('rechecks selected Host while a no-Host direct Launch waits behind an import', async () => {
    const f = fixture(),
      entered = deferred(),
      gate = deferred(),
      launch = vi.fn(async () => 'TEST');
    state.import.mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      return { ok: false, reason: 'held', outcome: 'not-dispatched' };
    });
    const importing = f.importTeam();
    await entered.promise;
    f.selectOriginal();
    const launching = withOriginalRuntimeLaunchAdmission(f.teamName, launch);
    f.selectHost();
    gate.resolve();
    await importing;
    await expect(launching).rejects.toMatchObject({ reason: 'not-eligible' });
    expect(launch).not.toHaveBeenCalled();
    await f.owner.shutdown();
  });
  it('keeps the existing direct service API when Host is unconfigured', async () => {
    const f = fixture(),
      launch = vi.fn(async () => ({ runId: 'TEST-original' }));
    expect(await withOriginalRuntimeLaunchAdmission(f.teamName, launch)).toEqual({
      runId: 'TEST-original',
    });
    expect(launch).toHaveBeenCalledTimes(1);
    await f.owner.shutdown();
  });
  it('guards the actual legacy service after its awaited lifecycle barriers', async () => {
    const f = fixture(),
      entered = deferred(),
      gate = deferred(),
      launch = vi.fn(async () => ({ runId: 'TEST-original' }));
    const receiver = {
      withLaunchAdmission: (operation: () => Promise<unknown>) => operation(),
      waitForOpenCodeAggregatePrimaryRestart: async () => {
        entered.resolve();
        await gate.promise;
      },
      waitForMemberLifecycleOperations: vi.fn(async () => {}),
      requestAdmissionBoundary: { launchTeam: launch },
    };
    const launching = Reflect.apply(TeamProvisioningService.prototype.launchTeam, receiver, [
      { teamName: f.teamName, cwd: '/TEST/project' },
      vi.fn(),
    ]);
    await entered.promise;
    f.selectHost();
    gate.resolve();
    await expect(launching).rejects.toMatchObject({ reason: 'not-eligible' });
    expect(launch).not.toHaveBeenCalled();
    expect(receiver.waitForMemberLifecycleOperations).not.toHaveBeenCalled();
    await f.owner.shutdown();
  });
  it('retains the source fence and cleanup debt before a captured runtime becomes a scope', async () => {
    const f = fixture(),
      closing = deferred(),
      gate = deferred(),
      native = vi.fn(async () => 'wrong');
    const runtime: CapturedRetainedLegacyRuntime = {
      projectPath: '/TEST/project',
      assertCurrent: vi.fn(),
      run: vi.fn() as never,
      cancelModels: vi.fn() as never,
      close: vi.fn(async () => {
        closing.resolve();
        await gate.promise;
        throw new Error('TEST capture cleanup unknown');
      }),
    };
    f.configureRuntime(async () => {
      f.replaceSource();
      return runtime;
    });
    const opening = f.retained({ action: 'open', teamName: f.teamName, intentId: 'TEST-capture' });
    await closing.promise;
    const importing = f.importTeam();
    await Promise.resolve();
    expect(state.import).not.toHaveBeenCalled();
    const cleanup = f.retained({
      action: 'closeIntent',
      teamName: f.teamName,
      intentId: 'TEST-capture',
    });
    gate.resolve();
    expect(await opening).toMatchObject({ ok: false, outcome: 'unknown' });
    expect(await importing).toMatchObject({ ok: false });
    expect(state.import).not.toHaveBeenCalled();
    expect(await cleanup).toMatchObject({ ok: false, outcome: 'unknown' });
    f.selectOriginal();
    await expect(withOriginalRuntimeLaunchAdmission(f.teamName, native)).rejects.toMatchObject({
      reason: 'outcome-unknown',
    });
    expect(native).not.toHaveBeenCalled();
    await f.owner.shutdown();
  });
});

describe('actual Main stopped import refusal diagnostics', () => {
  it('keeps missing owner held and records only the closed original boundary', async () => {
    const f = fixture();
    const observations: unknown[][] = [];
    const removeSink = addLogSink((entry) => {
      if (entry.namespace === 'StoppedTeamImport') observations.push([...entry.args]);
    });
    try {
      f.owner.clearOwners();
      expect(await f.importTeam()).toEqual({
        ok: false,
        reason: 'held',
        outcome: 'not-dispatched',
      });
      expect(state.import).not.toHaveBeenCalled();
      expect(observations).toEqual([
        [
          'Stopped Team import refusal',
          {
            source: 'desktop',
            phase: 'source-owner',
            category: 'unavailable',
            outcome: 'not-dispatched',
          },
        ],
      ]);
      expect(JSON.stringify(observations)).not.toContain(f.teamName);
      expect(JSON.stringify(observations)).not.toContain(state.root);
    } finally {
      removeSink();
      await f.owner.shutdown();
    }
  });

  it('preserves an original queued application rejection without a second attempt', async () => {
    const f = fixture();
    const observations: unknown[][] = [];
    const removeSink = addLogSink((entry) => {
      if (entry.namespace === 'StoppedTeamImport') observations.push([...entry.args]);
    });
    state.import.mockRejectedValueOnce(
      Object.assign(new Error('PRIVATE-application-path-token'), { code: 'EACCES' })
    );
    try {
      expect(await f.importTeam()).toEqual({
        ok: false,
        reason: 'held',
        outcome: 'not-dispatched',
      });
      expect(state.import).toHaveBeenCalledTimes(1);
      expect(observations).toEqual([
        [
          'Stopped Team import refusal',
          {
            source: 'desktop',
            phase: 'application',
            category: 'denied',
            outcome: 'not-dispatched',
          },
        ],
      ]);
      expect(JSON.stringify(observations)).not.toContain('PRIVATE');
    } finally {
      removeSink();
      await f.owner.shutdown();
    }
  });
});

function retainedOpenObservations() {
  const observations: unknown[][] = [];
  const removeSink = addLogSink((entry) => {
    if (entry.namespace === 'RetainedLegacyOpen') observations.push([...entry.args]);
  });
  return { observations, removeSink };
}

function expectedOpenObservation(
  teamName: string,
  intentId: string,
  phase: string,
  category: string,
  outcome = 'not-dispatched'
) {
  return [{
    v: 1,
    mainPid: process.pid,
    operationHash: createHash('sha256')
      .update(JSON.stringify(['open', teamName, intentId]), 'utf8')
      .digest('hex'),
    phase,
    category,
    outcome,
  }];
}

function finiteRetainedRuntime(close: () => Promise<void>): CapturedRetainedLegacyRuntime {
  return {
    projectPath: '/TEST/project',
    assertCurrent: () => {},
    run: async () => { throw new Error('Unexpected original runtime action'); },
    cancelModels: async () => { throw new Error('Unexpected model cancellation'); },
    close,
  };
}

describe('actual Main original open diagnostic ownership and cleanup ordering', () => {
  it.each(['source-owner', 'runtime-capture'] as const)(
    'preserves the original unavailable result at %s',
    async (phase) => {
      const f = fixture();
      const captured = retainedOpenObservations();
      const intentId = 'TEST-original-diagnostic';
      if (phase === 'source-owner') f.owner.clearOwners();
      try {
        expect(await f.retained({ action: 'open', teamName: f.teamName, intentId })).toEqual({
          ok: false, reason: 'unavailable', outcome: 'not-dispatched',
        });
        expect(captured.observations).toEqual([
          expectedOpenObservation(f.teamName, intentId, phase, 'unavailable'),
        ]);
        expect(f.captureStoppedImport).toHaveBeenCalledTimes(phase === 'source-owner' ? 0 : 1);
        expect(state.import).not.toHaveBeenCalled();
        expect(JSON.stringify(captured.observations)).not.toContain(f.teamName);
        expect(JSON.stringify(captured.observations)).not.toContain(state.root);
      } finally {
        captured.removeSink();
        await f.owner.shutdown();
      }
    }
  );

  it.each(['target-capture', 'runtime-capture'] as const)(
    'reports only the closed original exception category at %s',
    async (phase) => {
      const f = fixture();
      const captured = retainedOpenObservations();
      const error = Object.assign(new Error('PRIVATE-account-path-token'), { code: 'EACCES' });
      const captureRuntime = vi.fn<CaptureRetainedLegacyRuntime>(async () => { throw error; });
      const intentId = 'TEST-original-diagnostic';
      f.configureRuntime(captureRuntime);
      if (phase === 'target-capture') f.captureStoppedImport.mockRejectedValueOnce(error);
      try {
        expect(await f.retained({ action: 'open', teamName: f.teamName, intentId })).toEqual({
          ok: false, reason: 'unavailable', outcome: 'not-dispatched',
        });
        expect(f.captureStoppedImport).toHaveBeenCalledTimes(1);
        expect(captureRuntime).toHaveBeenCalledTimes(phase === 'runtime-capture' ? 1 : 0);
        expect(captured.observations).toEqual([
          expectedOpenObservation(f.teamName, intentId, phase, 'denied'),
        ]);
        expect(JSON.stringify(captured.observations)).not.toContain('PRIVATE');
      } finally {
        captured.removeSink();
        await f.owner.shutdown();
      }
    }
  );

  it.each(['closed', 'unknown'] as const)(
    'waits for original candidate cleanup before observing its %s outcome',
    async (cleanup) => {
      const f = fixture();
      const captured = retainedOpenObservations();
      const entered = deferred(), gate = deferred();
      const intentId = 'TEST-cleanup-diagnostic';
      const close = vi.fn(async () => {
        entered.resolve();
        await gate.promise;
        if (cleanup === 'unknown') throw new Error('PRIVATE-cleanup');
      });
      f.configureRuntime(async () => {
        f.replaceSource();
        return finiteRetainedRuntime(close);
      });
      try {
        const opening = f.retained({ action: 'open', teamName: f.teamName, intentId });
        await entered.promise;
        expect(captured.observations).toHaveLength(0);
        gate.resolve();
        expect(await opening).toEqual({
          ok: false,
          reason: cleanup === 'unknown' ? 'outcome-unknown' : 'source-changed',
          outcome: cleanup === 'unknown' ? 'unknown' : 'not-dispatched',
        });
        expect(close).toHaveBeenCalledTimes(1);
        expect(captured.observations).toEqual([
          expectedOpenObservation(
            f.teamName, intentId, 'scope-construction', 'source-changed',
            cleanup === 'unknown' ? 'unknown' : 'not-dispatched'
          ),
        ]);
        const closing = await f.retained({ action: 'closeIntent', teamName: f.teamName, intentId });
        expect(closing.ok).toBe(cleanup === 'closed');
        expect(captured.observations).toHaveLength(1);
      } finally {
        gate.resolve();
        captured.removeSink();
        await f.owner.shutdown();
      }
    }
  );

  it('keeps an unavailable coordinator admission distinct from the completed capture callback', async () => {
    const f = fixture();
    const captured = retainedOpenObservations();
    const close = vi.fn(async () => {});
    const intentId = 'TEST-admission-diagnostic';
    // The existing finite target has no authority; actual coordinator admission must refuse it.
    f.configureRuntime(async () => finiteRetainedRuntime(close));
    try {
      expect(await f.retained({ action: 'open', teamName: f.teamName, intentId })).toEqual({
        ok: false, reason: 'unavailable', outcome: 'not-dispatched',
      });
      expect(close).toHaveBeenCalledTimes(1);
      expect(captured.observations).toEqual([
        expectedOpenObservation(f.teamName, intentId, 'coordinator-admission', 'unavailable'),
      ]);
    } finally {
      captured.removeSink();
      await f.owner.shutdown();
    }
  });

  it.each(['shell', 'context', 'handoff'] as const)(
    'keeps exactly one original observation for IPC %s refusal',
    async (mode) => {
      const f = fixture();
      const captured = retainedOpenObservations();
      const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
      const ipc: Pick<IpcMain, 'handle' | 'removeHandler'> = {
        handle(channel, listener) { handlers.set(channel, listener); },
        removeHandler(channel) { handlers.delete(channel); },
      };
      const selected = { ...f.importedOwner, captureSelection: () => ({ isCurrent: () => true }) };
      const event = { marker: 'TEST-original-event' };
      const dispose = registerDesktopStoppedTeamIpc(ipc, f.owner, {
        readShell: () => mode === 'shell' ? undefined : selected,
        captureContext: (received) => {
          expect(received).toBe(event);
          return mode === 'context' ? null : 'local';
        },
        getMainWindow: () => null,
      });
      const intentId = 'TEST-ipc-diagnostic';
      f.owner.clearOwners();
      try {
        const handler = handlers.get(RETAINED_LEGACY_LAUNCH_CHANNEL);
        if (!handler) throw new Error('Missing actual retained handler');
        const result: unknown = await Reflect.apply(handler, undefined, [
          event, { action: 'open', teamName: f.teamName, intentId },
        ]);
        expect(result).toEqual({ ok: false, reason: 'unavailable', outcome: 'not-dispatched' });
        const phase = mode === 'handoff' ? 'source-owner' : 'ipc-' + mode;
        expect(captured.observations).toEqual([
          expectedOpenObservation(f.teamName, intentId, phase, 'unavailable'),
        ]);
        expect(f.captureStoppedImport).not.toHaveBeenCalled();
      } finally {
        dispose();
        expect(handlers.size).toBe(0);
        captured.removeSink();
        await f.owner.shutdown();
      }
    }
  );
});
