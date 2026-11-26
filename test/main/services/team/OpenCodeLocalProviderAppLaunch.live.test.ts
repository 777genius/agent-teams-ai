import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  inspectOpenCodeLocalModelRuntimeReadiness,
  OpenCodeLocalProviderConnector,
} from '../../../../src/features/runtime-provider-management/main';
import {
  getOpenCodeRuntimeLaneIndexPath,
  type OpenCodeRuntimeLaneIndex,
} from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import {
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';
import { runProviderPrepareDiagnostics } from '../../../../src/renderer/components/team/dialogs/providerPrepareDiagnostics';

import { formatProgressDump } from './memberWorkSyncLiveHarness';
import {
  createOpenCodeLiveHarness,
  type OpenCodeLiveHarness,
  waitUntil,
} from './openCodeLiveTestHarness';

import type { TeamProvisioningProgress } from '../../../../src/shared/types';

const liveDescribe =
  process.env.OPENCODE_E2E === '1' && process.env.OPENCODE_E2E_LOCAL_PROVIDER_APP_LAUNCH === '1'
    ? describe
    : describe.skip;

const LOCAL_PROVIDER_ID = 'local-lab';
const LOCAL_MODEL = `${LOCAL_PROVIDER_ID}/qwen-test:0.5b`;
const liveCases: LocalProviderLiveCases = { active: null, enrolled: null };

liveDescribe('OpenCode local provider app launch live e2e', () => {
  const cases = liveCases;

  beforeEach(async () => {
    const owned = enterLocalProviderLiveCase(
      cases,
      path.join(os.tmpdir(), `opencode-local-provider-app-launch-${randomUUID()}`)
    );
    await runLiveCaseStage(
      owned,
      'prepare owned case directory',
      async () => {
        await fs.mkdir(owned.tempClaudeRoot, { recursive: true });
        assertLiveCaseOpen(owned, 'activate owned case directory');
        setClaudeBasePathOverride(owned.tempClaudeRoot);
      },
      20_000
    );
  }, 30_000);

  afterEach(async () => {
    await cleanupEnrolledLocalProviderLiveCase(cases);
  }, 840_000);

  it('creates and stops an OpenCode team through the app service using a configured authless local provider', async () => {
    const owned = cases.enrolled!;
    const { projectPath, fakeServer, harness } = await prepareLocalProviderLiveCase(
      owned,
      'project',
      LOCAL_MODEL
    );
    await runLiveCaseStage(
      owned,
      'write test project README',
      () =>
        fs.writeFile(
          path.join(projectPath, 'README.md'),
          '# OpenCode local provider app launch live e2e\n',
          'utf8'
        ),
      10_000
    );

    const verificationModes: Array<'compatibility' | 'deep' | undefined> = [];
    const preflight = await runLiveCaseStage(
      owned,
      'compatibility and deep provider preflight',
      () =>
        runProviderPrepareDiagnostics({
          cwd: projectPath,
          providerId: 'opencode',
          selectedModelIds: [LOCAL_MODEL],
          prepareProvisioning: async (
            cwd,
            providerId,
            providerIds,
            modelIds,
            limitContext,
            modelVerificationMode,
            modelChecks
          ) => {
            assertLiveCaseOpen(owned, `provider ${modelVerificationMode} preflight`);
            verificationModes.push(modelVerificationMode);
            return harness.svc.prepareForProvisioning(cwd, {
              providerId,
              providerIds,
              modelIds,
              limitContext,
              modelVerificationMode,
              modelChecks,
            });
          },
        }),
      240_000
    );
    expect(verificationModes).toEqual(['compatibility', 'deep']);
    expect(preflight.status, JSON.stringify(preflight, null, 2)).toBe('notes');
    expect(
      preflight.modelResultsById[LOCAL_MODEL],
      JSON.stringify(preflight, null, 2)
    ).toMatchObject({
      status: 'ready',
    });
    expect(preflight.warnings).toEqual([
      expect.stringContaining('does not expose enough runtime metadata'),
    ]);

    const teamName = (owned.teamName = `opencode-local-provider-app-${Date.now()}`);
    const progressEvents = owned.progressEvents;
    const { runId } = await runLiveCaseStage(
      owned,
      'create local team',
      () =>
        harness.svc.createTeam(
          {
            teamName,
            cwd: projectPath,
            providerId: 'opencode',
            model: LOCAL_MODEL,
            skipPermissions: true,
            members: [
              {
                name: 'bob',
                role: 'Developer',
                providerId: 'opencode',
                model: LOCAL_MODEL,
                mcpPolicy: { mode: 'appOnly' },
              },
            ],
          },
          (progress) => progressEvents.push(progress)
        ),
      300_000
    );

    const progressDump = formatProgressDump(progressEvents);
    expect(runId, progressDump).toBeTruthy();
    expect(
      progressEvents.some((progress) => progress.message.includes('OpenCode team launch is ready')),
      progressDump
    ).toBe(true);
    expect(progressDump).not.toContain('provider not connected');
    expect(progressDump).not.toContain('not authenticated');
    expect(progressDump).not.toContain('OpenCode team launch is not enabled');
    expect(fakeServer.requests, progressDump).toContain('POST /v1/chat/completions');

    const runtimeSnapshot = await runLiveCaseStage(
      owned,
      'read launched runtime snapshot',
      () => harness.svc.getTeamAgentRuntimeSnapshot(teamName),
      30_000
    );
    expect(runtimeSnapshot.runId).toBe(runId);
    expect(runtimeSnapshot.members.bob).toMatchObject({
      alive: true,
      providerId: 'opencode',
      laneId: 'primary',
      laneKind: 'primary',
      runtimeModel: LOCAL_MODEL,
      historicalBootstrapConfirmed: true,
    });

    const deliveryMarker = `local-provider-delivery-${Date.now()}`;
    const chatBodyCountBeforeDelivery = fakeServer.chatBodies.length;
    const delivery = await runLiveCaseStage(
      owned,
      'deliver local provider message',
      () =>
        harness.svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          messageId: `local-provider-delivery-${Date.now()}`,
          replyRecipient: 'user',
          source: 'manual',
          text: [
            `Local provider delivery marker: ${deliveryMarker}`,
            'Answer with PONG. Do not edit files.',
          ].join('\n'),
        }),
      120_000
    );
    expect(delivery.delivered, JSON.stringify(delivery, null, 2)).toBe(true);
    await waitForLiveCase(
      owned,
      'prove delivered prompt',
      async () =>
        fakeServer.chatBodies.length > chatBodyCountBeforeDelivery &&
        fakeServer.chatBodies.some((body) => JSON.stringify(body).includes(deliveryMarker)),
      60_000,
      500
    );

    await runLiveCaseStage(
      owned,
      'stop and verify owned team',
      () =>
        stopAndVerifyOpenCodeTeam(harness.svc, teamName, {
          teamsBasePath: owned.teamsBasePath,
          isCurrentCase: () => cases.active === owned,
        }),
      180_000
    );
    clearBenignSlowConfigReadWarnings();
  }, 600_000);

  it('fails app service launch for an unknown local model before creating OpenCode lanes', async () => {
    const owned = cases.enrolled!;
    const { projectPath, fakeServer, harness } = await prepareLocalProviderLiveCase(
      owned,
      'unknown-model-project',
      `${LOCAL_PROVIDER_ID}/missing-test:0.5b`
    );

    const teamName = (owned.teamName = `opencode-local-provider-unknown-${Date.now()}`);
    const progressEvents = owned.progressEvents;
    const { runId } = await runLiveCaseStage(
      owned,
      'reject unknown local model',
      () =>
        harness.svc.createTeam(
          {
            teamName,
            cwd: projectPath,
            providerId: 'opencode',
            model: `${LOCAL_PROVIDER_ID}/missing-test:0.5b`,
            skipPermissions: true,
            members: [
              {
                name: 'bob',
                role: 'Developer',
                providerId: 'opencode',
                model: `${LOCAL_PROVIDER_ID}/missing-test:0.5b`,
              },
            ],
          },
          (progress) => progressEvents.push(progress)
        ),
      120_000
    );
    expect(runId).toBeTruthy();
    await waitForLiveCase(
      owned,
      'wait for failed progress',
      async () => progressEvents.some((progress) => progress.state === 'failed'),
      30_000,
      500
    );

    const progressDump = formatProgressDump(progressEvents);
    expect(
      progressEvents.some((progress) => progress.state === 'failed'),
      progressDump
    ).toBe(true);
    expect(progressDump).toMatch(/missing-test:0\.5b|not available|unavailable/i);
    expect(fakeServer.requests, progressDump).not.toContain('POST /v1/chat/completions');
    await waitForLiveCase(
      owned,
      'prove no runtime lanes',
      () => hasNoOpenCodeRuntimeLanes(owned.teamsBasePath, teamName),
      15_000,
      500
    );
    const failedSnapshot = await runLiveCaseStage(
      owned,
      'read failed runtime snapshot',
      () => harness.svc.getTeamAgentRuntimeSnapshot(teamName),
      30_000
    );
    expect(
      failedSnapshot.members['team-lead']?.alive,
      JSON.stringify(failedSnapshot, null, 2)
    ).toBe(false);
    expect(failedSnapshot.members.bob?.alive, JSON.stringify(failedSnapshot, null, 2)).toBe(false);
    clearBenignSlowConfigReadWarnings();
  }, 180_000);

  it('preserves the active lane when the local server is offline during restart and recovers cleanly', async () => {
    const owned = cases.enrolled!;
    const prepared = await prepareLocalProviderLiveCase(
      owned,
      'restart-recovery-project',
      LOCAL_MODEL
    );
    const { projectPath, harness } = prepared;
    let { fakeServer } = prepared;
    const localServerPort = fakeServer.port;

    const teamName = (owned.teamName = `opencode-local-provider-restart-${Date.now()}`);
    const progressEvents = owned.progressEvents;
    await runLiveCaseStage(
      owned,
      'initial local team create',
      () =>
        harness.svc.createTeam(
          {
            teamName,
            cwd: projectPath,
            providerId: 'opencode',
            model: LOCAL_MODEL,
            skipPermissions: true,
            members: [
              {
                name: 'bob',
                role: 'Developer',
                providerId: 'opencode',
                model: LOCAL_MODEL,
                mcpPolicy: { mode: 'appOnly' },
              },
            ],
          },
          (progress) => progressEvents.push(progress)
        ),
      300_000
    );

    expect(
      progressEvents.some((progress) => progress.message.includes('OpenCode team launch is ready')),
      formatProgressDump(progressEvents)
    ).toBe(true);
    const beforeOutage = await runLiveCaseStage(
      owned,
      'read runtime before outage',
      () => harness.svc.getTeamAgentRuntimeSnapshot(teamName),
      30_000
    );
    expect(beforeOutage.members.bob).toMatchObject({
      alive: true,
      providerId: 'opencode',
      runtimeModel: LOCAL_MODEL,
    });
    const beforeOutageLaneIndex = await runLiveCaseStage(
      owned,
      'read lane before outage',
      () => readStrictOpenCodeRuntimeLaneIndex(owned.teamsBasePath, teamName),
      10_000
    );
    expect(beforeOutageLaneIndex.lanes.primary).toMatchObject({
      laneId: 'primary',
      state: 'active',
    });

    await runLiveCaseStage(owned, 'take local provider offline', () => fakeServer.close(), 10_000);
    owned.fakeServer = null;

    const blockedRestartStartedAt = Date.now();
    const blockedRestartError = await runLiveCaseStage(
      owned,
      'offline local restart preflight',
      () =>
        harness.svc.restartMember(teamName, 'bob').then(
          () => null,
          (error: unknown) => error
        ),
      30_000
    );
    expect(Date.now() - blockedRestartStartedAt).toBeLessThan(15_000);
    expect(blockedRestartError).toBeInstanceOf(Error);
    expect((blockedRestartError as Error).message).not.toContain('timed out');
    expect((blockedRestartError as Error).message).toMatch(
      /local|server|provider|unavailable|reach/i
    );
    clearExpectedLocalServerOutageErrors(localServerPort);

    const afterBlockedRestart = await runLiveCaseStage(
      owned,
      'read runtime after blocked restart',
      () => harness.svc.getTeamAgentRuntimeSnapshot(teamName),
      30_000
    );
    expect(afterBlockedRestart.members.bob).toMatchObject({
      alive: true,
      providerId: 'opencode',
      runtimeModel: LOCAL_MODEL,
    });
    const afterBlockedRestartLaneIndex = await runLiveCaseStage(
      owned,
      'read lane after blocked restart',
      () => readStrictOpenCodeRuntimeLaneIndex(owned.teamsBasePath, teamName),
      10_000
    );
    expect(afterBlockedRestartLaneIndex).toEqual(beforeOutageLaneIndex);

    fakeServer = await runLiveCaseStage(
      owned,
      'restore local provider',
      async () => {
        const server = await startFakeOpenAiCompatibleServer(localServerPort);
        return registerLocalProviderFakeServer(owned, server);
      },
      10_000
    );
    await runLiveCaseStage(
      owned,
      'recovered local teammate restart',
      () => harness.svc.restartMember(teamName, 'bob'),
      360_000
    );
    await waitForLiveCase(
      owned,
      'prove recovered runtime and lane',
      async () => {
        const { snapshot, laneIndex } = await readLiveRuntimeAndLaneEvidence(
          owned,
          harness,
          teamName
        );
        return (
          snapshot.members.bob?.alive === true &&
          snapshot.members.bob.laneId === 'primary' &&
          snapshot.members.bob.historicalBootstrapConfirmed === true &&
          laneIndex.lanes.primary?.state === 'active'
        );
      },
      30_000,
      1_000,
      async () => {
        const { snapshot, laneIndex } = await readLiveRuntimeAndLaneEvidence(
          owned,
          harness,
          teamName
        );
        return JSON.stringify({ snapshot, laneIndex }, null, 2);
      }
    );

    const recovered = await runLiveCaseStage(
      owned,
      'read recovered runtime snapshot',
      () => harness.svc.getTeamAgentRuntimeSnapshot(teamName),
      30_000
    );
    expect(recovered.members['team-lead']).toMatchObject({
      alive: true,
      providerId: 'opencode',
      runtimeModel: LOCAL_MODEL,
      historicalBootstrapConfirmed: true,
    });
    expect(recovered.members.bob).toMatchObject({
      alive: true,
      providerId: 'opencode',
      laneId: 'primary',
      laneKind: 'primary',
      runtimeModel: LOCAL_MODEL,
      historicalBootstrapConfirmed: true,
    });

    const recoveryMarker = `local-provider-recovery-${Date.now()}`;
    const recoveryBodyCount = fakeServer.chatBodies.length;
    const delivery = await runLiveCaseStage(
      owned,
      'deliver recovery message',
      () =>
        harness.svc.deliverOpenCodeMemberMessage(teamName, {
          memberName: 'bob',
          messageId: recoveryMarker,
          replyRecipient: 'user',
          source: 'manual',
          text: [`Recovery marker: ${recoveryMarker}`, 'Answer with PONG. Do not edit files.'].join(
            '\n'
          ),
        }),
      120_000
    );
    expect(delivery.delivered, JSON.stringify(delivery, null, 2)).toBe(true);
    await waitForLiveCase(
      owned,
      'prove recovery delivery',
      async () =>
        fakeServer.chatBodies.length > recoveryBodyCount &&
        fakeServer.chatBodies.some((body) => JSON.stringify(body).includes(recoveryMarker)),
      60_000,
      500
    );

    retainVerifiedLocalRestartWarning(teamName, 'bob');
    await runLiveCaseStage(
      owned,
      'stop and verify owned team',
      () =>
        stopAndVerifyOpenCodeTeam(harness.svc, teamName, {
          teamsBasePath: owned.teamsBasePath,
          isCurrentCase: () => cases.active === owned,
        }),
      180_000
    );
    clearBenignSlowConfigReadWarnings();
  }, 720_000);
});

