// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readRetainedOpenDiagnostic } from '../../../scripts/legacy-agent-host/desktop-retained-open-diagnostics';
import { RetainedLegacyLaunchRefusal } from '../../../src/features/agent-backend/core/application/RetainedLegacyLaunchCoordinator';
import { createRetainedLegacyLaunchScope } from '../../../src/features/agent-backend/main/application/createRetainedLegacyLaunchScope';
import { captureLegacyStoppedSource } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/captureLegacyStoppedSource';
import { LegacyStoppedImportHold } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/createLegacyStoppedTeamSource';
import { readLegacyStoppedOwnerFacts } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/legacyStoppedSourceDiagnostic';
import { createDesktopStoppedTeamOperations } from '../../../src/main/composition/createDesktopStoppedTeamOperations';
import { configureOriginalRuntimeLaunchAdmission } from '../../../src/main/services/runtime/OriginalRuntimeScope';
import { installPersistentAppLog } from '../../../src/main/utils/persistentAppLog';
import { addLogSink } from '../../../src/shared/utils/logger';

import type { CapturedRetainedLegacyRuntime } from '../../../src/features/agent-backend/main/application/createRetainedLegacyLaunchScope';
import type { LegacyStoppedSourceOwners } from '../../../src/features/agent-backend/main/infrastructure/stopped-import/createLegacyStoppedTeamSource';

const paths = vi.hoisted(() => ({ root: '/TEST-unconfigured-eligibility' }));
vi.mock('@main/utils/pathDecoder', async (original) => ({
  ...(await original<typeof import('../../../src/main/utils/pathDecoder')>()),
  getClaudeBasePath: () => join(paths.root, 'claude'),
  getTeamsBasePath: () => join(paths.root, 'claude/teams'),
  getTasksBasePath: () => join(paths.root, 'claude/tasks'),
  getAppDataPath: () => join(paths.root, 'app'),
}));

