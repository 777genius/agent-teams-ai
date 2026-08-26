import { readDurableLaunchContinuationEvidence } from '@main/services/team/provisioning/TeamProvisioningLaunchContinuationState';
import { TEAM_LAUNCH, TEAM_PREPARE_PROVISIONING } from '@preload/constants/ipcChannels';
import * as fs from 'fs/promises';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFakeDesktopAuthorityFidelityHarness } from './helpers/fakeDesktopAuthorityFidelityHarness';

import type { FakeDesktopAuthorityFidelityHarness } from './helpers/fakeDesktopAuthorityFidelityHarness';
import type { TeamCreateResponse, TeamProvisioningPrepareResult } from '@shared/types';

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'en'), getPath: vi.fn(() => '/tmp'), isPackaged: false },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  Notification: Object.assign(vi.fn(), { isSupported: vi.fn(() => false) }),
}));

vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: { resolve: vi.fn(async () => '/fake/final-effect/claude') },
}));

vi.mock('@main/utils/childProcess', () => ({
  execCli: vi.fn(async () => ({ stdout: '', stderr: '' })),
  spawnCli: vi.fn(),
  killProcessTree: vi.fn(),
  killProcessTreeAndWait: vi.fn(async (child?: { emit?: (...args: unknown[]) => void }) => {
    child?.emit?.('close', null, 'SIGKILL');
  }),
}));

vi.mock('@features/tmux-installer/main', () => ({
  isTmuxRuntimeReadyForCurrentPlatform: vi.fn(async () => true),
  killTmuxPaneForCurrentPlatformSync: vi.fn(),
  listRuntimeProcessTableForCurrentPlatform: vi.fn(async () => []),
  listTmuxPanePidsForCurrentPlatform: vi.fn(async () => new Map()),
  listTmuxPaneRuntimeInfoForCurrentPlatform: vi.fn(async () => new Map()),
  sendKeysToTmuxPaneForCurrentPlatform: vi.fn(async () => undefined),
}));