describe('OpenCode local provider fixture', () => {
  beforeEach(() => assertPreviousLiveCaseSettled(liveCases.active));

  it('closes the fake server after a timed-out harness disposal settles without disposing twice', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-deferred-dispose-'));
    const owned = createLocalProviderLiveCase(path.join(root, 'case'));
    const disposal = deferredOperation();
    const dispose = vi.fn(() => disposal.promise);
    const close = vi.fn(async () => undefined);
    const harness = { svc: { stopTeam: vi.fn(async () => undefined) }, dispose };
    const server = { close };
    owned.harness = harness;
    owned.fakeServer = server;
    try {
      const originalDisposal = dispose();
      deferOwnedLocalProviderServerClose(owned, harness, originalDisposal, server);
      expect(close).not.toHaveBeenCalled();
      disposal.resolve();
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(owned.harness).toBeNull();
      expect(owned.fakeServer).toBeNull();
    } finally {
      disposal.resolve();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps a delayed cleanup confined to its captured case and diagnostics', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-owned-case-cleanup-'));
    const previousRoot = path.dirname(getTeamsBasePath());
    const owned = createLocalProviderLiveCase(path.join(root, 'old'));
    const next = createLocalProviderLiveCase(path.join(root, 'next'));
    const stop = deferredOperation();
    const dispose = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    owned.harness = { svc: { stopTeam: vi.fn(() => stop.promise) }, dispose };
    owned.fakeServer = { close };
    owned.teamName = 'TEST-old-case';
    next.harness = {
      svc: { stopTeam: vi.fn(async () => undefined) },
      dispose: vi.fn(async () => undefined),
    };
    next.fakeServer = { close: vi.fn(async () => undefined) };
    const cases: LocalProviderLiveCases = { active: owned, enrolled: owned };
    const warn = vi.mocked(console.warn);
    try {
      await fs.mkdir(owned.tempClaudeRoot, { recursive: true });
      await fs.mkdir(next.tempClaudeRoot, { recursive: true });
      setClaudeBasePathOverride(owned.tempClaudeRoot);
      const cleanup = cleanupEnrolledLocalProviderLiveCase(cases);
      expect(cleanupLocalProviderLiveCase(owned, () => cases.active === owned)).toBe(cleanup);
      await Promise.resolve();
      cases.active = cases.enrolled = next;
      setClaudeBasePathOverride(next.tempClaudeRoot);
      console.warn('[getConfig] slow read diag=next-case');
      const nextWarnings = [...warn.mock.calls];
      stop.resolve();
      await cleanup;

      expect(dispose).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(next.harness.dispose).not.toHaveBeenCalled();
      expect(next.fakeServer.close).not.toHaveBeenCalled();
      expect(getTeamsBasePath()).toBe(next.teamsBasePath);
      expect(warn.mock.calls).toEqual(nextWarnings);
      await expect(fs.stat(next.tempDir)).resolves.toBeDefined();
    } finally {
      stop.resolve();
      await owned.cleanupPromise?.catch(() => undefined);
      warn.mockClear();
      setClaudeBasePathOverride(previousRoot);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the admission fence when a rejected next setup is followed by afterEach', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-case-admission-'));
    const previousRoot = path.dirname(getTeamsBasePath());
    const cases: LocalProviderLiveCases = { active: null, enrolled: null };
    const owned = enterLocalProviderLiveCase(cases, path.join(root, 'old'));
    const stop = deferredOperation();
    const stopTeam = vi.fn(() => stop.promise);
    const dispose = vi.fn(async () => undefined);
    owned.harness = { svc: { stopTeam }, dispose };
    owned.teamName = 'TEST-pending-case';
    try {
      setClaudeBasePathOverride(owned.tempClaudeRoot);
      const cleanup = cleanupEnrolledLocalProviderLiveCase(cases);
      await Promise.resolve();
      expect(() => enterLocalProviderLiveCase(cases, path.join(root, 'next'))).toThrow(
        'Previous case'
      );
      expect(cases.enrolled).toBeNull();
      await cleanupEnrolledLocalProviderLiveCase(cases);
      expect(() => enterLocalProviderLiveCase(cases, path.join(root, 'third'))).toThrow(
        'Previous case'
      );
      expect(stopTeam).toHaveBeenCalledTimes(1);
      expect(getTeamsBasePath()).toBe(owned.teamsBasePath);
      stop.resolve();
      await cleanup;
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(() =>
        enterLocalProviderLiveCase(cases, path.join(root, 'settled-next'))
      ).not.toThrow();
    } finally {
      stop.resolve();
      await owned.cleanupPromise?.catch(() => undefined);
      setClaudeBasePathOverride(previousRoot);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('verifies the original default lane root after Stop awaits across a root change', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-stop-root-snapshot-'));
    const previousRoot = path.dirname(getTeamsBasePath());
    const oldRoot = path.join(root, 'old');
    const nextRoot = path.join(root, 'next');
    const teamName = 'TEST-root-snapshot';
    const indexPath = getOpenCodeRuntimeLaneIndexPath(path.join(oldRoot, 'teams'), teamName);
    const stop = deferredOperation();
    try {
      await fs.mkdir(path.dirname(indexPath), { recursive: true });
      await fs.writeFile(
        indexPath,
        JSON.stringify({
          version: 1,
          updatedAt: 'now',
          lanes: {
            primary: { laneId: 'primary', state: 'active', updatedAt: 'now' },
          },
        })
      );
      setClaudeBasePathOverride(oldRoot);
      const verification = stopAndVerifyOpenCodeTeam({ stopTeam: () => stop.promise }, teamName, {
        timeoutMs: 20,
      });
      const rejected = expect(verification).rejects.toThrow('Timed out');
      setClaudeBasePathOverride(nextRoot);
      stop.resolve();
      await rejected;
      expect(getTeamsBasePath()).toBe(path.join(nextRoot, 'teams'));
      expect(await hasNoOpenCodeRuntimeLanes(path.join(oldRoot, 'teams'), teamName)).toBe(false);
    } finally {
      stop.resolve();
      setClaudeBasePathOverride(previousRoot);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not start another operation when an in-flight stage finishes after case closure', async () => {
    const owned = createLocalProviderLiveCase('/TEST-closed-stage');
    const first = deferredOperation();
    const next = vi.fn(async () => undefined);
    const running = runLiveCaseStage(owned, 'pending launch', () => first.promise, 1_000);
    const rejected = expect(running).rejects.toThrow(
      'closed before stage: pending launch completion'
    );
    await Promise.resolve();
    owned.closed = true;
    first.resolve();
    await rejected;
    await expect(runLiveCaseStage(owned, 'next delivery', next, 1_000)).rejects.toThrow(
      'closed before stage'
    );
    expect(next).not.toHaveBeenCalled();
    expect(owned.pending.size).toBe(0);
  });

  it('tracks a timed-out setup until settlement and disposes its late registered harness', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-late-setup-'));
    const owned = createLocalProviderLiveCase(root);
    const setup = deferredOperation();
    const dispose = vi.fn(async () => undefined);
    vi.useFakeTimers();
    try {
      const running = runLiveCaseStage(
        owned,
        'slow setup',
        async () => {
          await setup.promise;
          await registerLocalProviderHarness(owned, {
            svc: { stopTeam: vi.fn(async () => undefined) },
            dispose,
          });
        },
        10
      );
      const rejected = expect(running).rejects.toThrow('slow setup timed out after 10ms');
      await vi.advanceTimersByTimeAsync(11);
      await rejected;
      expect(owned.pending.size).toBe(1);
      expect(() => assertPreviousLiveCaseSettled(owned)).toThrow('Previous case');
      const cleanup = cleanupLocalProviderLiveCase(owned, () => false);
      setup.resolve();
      await cleanup;
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(owned.pending.size).toBe(0);
      expect(() => assertPreviousLiveCaseSettled(owned)).not.toThrow();
    } finally {
      setup.resolve();
      vi.useRealTimers();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('preserves the owned root and releases late resources only after pending setup settles', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-unsettled-setup-'));
    const previousRoot = path.dirname(getTeamsBasePath());
    const owned = createLocalProviderLiveCase(root);
    const setup = deferredOperation();
    const dispose = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    vi.useFakeTimers();
    try {
      setClaudeBasePathOverride(owned.tempClaudeRoot);
      const running = runLiveCaseStage(
        owned,
        'unsettled setup',
        async () => {
          await setup.promise;
          await registerLocalProviderHarness(owned, {
            svc: { stopTeam: vi.fn(async () => undefined) },
            dispose,
          });
          await registerLocalProviderFakeServer(owned, { close });
        },
        10
      );
      const rejected = expect(running).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(11);
      await rejected;
      const cleanup = cleanupLocalProviderLiveCase(owned, () => true);
      const failedCleanup = expect(cleanup).rejects.toThrow('settle owned operations timed out');
      await vi.advanceTimersByTimeAsync(30_001);
      await failedCleanup;
      expect(getTeamsBasePath()).toBe(owned.teamsBasePath);
      await expect(fs.stat(root)).resolves.toBeDefined();
      expect(dispose).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(() => assertPreviousLiveCaseSettled(owned)).toThrow('Previous case');
      setup.resolve();
      expect(owned.deferredReleasePromise).not.toBeNull();
      await owned.deferredReleasePromise;
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(owned.cleanupFailed).toBe(true);
      expect(() => assertPreviousLiveCaseSettled(owned)).toThrow('Previous case');
    } finally {
      setup.resolve();
      await owned.deferredReleasePromise;
      await Promise.allSettled([...owned.pending.keys()]);
      vi.useRealTimers();
      setClaudeBasePathOverride(previousRoot);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not dispose resources while an owned Stop is pending, then verifies and releases them', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-pending-stop-release-'));
    const owned = createLocalProviderLiveCase(root);
    const stop = deferredOperation();
    let stopCalls = 0;
    const stopTeam = vi.fn(() => {
      stopCalls += 1;
      return stopCalls === 1 ? stop.promise : Promise.resolve();
    });
    const dispose = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    owned.teamName = 'TEST-pending-stop-release';
    owned.harness = { svc: { stopTeam }, dispose };
    owned.fakeServer = { close };
    vi.useFakeTimers();
    try {
      const cleanup = cleanupLocalProviderLiveCase(owned, () => false);
      const failedCleanup = expect(cleanup).rejects.toThrow(
        'settle owned operations timed out after 30000ms'
      );
      await vi.advanceTimersByTimeAsync(360_001);
      await vi.advanceTimersByTimeAsync(30_001);
      await failedCleanup;
      expect(dispose).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();

      stop.resolve();
      expect(owned.deferredReleasePromise).not.toBeNull();
      await owned.deferredReleasePromise;
      expect(stopCalls).toBe(2);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(owned.cleanupFailed).toBe(true);
    } finally {
      stop.resolve();
      await owned.deferredReleasePromise;
      await Promise.allSettled([...owned.pending.keys()]);
      vi.useRealTimers();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('releases a server and harness acquired after case closure exactly once', async () => {
    const owned = createLocalProviderLiveCase('/TEST-late-resource-acquisition');
    owned.closed = true;
    const close = vi.fn(async () => undefined);
    const dispose = vi.fn(async () => undefined);
    await registerLocalProviderFakeServer(owned, { close });
    await registerLocalProviderHarness(owned, {
      svc: { stopTeam: vi.fn(async () => undefined) },
      dispose,
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(owned.fakeServer).toBeNull();
    expect(owned.harness).toBeNull();
  });

  it('reports the original Stop error together with disposal failures', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-cleanup-errors-'));
    const owned = createLocalProviderLiveCase(root);
    owned.teamName = 'TEST-stop-failure';
    owned.harness = {
      svc: {
        stopTeam: async () => {
          throw new Error('strict Stop rejected');
        },
      },
      dispose: async () => {
        throw new Error('dispose rejected');
      },
    };
    const close = vi.fn(async () => undefined);
    owned.fakeServer = { close };
    try {
      const error = await cleanupLocalProviderLiveCase(owned, () => false).catch(
        (cause: unknown) => cause
      );
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toHaveLength(2);
      expect((error as Error).message).toContain('strict Stop rejected');
      expect((error as Error).message).toContain('dispose rejected');
      expect(close).toHaveBeenCalledTimes(1);
      expect(() => assertPreviousLiveCaseSettled(owned)).toThrow('Previous case');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps both warning spies intact when Stop finishes after a spy replacement', async () => {
    const teamsBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-stop-warning-owner-'));
    const teamName = 'TEST-warning-owner';
    const warning = `[Service:TeamProvisioning] [${teamName}] Slow OpenCode stop: primary lane stop took 12345ms (stopped=true)`;
    const stop = deferredOperation();
    const originalWarn = console.warn;
    const capturedWarn = vi.mocked(originalWarn);
    const replacementWarn = vi.fn();
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      console.warn(warning);
      const verification = stopAndVerifyOpenCodeTeam({ stopTeam: () => stop.promise }, teamName, {
        teamsBasePath,
        isCurrentCase: () => true,
      });
      console.warn = replacementWarn;
      console.warn(warning);
      stop.resolve();
      await verification;
      expect(capturedWarn.mock.calls).toEqual([[warning]]);
      expect(replacementWarn.mock.calls).toEqual([[warning]]);
      expect(info).not.toHaveBeenCalled();
    } finally {
      stop.resolve();
      console.warn = originalWarn;
      capturedWarn.mockClear();
      info.mockRestore();
      await fs.rm(teamsBasePath, { recursive: true, force: true });
    }
  });

  it('retains only the owned restart metadata warning alongside pending stop diagnostics', () => {
    const teamName = 'TEST-owned-restart';
    const prefix = '[Service:TeamProvisioning]';
    const warning =
      `[${teamName}] Local model primary restart preflight warnings for bob: ` +
      'qwen-test:0.5b completed the Agent Teams task_briefing -> message_send ' +
      'coordination probe with valid tool arguments. Custom OpenAI-compatible server ' +
      'does not expose enough runtime metadata to prove the effective context size; ' +
      'use at least 16K (64K recommended).';
    const otherWarnings: unknown[][] = [
      [prefix, `[${teamName}] Slow OpenCode stop: primary lane stop took 11982ms (stopped=true)`],
      [prefix, warning.replace(teamName, 'TEST-other-team')],
      [prefix, warning.replace('for bob:', 'for alice:')],
      [prefix, warning.replace('with valid tool arguments', 'with invalid tool arguments')],
      [prefix, `${warning} Additional failure.`],
      [prefix, warning, new Error('restart failed')],
      ['unrelated warning'],
    ];
    const warn = vi.mocked(console.warn);
    const error = vi.mocked(console.error);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      console.warn(prefix, warning);
      for (const call of otherWarnings) console.warn(...call);
      console.error(prefix, warning);

      retainVerifiedLocalRestartWarning(teamName, 'bob');

      expect(warn.mock.calls).toEqual(otherWarnings);
      expect(error.mock.calls).toEqual([[prefix, warning]]);
      expect(info).toHaveBeenCalledExactlyOnceWith(
        `[OpenCodeLocalProviderAppLaunch.live] verified local restart: ${prefix} ${warning}`
      );
    } finally {
      warn.mockClear();
      error.mockClear();
      info.mockRestore();
    }
  });

  it.each(['absent', 'empty'] as const)(
    'retains slow-stop timing only after the owned stop succeeds and the lane index is %s',
    async (terminalIndex) => {
      const teamsBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-opencode-stop-'));
      const teamName = 'TEST-owned-stop';
      const indexPath = getOpenCodeRuntimeLaneIndexPath(teamsBasePath, teamName);
      const successfulWarning = `[Service:TeamProvisioning] [${teamName}] Slow OpenCode stop: primary lane stop took 10244ms (stopped=true)`;
      const otherWarnings: unknown[][] = [
        [successfulWarning.replace('stopped=true', 'stopped=false')],
        [successfulWarning.replace(teamName, 'TEST-other-team')],
        [successfulWarning.replace('10244ms', 'invalidms')],
        [`${successfulWarning} cleanup_unknown`],
        [`${successfulWarning}\n`],
        [successfulWarning, new Error('cleanup failed')],
        ['unrelated warning'],
      ];
      const warn = vi.mocked(console.warn);
      const error = vi.mocked(console.error);
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      try {
        const index = { version: 1, updatedAt: new Date().toISOString(), lanes: {} };
        await fs.mkdir(path.dirname(indexPath), { recursive: true });
        await fs.writeFile(
          indexPath,
          JSON.stringify({
            ...index,
            lanes: {
              primary: { laneId: 'primary', state: 'active', updatedAt: index.updatedAt },
            },
          }),
          'utf8'
        );
        console.warn(successfulWarning);
        const svc = {
          stopTeam: vi.fn(async () => {
            console.warn(successfulWarning);
            for (const call of otherWarnings) console.warn(...call);
            console.error(successfulWarning);
            if (terminalIndex === 'absent') await fs.rm(indexPath);
            else await fs.writeFile(indexPath, JSON.stringify(index), 'utf8');
          }),
        };

        await stopAndVerifyOpenCodeTeam(svc, teamName, { teamsBasePath });

        expect(svc.stopTeam).toHaveBeenCalledWith(teamName);
        expect(warn.mock.calls).toEqual([[successfulWarning], ...otherWarnings]);
        expect(error.mock.calls).toEqual([[successfulWarning]]);
        expect(info).toHaveBeenCalledExactlyOnceWith(
          `[OpenCodeLocalProviderAppLaunch.live] verified successful stop: ${successfulWarning}`
        );
      } finally {
        warn.mockClear();
        error.mockClear();
        info.mockRestore();
        await fs.rm(teamsBasePath, { recursive: true, force: true });
      }
    }
  );

  it.each(['stop rejected', 'corrupt index', 'nonempty index'] as const)(
    'keeps slow-stop warnings when verification fails: %s',
    async (failure) => {
      const teamsBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-opencode-stop-'));
      const teamName = 'TEST-owned-stop';
      const indexPath = getOpenCodeRuntimeLaneIndexPath(teamsBasePath, teamName);
      const warning = `[Service:TeamProvisioning] [${teamName}] Slow OpenCode stop: primary lane stop took 13564ms (stopped=true)`;
      const warn = vi.mocked(console.warn);
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      try {
        const raw =
          failure === 'corrupt index'
            ? '{'
            : JSON.stringify({
                version: 1,
                updatedAt: 'now',
                lanes:
                  failure === 'stop rejected'
                    ? {}
                    : {
                        primary: { laneId: 'primary', state: 'active', updatedAt: 'now' },
                      },
              });
        await fs.mkdir(path.dirname(indexPath), { recursive: true });
        await fs.writeFile(indexPath, raw, 'utf8');
        const svc = {
          stopTeam: async () => {
            console.warn(warning);
            if (failure === 'stop rejected') throw new Error('Stop rejected');
          },
        };

        const expectedError =
          failure === 'stop rejected'
            ? 'Stop rejected'
            : failure === 'corrupt index'
              ? SyntaxError
              : 'Timed out';
        await expect(
          stopAndVerifyOpenCodeTeam(svc, teamName, { teamsBasePath, timeoutMs: 50 })
        ).rejects.toThrow(expectedError);

        expect(warn.mock.calls).toEqual([[warning]]);
        expect(info).not.toHaveBeenCalled();
        expect(await fs.readFile(indexPath, 'utf8')).toBe(raw);
      } finally {
        warn.mockClear();
        info.mockRestore();
        await fs.rm(teamsBasePath, { recursive: true, force: true });
      }
    }
  );

  it('checks the canonical lane index without accepting corrupt evidence as empty', async () => {
    const teamsBasePath = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-opencode-lane-index-'));
    const teamName = 'TEST-lane-index';
    const indexPath = getOpenCodeRuntimeLaneIndexPath(teamsBasePath, teamName);
    try {
      expect(await hasNoOpenCodeRuntimeLanes(teamsBasePath, teamName)).toBe(true);
      await fs.mkdir(path.dirname(indexPath), { recursive: true });
      for (const corrupt of ['{', '{}', '{"version":1,"updatedAt":"now","lanes":[]}']) {
        await fs.writeFile(indexPath, corrupt, 'utf8');
        await expect(hasNoOpenCodeRuntimeLanes(teamsBasePath, teamName)).rejects.toThrow();
        await expect(readStrictOpenCodeRuntimeLaneIndex(teamsBasePath, teamName)).rejects.toThrow();
        expect(await fs.readFile(indexPath, 'utf8')).toBe(corrupt);
      }
      const index = { version: 1, updatedAt: new Date().toISOString(), lanes: {} };
      await fs.writeFile(indexPath, JSON.stringify(index), 'utf8');
      expect(await hasNoOpenCodeRuntimeLanes(teamsBasePath, teamName)).toBe(true);
      await fs.writeFile(
        indexPath,
        JSON.stringify({
          ...index,
          lanes: { primary: { laneId: 'primary', state: 'active', updatedAt: index.updatedAt } },
        }),
        'utf8'
      );
      expect(await hasNoOpenCodeRuntimeLanes(teamsBasePath, teamName)).toBe(false);

      await fs.rm(indexPath, { force: true });
      for (const quarantine of ['lanes.invalid.123.json', 'lanes.invalid.recovery.json']) {
        const quarantinePath = path.join(path.dirname(indexPath), quarantine);
        await fs.writeFile(quarantinePath, '{', 'utf8');
        await expect(hasNoOpenCodeRuntimeLanes(teamsBasePath, teamName)).rejects.toThrow(
          /Quarantined OpenCode lane index/
        );
        await fs.rm(quarantinePath, { force: true });
      }

      const readFileSpy = vi.spyOn(fs, 'readFile').mockImplementationOnce(async () => {
        await fs.writeFile(
          path.join(path.dirname(indexPath), 'lanes.invalid.race.json'),
          '{',
          'utf8'
        );
        throw Object.assign(new Error('lane index disappeared after quarantine'), {
          code: 'ENOENT',
        });
      });
      try {
        await expect(hasNoOpenCodeRuntimeLanes(teamsBasePath, teamName)).rejects.toThrow(
          /Quarantined OpenCode lane index/
        );
      } finally {
        readFileSpy.mockRestore();
        await fs.rm(path.join(path.dirname(indexPath), 'lanes.invalid.race.json'), {
          force: true,
        });
      }
    } finally {
      await fs.rm(teamsBasePath, { recursive: true, force: true });
    }
  });

  it.each([false, true])('echoes each fresh launch challenge (stream=%s)', async (stream) => {
    const server = await startFakeOpenAiCompatibleServer();
    try {
      const messages: { role: string; content: string }[] = [];
      for (const expected of [
        'STRICT_LAUNCH_8121c44a-d9f1-49bc-ad7a-1e4f2b0f133b',
        'STRICT_LAUNCH_d8ce926a-7b29-47d8-a921-08d5ea7a6626',
        'PONG',
      ]) {
        messages.push({
          role: 'user',
          content:
            expected === 'PONG'
              ? 'Output only the single word PONG.'
              : `Output only this exact token: ${expected}`,
        });
        const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'qwen-test:0.5b',
            stream,
            messages,
          }),
        });
        expect(response.status).toBe(200);
        const text = await response.text();
        const completion = JSON.parse(
          stream ? text.split('\n')[0].slice('data: '.length) : text
        ) as {
          choices: { delta?: { content?: string }; message?: { content?: string } }[];
        };
        expect(
          stream ? completion.choices[0].delta?.content : completion.choices[0].message?.content
        ).toBe(expected);
        messages.push({ role: 'assistant', content: expected });
      }
    } finally {
      await server.close();
    }
  });
});