const roots: string[] = [];
afterEach(() => {
  configureOriginalRuntimeLaunchAdmission((_team, operation) => operation(() => {}));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Actual stopped-source parser and physical identity, with finite owner read ports only. */
function fixture(teamName = 'test-eligibility') {
  paths.root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-retained-eligibility-')));
  roots.push(paths.root);
  const team = join(paths.root, 'claude/teams', teamName);
  mkdirSync(team, { recursive: true });
  const config = { name: teamName, members: [{ name: 'team-lead', agentType: 'team-lead' }] };
  writeFileSync(join(team, 'config.json'), JSON.stringify(config));
  writeFileSync(
    join(team, 'team.meta.json'),
    JSON.stringify({
      version: 1,
      cwd: '/TEST/project',
      providerId: 'opencode',
      model: 'TEST-model',
      skipPermissions: false,
      createdAt: 1,
    })
  );
  writeFileSync(
    join(team, 'members.meta.json'),
    JSON.stringify({
      version: 1,
      members: [{ name: 'team-lead', agentType: 'team-lead' }],
    })
  );
  let current = true;
  let active = 1;
  let fenceFailure: unknown;
  let failFence = false;
  let revokeAtFence = false;
  const owners: LegacyStoppedSourceOwners = {
    backup: {
      async withTeamIdentityFence(_name, read) {
        if (revokeAtFence) current = false;
        if (failFence) throw fenceFailure;
        return read();
      },
    },
    provisioning: {
      withStoppedTeamImportFence: async (_name, read) => read(),
      readStoppedTeamImportRuntimeFacts: vi.fn(() => ({ provisioning: active })),
      readStoppedTeamImportLifecycleFacts: vi.fn(() => ({})),
      readStoppedTeamImportStopFacts: vi.fn(() => ({})),
      readStoppedTeamImportDeliveryFacts: vi.fn(() => ({})),
    },
    data: {
      readStoppedTeamImportBackgroundFacts: vi.fn(() => ({})),
      readStoppedTeamImportCommandFacts: vi.fn(async () => ({
        known: true,
        pending: 0,
        revision: 'TEST-command',
      })),
      readStoppedTeamImportNotificationFacts: vi.fn(async () => ({
        known: true,
        pending: 0,
        revision: 'TEST-notification',
      })),
    },
    launch: { readResult: async () => ({ status: 'absent' }) },
  };
  const source = captureLegacyStoppedSource(teamName, 'local', () => current);
  const target = {
    authority: { assertCurrent() {} },
    client: { list: vi.fn(async () => []), lookup: vi.fn(async () => null) },
  } as unknown as Parameters<typeof createRetainedLegacyLaunchScope>[0]['target'];
  const run = vi.fn(async (): Promise<never> => {
    throw new Error('Unexpected runtime dispatch');
  });
  const close = vi.fn(async () => {});
  const runtime: CapturedRetainedLegacyRuntime = {
    projectPath: '/TEST/project',
    assertCurrent() {},
    run,
    close,
    cancelModels: async () => {
      throw new Error('Unexpected model dispatch');
    },
  };
  return {
    teamName,
    owners,
    target,
    runtime,
    run,
    close,
    current: () => current,
    scope: (onEligibilityRefusal?: (error: unknown) => unknown) =>
      createRetainedLegacyLaunchScope({
        source,
        owners,
        target,
        runtime,
        guard: { isCurrent: () => current },
        onEligibilityRefusal,
      }),
    stopped() {
      active = 0;
    },
    retained() {
      active = 0;
      writeFileSync(
        join(team, 'config.json'),
        JSON.stringify({ ...config, leadSessionId: 'TEST-native-session' })
      );
    },
    failFence(error: unknown, revoke = false) {
      failFence = true;
      fenceFailure = error;
      revokeAtFence = revoke;
    },
  };
}

describe('actual retained eligibility refusal observation', () => {
  it('retains the original typed owner refusal while keeping other and zero runtime dispatch', async () => {
    const f = fixture(),
      observe = vi.fn();
    expect(await f.scope(observe).readEligibility()).toBe('other');
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]?.[0]).toBeInstanceOf(LegacyStoppedImportHold);
    expect(observe.mock.calls[0]?.[0]).toMatchObject({ reason: 'owner-active' });
    expect(readLegacyStoppedOwnerFacts(observe.mock.calls[0]?.[0])).toEqual([
      { name: 'runtime.provisioning', count: 1 },
    ]);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
  });

  it('observes the already-read vector once without another owner or downstream authority read', async () => {
    const f = fixture(), observe = vi.fn();
    const vectors: Record<string, number>[] = [
      { provisioning: 2, alive: 0, 'PRIVATE-team-token': 9 },
      { pendingTimers: 3, unattributedCredentialCleanup: 1 },
      { rosterMutation: 1 },
      { relay: 4 },
      { initialization: 1, context: 2 },
    ];
    const readers = [
      f.owners.provisioning.readStoppedTeamImportRuntimeFacts,
      f.owners.provisioning.readStoppedTeamImportLifecycleFacts,
      f.owners.provisioning.readStoppedTeamImportStopFacts,
      f.owners.provisioning.readStoppedTeamImportDeliveryFacts,
      f.owners.data.readStoppedTeamImportBackgroundFacts,
    ];
    readers.forEach((reader, index) => vi.mocked(reader).mockReturnValue(vectors[index]!));
    expect(await f.scope(observe).readEligibility()).toBe('other');
    for (const reader of readers) expect(reader).toHaveBeenCalledExactlyOnceWith(f.teamName);
    expect(readLegacyStoppedOwnerFacts(observe.mock.calls[0]?.[0])).toEqual([
      { name: 'runtime.provisioning', count: 2 },
      { name: 'lifecycle.pendingTimers', count: 3 },
      { name: 'lifecycle.unattributedCredentialCleanup', count: 1 },
      { name: 'stop.rosterMutation', count: 1 },
      { name: 'delivery.relay', count: 4 },
      { name: 'background.initialization', count: 1 },
      { name: 'background.context', count: 2 },
    ]);
    expect(f.owners.data.readStoppedTeamImportNotificationFacts).not.toHaveBeenCalled();
    expect(f.owners.data.readStoppedTeamImportCommandFacts).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 'PRIVATE-count', null, undefined])(
    'preserves original owner-active and sanitizes the invalid counter %s', async (count) => {
      const f = fixture(), observe = vi.fn();
      vi.mocked(f.owners.provisioning.readStoppedTeamImportRuntimeFacts)
        .mockReturnValue({ provisioning: count } as never);
      expect(await f.scope(observe).readEligibility()).toBe('other');
      const error = observe.mock.calls[0]?.[0];
      expect(error).toMatchObject({ reason: 'owner-active' });
      expect(readLegacyStoppedOwnerFacts(error)).toEqual([
        { name: 'runtime.provisioning', count: 'invalid' },
      ]);
      expect(f.owners.provisioning.readStoppedTeamImportRuntimeFacts).toHaveBeenCalledTimes(1);
      expect(f.run).not.toHaveBeenCalled();
    }
  );

  it('hands the same generic fence error to the observer without changing eligibility', async () => {
    const f = fixture(),
      error = new Error('PRIVATE-fence-path-token'),
      observe = vi.fn();
    f.failFence(error);
    expect(await f.scope(observe).readEligibility()).toBe('other');
    expect(observe).toHaveBeenCalledExactlyOnceWith(error);
  });

  it.each(['throw', 'reject', 'pending', 'then-getter'] as const)(
    'cannot let a %s observer replace or delay the original refusal',
    async (mode) => {
      const f = fixture();
      const observe = vi.fn(() => {
        if (mode === 'throw') throw new Error('PRIVATE-observer');
        if (mode === 'reject') return Promise.reject(new Error('PRIVATE-observer'));
        if (mode === 'pending') return new Promise<void>(() => {});
        return Object.defineProperty({}, 'then', {
          get() {
            throw new Error('PRIVATE-observer');
          },
        });
      });
      expect(await f.scope(observe).readEligibility()).toBe('other');
      expect(observe).toHaveBeenCalledTimes(1);
      await Promise.resolve();
    }
  );

  it.each(['stopped', 'retained'] as const)(
    'does not report the accepted %s source as a failure',
    async (kind) => {
      const f = fixture(),
        observe = vi.fn();
      f[kind]();
      expect(await f.scope(observe).readEligibility()).toBe(
        kind === 'stopped' ? 'stopped' : 'native-custody-unverified'
      );
      expect(observe).not.toHaveBeenCalled();
    }
  );

  it('keeps currentness refusal ahead of observation after a source fence error', async () => {
    const f = fixture(),
      observe = vi.fn();
    f.failFence(new LegacyStoppedImportHold('owner-active'), true);
    const eligibility = f.scope(observe).readEligibility();
    await expect(eligibility).rejects.toBeInstanceOf(RetainedLegacyLaunchRefusal);
    await expect(eligibility).rejects.toMatchObject({ reason: 'source-changed' });
    expect(observe).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it('retains the same rejected result with the optional observer absent', async () => {
    expect(await fixture().scope().readEligibility()).toBe('other');
  });
});

describe('actual Main coordinator forwards only the bounded category after candidate cleanup', () => {
  it.each(['owner-active', 'generic-fence', 'cleanup-unknown'] as const)(
    'keeps the original %s outcome and emits one private observation',
    async (kind) => {
      const f = fixture('test-retained-opencode-v1'),
        entered = deferred(),
        release = deferred();
      if (kind === 'generic-fence') f.failFence(new Error('PRIVATE-fence-path-token'));
      f.close.mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        if (kind === 'cleanup-unknown') throw new Error('PRIVATE-cleanup');
      });
      const observations: unknown[] = [];
      const removeSink = addLogSink((entry) => {
        if (entry.namespace === 'RetainedLegacyOpen') observations.push(...entry.args);
      });
      const shell = {
        selected: true,
        feature: { captureStoppedImport: vi.fn(async () => f.target) },
      } as unknown as NonNullable<
        ReturnType<Parameters<typeof createDesktopStoppedTeamOperations>[0]>
      >;
      const main = createDesktopStoppedTeamOperations(() => shell);
      main.configure(
        f.owners,
        () => f.current(),
        async () => f.runtime
      );
      const intentId = 'TEST-coexist-retained-original-once';
      const persistent = installPersistentAppLog({
        directory: join(paths.root, 'userData/logs'), appVersion: 'TEST-owner-diagnostic', platform: 'linux',
      });
      try {
        const opening = main.retained(
          shell,
          'local',
          { action: 'open', teamName: f.teamName, intentId },
          () => f.current()
        );
        await entered.promise;
        expect(observations).toHaveLength(0);
        release.resolve();
        const result = await opening;
        const outcome = kind === 'cleanup-unknown' ? 'unknown' : 'not-dispatched';
        expect(result).toEqual({
          ok: false,
          reason: kind === 'cleanup-unknown' ? 'outcome-unknown' : 'not-eligible',
          outcome,
        });
        expect(f.close).toHaveBeenCalledTimes(1);
        expect(f.run).not.toHaveBeenCalled();
        expect(observations).toEqual([
          {
            v: 1,
            mainPid: process.pid,
            operationHash: createHash('sha256')
              .update(JSON.stringify(['open', f.teamName, intentId]))
              .digest('hex'),
            phase: 'coordinator-admission',
            category: kind === 'generic-fence' ? 'unknown' : 'owner-active',
            outcome,
            ...(kind === 'generic-fence' ? {} : {
              ownerFacts: [{ name: 'runtime.provisioning', count: 1 }],
            }),
          },
        ]);
        expect(JSON.stringify(observations)).not.toMatch(/PRIVATE|test-retained-opencode-v1|TEST-project/);
        await persistent.flush();
        expect(await readRetainedOpenDiagnostic({
          root: paths.root, binding: { mainPid: process.pid, teamName: f.teamName, intentId },
        })).toEqual(process.getuid ? {
          status: 'observed', phase: 'coordinator-admission',
          category: kind === 'generic-fence' ? 'unknown' : 'owner-active', outcome,
          ...(kind === 'generic-fence' ? {} : {
            ownerFacts: [{ name: 'runtime.provisioning', count: 1 }],
          }),
        } : { status: 'diagnostic-unknown', reason: 'unsafe-log' });
      } finally {
        release.resolve();
        removeSink();
        await main.shutdown();
        await persistent.flush();
        persistent.dispose();
      }
    }
  );
});