describe.sequential(
  'Desktop renderer/preload/IPC to production preparation and create orchestration',
  () => {
    let harness: FakeDesktopAuthorityFidelityHarness | null = null;

    afterEach(async () => {
      await harness?.cleanup();
      harness = null;
      vi.useRealTimers();
    });

    async function createHarness(
      options: Parameters<typeof createFakeDesktopAuthorityFidelityHarness>[0] = {}
    ): Promise<FakeDesktopAuthorityFidelityHarness> {
      harness = await createFakeDesktopAuthorityFidelityHarness(options);
      return harness;
    }

    it('uses the real preparation coordinator and TeamProvisioningService create path before fake runtime evidence commits the roster', async () => {
      const runtime = await createHarness();
      await runtime.assertNoRuntimeArtifacts();

      const authorization = await runtime.prepare();

      expect(runtime.probes).toEqual([
        expect.objectContaining({
          cwd: runtime.project,
          mode: 'deep',
          checks: [
            expect.objectContaining({
              providerId: 'anthropic',
              providerBackendId: null,
              model: 'claude',
            }),
          ],
        }),
      ]);
      expect(authorization).toMatchObject({
        prepareState: 'ready',
        providerStatusesAuthoritative: true,
        executionProof: {
          authorityId: expect.any(String),
          requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      await runtime.assertNoRuntimeArtifacts();

      await expect(runtime.launch()).resolves.toBe(true);

      expect(runtime.effects).toEqual({ sessions: 1, processes: 1, terminals: 1 });
      await expect(
        runtime.service.getRosterAuthorizationTransactionOutcome(
          runtime.teamName,
          runtime.transactionId
        )
      ).resolves.toMatchObject({ status: 'committed', launchRunId: runtime.transactionId });
    });

    it.each([
      [
        'passive status',
        (runtime: FakeDesktopAuthorityFidelityHarness) => runtime.makeStatusPassive(),
      ],
      [
        'stale catalog',
        (runtime: FakeDesktopAuthorityFidelityHarness) => runtime.makeCatalogStale(),
      ],
      [
        'changed auth fingerprint',
        (runtime: FakeDesktopAuthorityFidelityHarness) => runtime.changeAuthFingerprint(),
      ],
      [
        'changed config fingerprint',
        (runtime: FakeDesktopAuthorityFidelityHarness) => runtime.changeConfigFingerprint(),
      ],
    ])(
      'rejects a prepared proof after %s without creating runtime state',
      async (_label, mutate) => {
        const runtime = await createHarness();
        await runtime.prepare();
        mutate(runtime);

        await expect(runtime.launch()).resolves.toBe(false);
        await runtime.assertNoRuntimeArtifacts();
      }
    );

    it.each([
      ['project', { cwd: 'other-project' }],
      ['provider', { providerId: 'codex', providerBackendId: 'codex-native', model: 'gpt-5' }],
      ['model', { model: 'claude-stale' }],
    ])(
      'rejects a proof bound to the wrong %s before roster or runtime creation',
      async (_label, patch) => {
        const runtime = await createHarness();
        const authorization = await runtime.prepare();
        const otherProject = path.join(runtime.sandbox, 'other-project');
        await fs.mkdir(otherProject);
        const cwd =
          'cwd' in patch && patch.cwd === 'other-project' ? otherProject : runtime.project;

        const response = await runtime.invokeRaw<TeamCreateResponse>(TEAM_LAUNCH, {
          teamName: runtime.teamName,
          providerId: 'anthropic',
          model: 'claude',
          leadRuntimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'default',
            model: 'explicit',
            effort: 'default',
          },
          executionProof: authorization.executionProof,
          ...patch,
          cwd,
        });

        expect(response).toMatchObject({
          success: false,
          error: 'Fresh authoritative launch authorization is required',
        });
        await runtime.assertNoRuntimeArtifacts();
      }
    );

    it.each([
      [
        'nonce',
        (proof: NonNullable<TeamProvisioningPrepareResult['executionProof']>) => ({
          ...proof,
          authorityId: '00000000-0000-4000-8000-000000000000',
        }),
      ],
      [
        'generation',
        (proof: NonNullable<TeamProvisioningPrepareResult['executionProof']>) => ({
          ...proof,
          generation: proof.generation + 1,
        }),
      ],
      [
        'completion time',
        (proof: NonNullable<TeamProvisioningPrepareResult['executionProof']>) => ({
          ...proof,
          completedAt: new Date(0).toISOString(),
        }),
      ],
      [
        'deadline',
        (proof: NonNullable<TeamProvisioningPrepareResult['executionProof']>) => ({
          ...proof,
          expiresAt: new Date(0).toISOString(),
        }),
      ],
      [
        'request digest',
        (proof: NonNullable<TeamProvisioningPrepareResult['executionProof']>) => ({
          ...proof,
          requestDigest: '0'.repeat(64),
        }),
      ],
    ])('rejects a proof with the wrong %s before any final-effect port', async (_label, mutate) => {
      const runtime = await createHarness();
      const authorization = await runtime.prepare();
      const response = await runtime.invokeRaw<TeamCreateResponse>(TEAM_LAUNCH, {
        teamName: runtime.teamName,
        cwd: runtime.project,
        providerId: 'anthropic',
        model: 'claude',
        leadRuntimeSelectionProvenance: {
          version: 1,
          providerBackendId: 'default',
          model: 'explicit',
          effort: 'default',
        },
        executionProof: mutate(authorization.executionProof!),
      });

      expect(response).toMatchObject({ success: false });
      await runtime.assertNoRuntimeArtifacts();
    });

    it('keeps an evidence-free transport outcome launch-unknown and never auto-redispatches its exact command', async () => {
      const runtime = await createHarness();
      await runtime.prepare();
      runtime.setDispatchEvidence('unknown');

      await expect(runtime.launch()).rejects.toThrow('launch-unknown');
      expect(runtime.effects).toEqual({ sessions: 1, processes: 1, terminals: 1 });
      await expect(runtime.launch()).rejects.toThrow();
      expect(runtime.effects).toEqual({ sessions: 1, processes: 1, terminals: 1 });
      await expect(
        runtime.service.getRosterAuthorizationTransactionOutcome(
          runtime.teamName,
          runtime.transactionId
        )
      ).resolves.toMatchObject({ status: 'launch-unknown' });
    });

    it('cancels authority before deferred proof issuance without dispatching', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-26T00:00:00.000Z'));
      const runtime = await createHarness();
      const probe = runtime.deferProbe();
      const prepare = runtime.prepare();
      await probe.started;

      runtime.invalidateAuthority();
      vi.setSystemTime(new Date('2026-08-26T00:00:30.000Z'));
      probe.resolve();

      await expect(prepare).rejects.toThrow('epoch changed during preparation');
      expect(runtime.authorization().executionProof).toBeNull();
      await runtime.assertNoRuntimeArtifacts();
    });

    it('cancels authority after proof without extending its absolute deadline or dispatching', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-26T00:00:00.000Z'));
      const runtime = await createHarness();
      const authorization = await runtime.prepare();
      const absoluteDeadline = authorization.executionProof!.expiresAt;

      runtime.invalidateAuthority();
      vi.setSystemTime(new Date('2026-08-26T00:00:30.000Z'));

      expect(authorization.executionProof!.expiresAt).toBe(absoluteDeadline);
      await expect(runtime.launch(authorization)).rejects.toThrow(
        'Fresh authoritative launch authorization is required'
      );
      await runtime.assertNoRuntimeArtifacts();
    });

    it('preserves member one across a controlled two-member partial result and retries only cleaned member two through a fresh real launch', async () => {
      const runtime = await createHarness({ memberNames: ['alice', 'bob'] });
      runtime.setDispatchEvidence('partial-then-retry');
      await runtime.prepare();

      await expect(runtime.launch()).resolves.toBe(true);
      expect(runtime.memberEffects).toEqual({
        creates: { alice: 1, bob: 0 },
        cleanups: { bob: 1 },
      });

      await runtime.provisioning.cancelProvisioning(runtime.transactionId);
      const durableEvidence = await readDurableLaunchContinuationEvidence(runtime.teamName);
      expect(durableEvidence.kind).toBe('evidence');
      const retryAuthorization = await runtime.prepare();
      await expect(readDurableLaunchContinuationEvidence(runtime.teamName)).resolves.toMatchObject({
        kind: 'evidence',
      });
      await expect(
        runtime.launch(retryAuthorization, '66666666-6666-4666-8666-666666666666')
      ).resolves.toBe(true);
      expect(runtime.memberEffects).toEqual({
        creates: { alice: 1, bob: 1 },
        cleanups: { bob: 1 },
      });
      expect(runtime.effects).toEqual({ sessions: 2, processes: 2, terminals: 2 });
      expect(
        runtime.dispatchedSpecs.map((spec) => spec.members.map((member) => member.name))
      ).toEqual([['alice', 'bob'], ['bob']]);
      expect(runtime.dispatchedSpecs[1]?.launch?.continuation).toMatchObject({
        sourceRunId: runtime.transactionId,
        preservedMembers: [{ name: 'alice', runtimeRunId: runtime.transactionId }],
        retryMembers: [{ name: 'bob', cleanupRunId: runtime.transactionId }],
      });
    });

    it('reconstructs the exact partial continuation from disk after transient app state is restarted', async () => {
      const runtime = await createHarness({ memberNames: ['alice', 'bob'] });
      runtime.setDispatchEvidence('partial-then-retry');
      await runtime.prepare();
      await expect(runtime.launch()).resolves.toBe(true);
      await runtime.provisioning.cancelProvisioning(runtime.transactionId);

      runtime.simulateRestart();
      const authorization = await runtime.prepare();
      await expect(
        runtime.launch(authorization, '67676767-6767-4676-8676-676767676767')
      ).resolves.toBe(true);

      expect(runtime.dispatchedSpecs[1]?.members.map((member) => member.name)).toEqual(['bob']);
      expect(runtime.memberEffects.creates).toEqual({ alice: 1, bob: 1 });
    });

    it('fails closed on stale continuation proof before redispatch', async () => {
      const runtime = await createHarness({ memberNames: ['alice', 'bob'] });
      runtime.setDispatchEvidence('partial-then-retry');
      await runtime.prepare();
      await runtime.launch();
      await runtime.provisioning.cancelProvisioning(runtime.transactionId);
      await runtime.makeContinuationProofStale();

      const authorization = await runtime.prepare();
      await expect(
        runtime.launch(authorization, '68686868-6868-4686-8686-686868686868')
      ).rejects.toThrow(/continuation/i);
      vi.mocked(console.error).mockClear();
      expect(runtime.effects).toEqual({ sessions: 1, processes: 1, terminals: 1 });
    });

    it('fails closed when a configured member changes after partial success', async () => {
      const runtime = await createHarness({ memberNames: ['alice', 'bob'] });
      runtime.setDispatchEvidence('partial-then-retry');
      await runtime.prepare();
      await runtime.launch();
      await runtime.provisioning.cancelProvisioning(runtime.transactionId);
      await runtime.changeConfiguredMemberRole('bob', 'changed-role');

      const authorization = await runtime.prepare();
      await expect(
        runtime.launch(authorization, '69696969-6969-4696-8696-696969696969')
      ).rejects.toThrow(/configuration/i);
      vi.mocked(console.error).mockClear();
      expect(runtime.effects.sessions).toBe(1);
    });

    it.each([
      [
        'removed',
        (runtime: FakeDesktopAuthorityFidelityHarness) => runtime.removeConfiguredMember('bob'),
      ],
      [
        'added',
        (runtime: FakeDesktopAuthorityFidelityHarness) => runtime.addConfiguredMember('carol'),
      ],
    ])('fails closed when a member is %s after partial success', async (_label, mutate) => {
      const runtime = await createHarness({ memberNames: ['alice', 'bob'] });
      runtime.setDispatchEvidence('partial-then-retry');
      await runtime.prepare();
      await runtime.launch();
      await runtime.provisioning.cancelProvisioning(runtime.transactionId);
      await mutate(runtime);

      const authorization = await runtime.prepare();
      await expect(
        runtime.launch(
          authorization,
          `70707070-7070-4707-8707-70707070707${_label === 'added' ? '1' : '0'}`
        )
      ).rejects.toThrow(/configuration|roster/i);
      vi.mocked(console.error).mockClear();
      expect(runtime.effects.sessions).toBe(1);
    });

    it.each(['duplicate', 'unknown'] as const)(
      'fails closed on a %s continuation outcome',
      async (outcome) => {
        const runtime = await createHarness({ memberNames: ['alice', 'bob'] });
        runtime.setDispatchEvidence('partial-then-retry');
        await runtime.prepare();
        await runtime.launch();
        await runtime.provisioning.cancelProvisioning(runtime.transactionId);
        await runtime.makeContinuationOutcomeAmbiguous(outcome);

        const authorization = await runtime.prepare();
        await expect(
          runtime.launch(authorization, '71717171-7171-4717-8717-717171717171')
        ).rejects.toThrow(/continuation|roster/i);
        vi.mocked(console.error).mockClear();
        expect(runtime.effects.sessions).toBe(1);
      }
    );

    it('treats exact completed continuation evidence as idempotent after restart', async () => {
      const runtime = await createHarness({ memberNames: ['alice', 'bob'] });
      runtime.setDispatchEvidence('partial-then-retry');
      await runtime.prepare();
      await runtime.launch();
      await runtime.provisioning.cancelProvisioning(runtime.transactionId);
      const retry = await runtime.prepare();
      const retryId = '72727272-7272-4727-8727-727272727272';
      await runtime.launch(retry, retryId);
      await runtime.provisioning.cancelProvisioning(retryId);
      runtime.simulateRestart();

      const idempotent = await runtime.prepare();
      await expect(
        runtime.launch(idempotent, '73737373-7373-4737-8737-737373737373')
      ).resolves.toBe(false);
      expect(runtime.effects).toEqual({ sessions: 2, processes: 2, terminals: 2 });
      expect(runtime.memberEffects.creates).toEqual({ alice: 1, bob: 1 });
    });

    it('consumes a production proof once and rejects reuse before a second fake session', async () => {
      const runtime = await createHarness();
      const authorization = await runtime.prepare();
      await expect(runtime.launch()).resolves.toBe(true);

      const replay = await runtime.invokeRaw<TeamCreateResponse>(TEAM_LAUNCH, {
        teamName: runtime.teamName,
        cwd: runtime.project,
        providerId: 'anthropic',
        model: 'claude',
        leadRuntimeSelectionProvenance: {
          version: 1,
          providerBackendId: 'default',
          model: 'explicit',
          effort: 'default',
        },
        executionProof: authorization.executionProof,
      });

      expect(replay).toMatchObject({ success: false });
      expect(runtime.effects).toEqual({ sessions: 1, processes: 1, terminals: 1 });
    });

    it('mints a fresh nonce for the exact fingerprint and invalidates the superseded proof', async () => {
      const runtime = await createHarness();
      const superseded = await runtime.prepare();
      const fresh = await runtime.prepare();

      expect(fresh.executionProof?.authorityId).not.toBe(superseded.executionProof?.authorityId);
      expect(fresh.executionProof?.generation).toBeGreaterThan(
        superseded.executionProof?.generation ?? 0
      );
      const staleResponse = await runtime.invokeRaw<TeamCreateResponse>(TEAM_LAUNCH, {
        teamName: runtime.teamName,
        cwd: runtime.project,
        providerId: 'anthropic',
        model: 'claude',
        leadRuntimeSelectionProvenance: {
          version: 1,
          providerBackendId: 'default',
          model: 'explicit',
          effort: 'default',
        },
        executionProof: superseded.executionProof,
      });
      expect(staleResponse).toMatchObject({
        success: false,
        error: 'Fresh authoritative launch authorization is required',
      });
      await runtime.assertNoRuntimeArtifacts();

      await expect(runtime.launch(fresh)).resolves.toBe(true);
      expect(runtime.effects).toEqual({ sessions: 1, processes: 1, terminals: 1 });
    });

    it('rejects missing and legacy fields plus display-ready state without proof', async () => {
      const runtime = await createHarness();
      const missingProof = {
        prepareState: 'ready',
        providerStatusesAuthoritative: true,
        preparedRequestSignature: 'display-ready',
        currentRequestSignature: 'display-ready',
        preparedGeneration: 1,
        currentGeneration: 1,
        providerProofExpiresAtMs: Date.now() + 30_000,
        executionProof: null,
      } as const;

      await expect(runtime.launch(missingProof)).resolves.toBe(false);
      const legacyPrepare = await runtime.invokeRaw<TeamProvisioningPrepareResult>(
        TEAM_PREPARE_PROVISIONING,
        runtime.project,
        'anthropic',
        ['anthropic'],
        ['claude'],
        false,
        'deep',
        [{ providerId: 'anthropic', model: 'claude' }],
        false,
        'legacy-roster-revision'
      );
      expect(legacyPrepare).toMatchObject({
        success: false,
        error: expect.stringContaining('explicit providerBackendId'),
      });
      const missingLaunchProof = await runtime.invokeRaw<TeamCreateResponse>(TEAM_LAUNCH, {
        teamName: runtime.teamName,
        cwd: runtime.project,
        providerId: 'anthropic',
        model: 'claude',
      });
      expect(missingLaunchProof).toMatchObject({ success: false });
      await runtime.assertNoRuntimeArtifacts();
    });

    it.each(['timeout', 'transient'] as const)(
      'does not mint or launch when the exact-model probe is %s',
      async (outcome) => {
        const runtime = await createHarness();
        runtime.setProbeOutcome(outcome);

        await expect(runtime.prepare()).rejects.toThrow(
          outcome === 'timeout' ? 'timed out' : 'transient status'
        );
        expect(runtime.authorization().executionProof).toBeNull();
        await expect(runtime.launch()).resolves.toBe(false);
        await runtime.assertNoRuntimeArtifacts();
      }
    );
  }
);