interface FakeOpenAiCompatibleServer {
  baseUrl: string;
  port: number;
  requests: string[];
  chatBodies: unknown[];
  close: () => Promise<void>;
}

interface LocalProviderLiveCase {
  readonly tempDir: string;
  readonly tempClaudeRoot: string;
  readonly teamsBasePath: string;
  readonly startedAt: number;
  readonly progressEvents: TeamProvisioningProgress[];
  readonly pending: Map<Promise<unknown>, string>;
  harness: {
    svc: Pick<OpenCodeLiveHarness['svc'], 'stopTeam'>;
    dispose: () => Promise<void>;
  } | null;
  fakeServer: Pick<FakeOpenAiCompatibleServer, 'close'> | null;
  teamName: string | null;
  closed: boolean;
  cleanupFinished: boolean;
  cleanupFailed: boolean;
  cleanupPromise: Promise<void> | null;
  deferredReleasePromise: Promise<void> | null;
}

interface LocalProviderLiveCases {
  active: LocalProviderLiveCase | null;
  enrolled: LocalProviderLiveCase | null;
}

function deferredOperation() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function enterLocalProviderLiveCase(cases: LocalProviderLiveCases, tempDir: string) {
  // Vitest can call afterEach even when this admission fails. It must have no new owner.
  cases.enrolled = null;
  assertPreviousLiveCaseSettled(cases.active);
  const owned = createLocalProviderLiveCase(tempDir);
  cases.active = cases.enrolled = owned;
  return owned;
}

function cleanupEnrolledLocalProviderLiveCase(cases: LocalProviderLiveCases): Promise<void> {
  const owned = cases.enrolled;
  return owned
    ? cleanupLocalProviderLiveCase(owned, () => cases.active === owned)
    : Promise.resolve();
}

function createLocalProviderLiveCase(tempDir: string): LocalProviderLiveCase {
  return {
    tempDir,
    tempClaudeRoot: path.join(tempDir, '.claude'),
    teamsBasePath: path.join(tempDir, '.claude', 'teams'),
    startedAt: Date.now(),
    progressEvents: [],
    pending: new Map(),
    harness: null,
    fakeServer: null,
    teamName: null,
    closed: false,
    cleanupFinished: false,
    cleanupFailed: false,
    cleanupPromise: null,
    deferredReleasePromise: null,
  };
}

function assertPreviousLiveCaseSettled(owned: LocalProviderLiveCase | null): void {
  if (owned && (!owned.cleanupFinished || owned.cleanupFailed || owned.pending.size > 0)) {
    throw new Error(
      `Previous case ${owned.tempDir} has unfinished or failed cleanup; pending stages: ${
        [...owned.pending.values()].join(', ') || 'none'
      }`
    );
  }
}

function assertLiveCaseOpen(owned: LocalProviderLiveCase, stage: string): void {
  if (owned.closed) throw new Error(`Case ${owned.tempDir} closed before stage: ${stage}`);
}

async function runLiveCaseStage<T>(
  owned: LocalProviderLiveCase,
  stage: string,
  operation: () => Promise<T>,
  timeoutMs: number
): Promise<T> {
  assertLiveCaseOpen(owned, stage);
  return recordLiveCaseStage(
    owned,
    stage,
    async () => {
      assertLiveCaseOpen(owned, stage);
      const value = await operation();
      assertLiveCaseOpen(owned, `${stage} completion`);
      return value;
    },
    timeoutMs
  );
}

function waitForLiveCase(
  owned: LocalProviderLiveCase,
  stage: string,
  ...[condition, timeoutMs, intervalMs, diagnostics]: Parameters<typeof waitUntil>
): Promise<void> {
  const guardedDiagnostics = diagnostics
    ? async () => {
        assertLiveCaseOpen(owned, `${stage} diagnostics`);
        return diagnostics();
      }
    : undefined;
  return runLiveCaseStage(
    owned,
    stage,
    () =>
      waitUntil(
        async () => {
          assertLiveCaseOpen(owned, stage);
          return condition();
        },
        timeoutMs,
        intervalMs,
        guardedDiagnostics
      ),
    timeoutMs + 5_000
  );
}

async function readLiveRuntimeAndLaneEvidence(
  owned: LocalProviderLiveCase,
  harness: OpenCodeLiveHarness,
  teamName: string
) {
  assertLiveCaseOpen(owned, 'read recovery evidence');
  const [snapshotResult, laneIndexResult] = await Promise.allSettled([
    harness.svc.getTeamAgentRuntimeSnapshot(teamName),
    readStrictOpenCodeRuntimeLaneIndex(owned.teamsBasePath, teamName),
  ]);
  const failures = [snapshotResult, laneIndexResult].filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((result) => result.reason),
      `Unable to read complete runtime recovery evidence for ${teamName}`
    );
  }
  if (snapshotResult.status !== 'fulfilled' || laneIndexResult.status !== 'fulfilled') {
    throw new Error(`Incomplete runtime recovery evidence for ${teamName}`);
  }
  return { snapshot: snapshotResult.value, laneIndex: laneIndexResult.value };
}

async function recordLiveCaseStage<T>(
  owned: LocalProviderLiveCase,
  stage: string,
  operation: () => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const startedAt = Date.now();
  const label = `[OpenCodeLocalProviderAppLaunch.live] ${path.basename(owned.tempDir)} ${stage}`;
  console.info(`${label}: started (case elapsed ${startedAt - owned.startedAt}ms)`);
  const pending = Promise.resolve().then(operation);
  owned.pending.set(pending, stage);
  // A timeout rejects the waiter, not the operation. Keep its ownership until actual settlement.
  void pending.then(
    () => owned.pending.delete(pending),
    () => owned.pending.delete(pending)
  );
  try {
    const value = await withLiveStageTimeout(stage, pending, timeoutMs);
    console.info(
      `${label}: completed in ${Date.now() - startedAt}ms (case elapsed ${Date.now() - owned.startedAt}ms)`
    );
    return value;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `${label}: failed after ${Date.now() - startedAt}ms (case elapsed ${Date.now() - owned.startedAt}ms); ` +
        `latest progress: ${owned.progressEvents.at(-1)?.message ?? 'none'}; ${detail}`,
      { cause }
    );
  }
}

async function registerLocalProviderFakeServer<
  TServer extends Pick<FakeOpenAiCompatibleServer, 'close'>
>(
  owned: LocalProviderLiveCase,
  server: TServer
): Promise<TServer> {
  if (owned.closed) {
    await server.close();
    return server;
  }
  owned.fakeServer = server;
  return server;
}

async function registerLocalProviderHarness<
  THarness extends NonNullable<LocalProviderLiveCase['harness']>
>(owned: LocalProviderLiveCase, harness: THarness): Promise<THarness> {
  if (owned.closed) {
    await harness.dispose();
    return harness;
  }
  owned.harness = harness;
  return harness;
}

async function prepareLocalProviderLiveCase(
  owned: LocalProviderLiveCase,
  projectName: string,
  selectedModel: string
) {
  const projectPath = path.join(owned.tempDir, projectName);
  await runLiveCaseStage(
    owned,
    'prepare test project',
    () => fs.mkdir(projectPath, { recursive: true }),
    10_000
  );
  const fakeServer = await runLiveCaseStage(
    owned,
    'start local provider',
    async () => {
      const server = await startFakeOpenAiCompatibleServer();
      return registerLocalProviderFakeServer(owned, server);
    },
    10_000
  );
  await runLiveCaseStage(
    owned,
    'configure local provider',
    () =>
      writeFakeLocalOpenCodeConfig({
        projectPath,
        baseUrl: fakeServer.baseUrl,
      }),
    30_000
  );
  const harness = await runLiveCaseStage(
    owned,
    'create app harness',
    async () => {
      const created = await createOpenCodeLiveHarness({
        tempDir: owned.tempDir,
        selectedModel,
        projectPath,
        runtimeAdapterOptions: {
          inspectLocalModelRuntime: inspectOpenCodeLocalModelRuntimeReadiness,
        },
      });
      return registerLocalProviderHarness(owned, created);
    },
    30_000
  );
  return { projectPath, fakeServer, harness };
}

function cleanupLocalProviderLiveCase(
  owned: LocalProviderLiveCase,
  isCurrentCase: () => boolean
): Promise<void> {
  if (owned.cleanupPromise) return owned.cleanupPromise;
  owned.closed = true;
  const warningSpy = vi.mocked(console.warn);
  owned.cleanupPromise = (async () => {
    const errors: unknown[] = [];
    const attempt = async (stage: string, operation: () => Promise<unknown>, timeoutMs: number) => {
      try {
        await recordLiveCaseStage(owned, stage, operation, timeoutMs);
      } catch (error) {
        errors.push(error);
      }
    };
    // Worst case: 360s initial Stop + 30s settle + 360s final Stop + 30s dispose
    // + 10s server close + 10s temp cleanup = 800s; afterEach allows 840s.
    if (owned.harness && owned.teamName) {
      const { svc } = owned.harness;
      const teamName = owned.teamName;
      await attempt(
        'cleanup Stop and lane proof',
        () =>
          stopAndVerifyOpenCodeTeam(svc, teamName, {
            teamsBasePath: owned.teamsBasePath,
            isCurrentCase,
          }),
        360_000
      );
    }
    const pendingBeforeSettle = [...owned.pending.keys()];
    await attempt('settle owned operations', () => Promise.allSettled(pendingBeforeSettle), 30_000);

    if (owned.pending.size > 0) {
      errors.push(
        new Error(`Owned operations still pending: ${[...owned.pending.values()].join(', ')}`)
      );
      owned.deferredReleasePromise = deferOwnedLocalProviderResourceRelease(
        owned,
        isCurrentCase,
        [...owned.pending.keys()]
      );
    } else {
      if (pendingBeforeSettle.length > 0 && owned.harness && owned.teamName) {
        const { svc } = owned.harness;
        const teamName = owned.teamName;
        await attempt(
          'final Stop and lane proof after owned operations settle',
          () =>
            stopAndVerifyOpenCodeTeam(svc, teamName, {
              teamsBasePath: owned.teamsBasePath,
              isCurrentCase,
            }),
          360_000
        );
      }

      if (owned.pending.size > 0) {
        errors.push(
          new Error(`Owned operations still pending: ${[...owned.pending.values()].join(', ')}`)
        );
        owned.deferredReleasePromise = deferOwnedLocalProviderResourceRelease(
          owned,
          isCurrentCase,
          [...owned.pending.keys()]
        );
      } else {
        if (owned.harness) {
          const harness = owned.harness;
          const disposal = Promise.resolve().then(() => harness.dispose());
          await attempt('dispose owned harness', () => disposal, 30_000);
          if (owned.pending.size === 0 && owned.harness === harness) {
            owned.harness = null;
          } else if (owned.fakeServer) {
            owned.deferredReleasePromise = deferOwnedLocalProviderServerClose(
              owned,
              harness,
              disposal,
              owned.fakeServer
            );
          }
        }
        if (owned.fakeServer && owned.pending.size === 0) {
          const server = owned.fakeServer;
          await attempt('close owned local server', () => server.close(), 10_000);
          if (owned.pending.size === 0 && owned.fakeServer === server) owned.fakeServer = null;
        }
      }
    }

    if (owned.pending.size === 0) {
      if (isCurrentCase() && getTeamsBasePath() === owned.teamsBasePath) {
        setClaudeBasePathOverride(null);
        if (console.warn === warningSpy) clearBenignSlowConfigReadWarnings();
      }
      if (process.env.OPENCODE_E2E_KEEP_TEMP !== '1' && errors.length === 0) {
        await attempt(
          'remove owned test directory',
          () => fs.rm(owned.tempDir, { recursive: true, force: true }),
          10_000
        );
      } else {
        console.info(`[OpenCodeLocalProviderAppLaunch.live] preserved temp dir: ${owned.tempDir}`);
      }
    }
    owned.cleanupFinished = true;
    owned.cleanupFailed = errors.length > 0 || owned.pending.size > 0;
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Cleanup failed for ${owned.tempDir}: ${errors.map(String).join('; ')}`
      );
    }
  })();
  return owned.cleanupPromise;
}

function deferOwnedLocalProviderServerClose(
  owned: LocalProviderLiveCase,
  harness: NonNullable<LocalProviderLiveCase['harness']>,
  disposal: Promise<void>,
  server: NonNullable<LocalProviderLiveCase['fakeServer']>
): Promise<void> {
  const closeServer = async () => {
    if (owned.fakeServer !== server) return;
    try {
      await server.close();
      owned.fakeServer = null;
    } catch (error) {
      console.error(`Deferred fake server close failed for ${owned.tempDir}`, error);
    }
  };
  return disposal.then(
    async () => {
      if (owned.harness === harness) owned.harness = null;
      await closeServer();
    },
    async (error: unknown) => {
      console.error(`Owned harness disposal failed for ${owned.tempDir}`, error);
      if (owned.harness === harness) owned.harness = null;
      await closeServer();
    }
  );
}

function deferOwnedLocalProviderResourceRelease(
  owned: LocalProviderLiveCase,
  isCurrentCase: () => boolean,
  pending: Promise<unknown>[]
): Promise<void> {
  return Promise.allSettled(pending)
    .then(async () => {
      await Promise.resolve();
      if (owned.pending.size > 0) {
        return deferOwnedLocalProviderResourceRelease(owned, isCurrentCase, [
          ...owned.pending.keys(),
        ]);
      }

      const errors: unknown[] = [];
      if (owned.harness && owned.teamName) {
        try {
          await stopAndVerifyOpenCodeTeam(owned.harness.svc, owned.teamName, {
            teamsBasePath: owned.teamsBasePath,
            isCurrentCase,
          });
        } catch (error) {
          errors.push(error);
        }
      }
      if (owned.harness) {
        try {
          const harness = owned.harness;
          await harness.dispose();
          if (owned.harness === harness) owned.harness = null;
        } catch (error) {
          errors.push(error);
        }
      }
      if (owned.fakeServer) {
        try {
          const server = owned.fakeServer;
          await server.close();
          if (owned.fakeServer === server) owned.fakeServer = null;
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        console.error(
          new AggregateError(errors, `Deferred resource release failed for ${owned.tempDir}`)
        );
      }
    })
    .catch((error: unknown) => {
      console.error(`Deferred resource release failed for ${owned.tempDir}`, error);
    });
}

async function stopAndVerifyOpenCodeTeam(
  svc: Pick<OpenCodeLiveHarness['svc'], 'stopTeam'>,
  teamName: string,
  options: { teamsBasePath?: string; timeoutMs?: number; isCurrentCase?: () => boolean } = {}
): Promise<void> {
  const teamsBasePath = options.teamsBasePath ?? getTeamsBasePath();
  const warn = console.warn;
  const warningSpy = vi.isMockFunction(warn) ? vi.mocked(warn) : null;
  const warningStart = warningSpy?.mock.calls.length ?? 0;
  await svc.stopTeam(teamName);
  const timeoutMs = options.timeoutMs ?? 90_000;
  await waitUntil(
    () => hasNoOpenCodeRuntimeLanes(teamsBasePath, teamName),
    timeoutMs,
    Math.min(500, timeoutMs)
  );

  // Source-launcher overhead can cross the production timing warning threshold.
  // Accept only this owned, verified stop, and retain its latency in the evidence.
  const prefix = `[Service:TeamProvisioning] [${teamName}] Slow OpenCode stop: primary lane stop took `;
  if (
    !warningSpy ||
    console.warn !== warn ||
    (options.isCurrentCase && !options.isCurrentCase())
  ) {
    return;
  }
  for (let index = warningSpy.mock.calls.length - 1; index >= warningStart; index -= 1) {
    const rendered = warningSpy.mock.calls[index].map((part) => String(part)).join(' ');
    if (
      rendered.startsWith(prefix) &&
      rendered.endsWith('(stopped=true)') &&
      /^\d+ms \(stopped=true\)$/.test(rendered.slice(prefix.length))
    ) {
      console.info(`[OpenCodeLocalProviderAppLaunch.live] verified successful stop: ${rendered}`);
      warningSpy.mock.calls.splice(index, 1);
    }
  }
}

async function readStrictOpenCodeRuntimeLaneIndex(
  teamsBasePath: string,
  teamName: string
): Promise<OpenCodeRuntimeLaneIndex> {
  const indexPath = getOpenCodeRuntimeLaneIndexPath(teamsBasePath, teamName);
  const raw = await fs.readFile(indexPath, 'utf8');
  return parseStrictOpenCodeRuntimeLaneIndex(raw, indexPath);
}

function parseStrictOpenCodeRuntimeLaneIndex(
  raw: string,
  indexPath: string
): OpenCodeRuntimeLaneIndex {
  const parsed: unknown = JSON.parse(raw);
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.updatedAt !== 'string' ||
    !isRecord(parsed.lanes)
  ) {
    throw new Error(`Invalid OpenCode lane index: ${indexPath}`);
  }
  for (const [laneId, entry] of Object.entries(parsed.lanes)) {
    if (
      !isRecord(entry) ||
      entry.laneId !== laneId ||
      typeof entry.updatedAt !== 'string' ||
      (entry.state !== 'active' && entry.state !== 'stopped' && entry.state !== 'degraded') ||
      (entry.diagnostics !== undefined &&
        (!Array.isArray(entry.diagnostics) ||
          !entry.diagnostics.every((diagnostic) => typeof diagnostic === 'string')))
    ) {
      throw new Error(`Invalid OpenCode lane entry ${laneId}: ${indexPath}`);
    }
  }
  return parsed as unknown as OpenCodeRuntimeLaneIndex;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function assertNoQuarantinedOpenCodeLaneIndex(runtimeDirectory: string): Promise<void> {
  let runtimeFiles: string[];
  try {
    runtimeFiles = await fs.readdir(runtimeDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const quarantinedIndexes = runtimeFiles.filter((name) =>
    /^lanes\.invalid\..+\.json$/.test(name)
  );
  if (quarantinedIndexes.length > 0) {
    throw new Error(
      `Quarantined OpenCode lane index: ${quarantinedIndexes.join(', ')} in ${runtimeDirectory}`
    );
  }
}

async function hasNoOpenCodeRuntimeLanes(
  teamsBasePath: string,
  teamName: string
): Promise<boolean> {
  const indexPath = getOpenCodeRuntimeLaneIndexPath(teamsBasePath, teamName);
  const runtimeDirectory = path.dirname(indexPath);
  await assertNoQuarantinedOpenCodeLaneIndex(runtimeDirectory);
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // A quarantine may have completed between the initial listing and this read.
      await assertNoQuarantinedOpenCodeLaneIndex(runtimeDirectory);
      return true;
    }
    throw error;
  }
  const parsed = parseStrictOpenCodeRuntimeLaneIndex(raw, indexPath);
  return Object.keys(parsed.lanes).length === 0;
}

async function startFakeOpenAiCompatibleServer(port = 0): Promise<FakeOpenAiCompatibleServer> {
  const requests: string[] = [];
  const chatBodies: unknown[] = [];
  const server = http.createServer(async (request, response) => {
    requests.push(`${request.method ?? 'GET'} ${request.url ?? '/'}`);
    if (
      request.method === 'OPTIONS' &&
      (request.url === '/v1/models' || request.url === '/v1/chat/completions')
    ) {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'accept, content-type, authorization',
      });
      response.end();
      return;
    }
    if (request.url === '/v1/models') {
      response.setHeader('access-control-allow-origin', '*');
      sendJson(response, 200, {
        object: 'list',
        data: [{ id: 'qwen-test:0.5b', object: 'model' }],
      });
      return;
    }

    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      const body = JSON.parse((await readRequestBody(request)) || '{}') as {
        stream?: boolean;
        messages?: Array<{ role?: string; content?: unknown }>;
        tools?: unknown[];
      };
      chatBodies.push(body);
      const serializedBody = JSON.stringify(body);
      if (
        Array.isArray(body.tools) &&
        serializedBody.includes('Agent Teams teammate compatibility test')
      ) {
        const toolResult = body.messages?.findLast((message) => message.role === 'tool');
        if (!toolResult) {
          sendJson(response, 200, {
            id: 'chatcmpl-local-probe-briefing',
            object: 'chat.completion',
            model: 'qwen-test:0.5b',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'local-probe-call-1',
                      type: 'function',
                      function: {
                        name: 'agent_teams_task_briefing',
                        arguments: JSON.stringify({
                          teamName: 'agent-teams-local-probe',
                          memberName: 'probe-member',
                        }),
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          });
          return;
        }

        const nonceMatch =
          typeof toolResult.content === 'string'
            ? toolResult.content.match(/exact text (local-probe-[a-z0-9]+)/i)
            : null;
        sendJson(response, 200, {
          id: 'chatcmpl-local-probe-message',
          object: 'chat.completion',
          model: 'qwen-test:0.5b',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'local-probe-call-2',
                    type: 'function',
                    function: {
                      name: 'agent_teams_message_send',
                      arguments: JSON.stringify({
                        teamName: 'agent-teams-local-probe',
                        to: 'probe-lead',
                        from: 'probe-member',
                        text: nonceMatch?.[1] ?? 'missing-probe-nonce',
                        summary: 'Compatibility probe',
                      }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        });
        return;
      }
      const prompt = JSON.stringify(
        body.messages?.findLast((message) => message.role === 'user')?.content ?? ''
      );
      const content =
        /Output only this exact token: (STRICT_LAUNCH_[A-Za-z0-9_-]+)/.exec(prompt)?.[1] ?? 'PONG';
      if (body.stream) {
        const created = Math.floor(Date.now() / 1000);
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created,
            model: 'qwen-test:0.5b',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content },
                finish_reason: null,
              },
            ],
          })}\n\n`
        );
        response.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion.chunk',
            created,
            model: 'qwen-test:0.5b',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n`
        );
        response.end('data: [DONE]\n\n');
        return;
      }

      sendJson(response, 200, {
        id: 'chatcmpl-test',
        object: 'chat.completion',
        model: 'qwen-test:0.5b',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
      });
      return;
    }

    sendJson(response, 404, { error: { message: 'not found' } });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Fake OpenAI-compatible server did not bind to a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    chatBodies,
    close: () => closeServer(server),
  };
}

async function writeFakeLocalOpenCodeConfig(input: {
  projectPath: string;
  baseUrl: string;
}): Promise<void> {
  const response = await new OpenCodeLocalProviderConnector().configureLocalProvider({
    runtimeId: 'opencode',
    scope: 'project',
    projectPath: input.projectPath,
    presetId: 'custom',
    providerId: LOCAL_PROVIDER_ID,
    baseUrl: input.baseUrl,
    defaultModelId: 'qwen-test:0.5b',
    setAsDefault: true,
  });
  if (response.error) {
    throw new Error(`Local provider onboarding failed: ${response.error.message}`);
  }
}

async function readRequestBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
    server.closeIdleConnections();
  });
}

async function withLiveStageTimeout<T>(
  stage: string,
  operation: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${stage} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function clearBenignSlowConfigReadWarnings(): void {
  const warn = vi.mocked(console.warn);
  if (
    warn.mock.calls.length > 0 &&
    warn.mock.calls.every((call) =>
      call
        .map((part) => String(part))
        .join(' ')
        .includes('[getConfig] slow read diag=')
    )
  ) {
    warn.mockClear();
  }
}

function clearExpectedLocalServerOutageErrors(port: number): void {
  const error = vi.mocked(console.error);
  if (
    error.mock.calls.length > 0 &&
    error.mock.calls.every((call) => {
      const message = call.map((part) => String(part)).join(' ');
      return message.includes('ECONNREFUSED') && message.includes(`127.0.0.1:${port}`);
    })
  ) {
    error.mockClear();
  }
}

function retainVerifiedLocalRestartWarning(teamName: string, memberName: string): void {
  // Called only after restart, live-lane recovery and fresh message delivery pass.
  // Other warnings, including stop timing awaiting cleanup proof, stay visible.
  const prefix = '[Service:TeamProvisioning]';
  const warning =
    `[${teamName}] Local model primary restart preflight warnings for ${memberName}: ` +
    'qwen-test:0.5b completed the Agent Teams task_briefing -> message_send ' +
    'coordination probe with valid tool arguments. Custom OpenAI-compatible server ' +
    'does not expose enough runtime metadata to prove the effective context size; ' +
    'use at least 16K (64K recommended).';
  const warn = vi.mocked(console.warn);
  for (let index = warn.mock.calls.length - 1; index >= 0; index -= 1) {
    const call = warn.mock.calls[index];
    if (call.length === 2 && call[0] === prefix && call[1] === warning) {
      console.info(
        `[OpenCodeLocalProviderAppLaunch.live] verified local restart: ${prefix} ${warning}`
      );
      warn.mock.calls.splice(index, 1);
    }
  }
}
