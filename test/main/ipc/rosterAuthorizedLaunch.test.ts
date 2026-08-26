import { registerRosterAuthorizationTransactionHandlers } from '@main/ipc/teams/rosterAuthorizationTransactionHandlers';
import { runRosterLaunch } from '@main/ipc/teams/rosterAuthorizedLaunch';
import { TeamRuntimeAdapterRegistry } from '@main/services/team/runtime';
import { TeamDataService } from '@main/services/team/TeamDataService';
import { invalidateAuthoritativeModelExecutionProofs } from '@main/services/team/TeamLaunchExecutionProofAuthority';
import {
  crossRosterLaunchInvocationBoundary,
  TeamMembersMetaStore,
} from '@main/services/team/TeamMembersMetaStore';
import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { createRosterAuthorizationTransactionBridge } from '@preload/rosterAuthorizationTransactionBridge';
import { executeLaunchTeamDialogSubmissionWithRecheck } from '@renderer/components/team/dialogs/launchRosterAuthorizationTransaction';
import { executeTeamRelaunch } from '@renderer/components/team/dialogs/teamRelaunchFlow';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareAuthoritativeExecutionProof } from './helpers/authoritativePreparationTestHarness';

import type { TeamLaunchRuntimeAdapter } from '@main/services/team/runtime';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

const INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE = {
  version: 1 as const,
  providerBackendId: 'inherited' as const,
  model: 'inherited' as const,
  effort: 'inherited' as const,
};

const EXPLICIT_MODEL_MEMBER_RUNTIME_SELECTION_PROVENANCE = {
  version: 1 as const,
  providerBackendId: 'inherited' as const,
  model: 'explicit' as const,
  effort: 'inherited' as const,
};

describe('roster-authorized fake launch contract', () => {
  let sandbox = '';
  const teamName = 'fake-launch-team';
  const transactionId = '55555555-5555-4555-8555-555555555555';

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'roster-fake-launch-'));
    setClaudeBasePathOverride(sandbox);
    await fs.mkdir(path.join(sandbox, 'teams', teamName), { recursive: true });
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it.each([
    { response: { runId: transactionId, launchStatus: 'started' as const }, terminal: 'committed' },
    { response: { runId: transactionId }, terminal: 'launch-unknown' },
    {
      response: { runId: 'existing', launchStatus: 'already_running' as const },
      terminal: 'rolled-back',
    },
    {
      response: { runId: 'launching', launchStatus: 'already_launching' as const },
      terminal: 'rolled-back',
    },
  ])(
    'records $response.launchStatus as $terminal without retry',
    async ({ response, terminal }) => {
      const service = new TeamDataService();
      await service.beginRosterAuthorizationTransaction(teamName, transactionId, {
        members: [
          {
            runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
            name: 'alice',
          },
        ],
      });
      const launch = vi.fn(async (_roster, binding) => {
        if (response.launchStatus === 'started' && binding) {
          const invocationLease = await crossRosterLaunchInvocationBoundary();
          await invocationLease.invoke(() =>
            fs.writeFile(
              path.join(sandbox, 'teams', teamName, 'bootstrap-state.json'),
              JSON.stringify({
                runId: binding.launchCommandId,
                members: [{ name: 'alice', status: 'bootstrap_confirmed' }],
              })
            )
          );
          return { ...response, runId: binding.launchCommandId };
        }
        return response;
      });
      const proof = prepareAuthoritativeExecutionProof({
        cwd: sandbox,
        checks: [{ providerId: 'anthropic', providerBackendId: null, model: 'claude' }],
      });
      await expect(
        runRosterLaunch(service, teamName, transactionId, launch, proof, 'exact-launch')
      ).resolves.toMatchObject(response);
      expect(launch).toHaveBeenCalledTimes(1);
      await expect(
        service.getRosterAuthorizationTransactionOutcome(teamName, transactionId)
      ).resolves.toMatchObject({ status: terminal });
    }
  );

  it('keeps a thrown post-dispatch outcome reserved without replay', async () => {
    const service = new TeamDataService();
    await service.beginRosterAuthorizationTransaction(teamName, transactionId, {
      members: [
        {
          runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
          name: 'alice',
        },
      ],
    });
    const launch = vi.fn(async () => {
      throw new Error('definitively rejected');
    });
    const proof = prepareAuthoritativeExecutionProof({
      cwd: sandbox,
      checks: [{ providerId: 'anthropic', providerBackendId: null, model: 'claude' }],
    });
    await expect(
      runRosterLaunch(service, teamName, transactionId, launch, proof, 'exact-launch')
    ).rejects.toThrow('definitively rejected');
    expect(launch).toHaveBeenCalledTimes(1);
    await expect(
      service.getRosterAuthorizationTransactionOutcome(teamName, transactionId)
    ).resolves.toMatchObject({ status: 'launch-unknown' });
  });

  it('does not invoke launch B after durable prepare A', async () => {
    const service = new TeamDataService();
    await service.beginRosterAuthorizationTransaction(teamName, transactionId, {
      members: [
        {
          runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
          name: 'alice',
        },
      ],
    });
    const proofA = prepareAuthoritativeExecutionProof({
      cwd: sandbox,
      checks: [{ providerId: 'anthropic', providerBackendId: null, model: 'claude' }],
    });
    const proofB = prepareAuthoritativeExecutionProof({
      cwd: sandbox,
      checks: [{ providerId: 'anthropic', providerBackendId: null, model: 'claude-sonnet' }],
    });
    await service.rosterAuthorizationTransactions.prepare(
      teamName,
      transactionId,
      transactionId,
      proofA,
      'request-a'
    );
    const launch = vi.fn(async () => ({ runId: transactionId, launchStatus: 'started' as const }));

    await expect(
      runRosterLaunch(service, teamName, transactionId, launch, proofB, 'request-b')
    ).rejects.toThrow('Roster authorization transaction is conflict');
    expect(launch).not.toHaveBeenCalled();
    await expect(
      service.rosterAuthorizationTransactions.prepare(
        teamName,
        transactionId,
        transactionId,
        proofA,
        'request-a'
      )
    ).resolves.toMatchObject({
      status: 'prepared',
      launchBinding: { executionProof: proofA, launchRequestFingerprint: 'request-a' },
    });
  });

  it('rolls launch-unknown back to known-no-start when cancellation wins awaited boundary persistence', async () => {
    const service = new TeamDataService();
    await fs.writeFile(
      path.join(sandbox, 'teams', teamName, 'config.json'),
      `${JSON.stringify({
        name: teamName,
        projectPath: sandbox,
        members: [
          {
            name: 'team-lead',
            agentType: 'team-lead',
            providerId: 'opencode',
            model: 'openai/gpt-5',
            runtimeSelectionProvenance: {
              version: 1,
              providerBackendId: 'inherited',
              model: 'inherited',
              effort: 'inherited',
            },
          },
          {
            name: 'alice',
            role: 'Developer',
            providerId: 'opencode',
            model: 'openai/gpt-5',
            runtimeSelectionProvenance: {
              version: 1,
              providerBackendId: 'inherited',
              model: 'inherited',
              effort: 'inherited',
            },
          },
        ],
      })}\n`,
      'utf8'
    );
    await service.beginRosterAuthorizationTransaction(teamName, transactionId, {
      members: [
        {
          name: 'alice',
          providerId: 'opencode',
          model: 'openai/gpt-5',
          runtimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'inherited',
            model: 'inherited',
            effort: 'inherited',
          },
        },
      ],
    });

    const boundaryPersisted = deferred<void>();
    const releaseBoundary = deferred<void>();
    const transactions = service.rosterAuthorizationTransactions;
    const recordLaunchDispatched = transactions.recordLaunchDispatched.bind(transactions);
    transactions.recordLaunchDispatched = async (...args) => {
      const outcome = await recordLaunchDispatched(...args);
      boundaryPersisted.resolve(undefined);
      await releaseBoundary.promise;
      return outcome;
    };

    const bridgeDispatch = vi.fn();
    const stop = vi.fn();
    const adapter: TeamLaunchRuntimeAdapter = {
      providerId: 'opencode',
      prepare: vi.fn(),
      launch: vi.fn(async (input) => {
        const invocationLease = await input.onInvocationBoundary?.();
        invocationLease?.invoke(() => {
          input.onInvocationDispatched?.();
          bridgeDispatch();
        });
        throw new Error('bridge dispatch must remain unreachable');
      }),
      reconcile: vi.fn(),
      stop,
    } as unknown as TeamLaunchRuntimeAdapter;
    const provisioning = new TeamProvisioningService();
    provisioning.setRuntimeAdapterRegistry(new TeamRuntimeAdapterRegistry([adapter]));
    const proof = prepareAuthoritativeExecutionProof({
      cwd: sandbox,
      checks: [
        {
          providerId: 'opencode',
          providerBackendId: 'opencode-cli',
          model: 'openai/gpt-5',
        },
      ],
    });

    const launch = runRosterLaunch(
      service,
      teamName,
      transactionId,
      (_roster, binding) =>
        provisioning.launchTeam(
          {
            teamName,
            cwd: sandbox,
            providerId: 'opencode',
            providerBackendId: 'opencode-cli',
            model: 'openai/gpt-5',
            leadRuntimeSelectionProvenance: {
              version: 1,
              providerBackendId: 'explicit',
              model: 'explicit',
              effort: 'default',
            },
            rosterTransactionId: transactionId,
            rosterLaunchBinding: binding,
          },
          vi.fn()
        ),
      proof,
      'exact-launch'
    );

    await boundaryPersisted.promise;
    await expect(
      service.getRosterAuthorizationTransactionOutcome(teamName, transactionId)
    ).resolves.toMatchObject({ status: 'launch-unknown' });
    await provisioning.cancelProvisioning(transactionId);
    releaseBoundary.resolve(undefined);

    await expect(launch).resolves.toMatchObject({
      runId: transactionId,
      launchStatus: 'not_started',
    });
    expect(bridgeDispatch).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    await expect(
      service.getRosterAuthorizationTransactionOutcome(teamName, transactionId)
    ).resolves.toMatchObject({ status: 'rolled-back' });

    const restarted = new TeamDataService();
    await expect(
      restarted.getRosterAuthorizationTransactionOutcome(teamName, transactionId)
    ).resolves.toMatchObject({ status: 'rolled-back' });
  });

  it.each(['root-replacement', 'authority-invalidation'] as const)(
    'prevents invocation when %s wins while durable dispatch is stalled',
    async (authorityChange) => {
      const service = new TeamDataService();
      const project = path.join(sandbox, 'project');
      const displaced = path.join(sandbox, 'project-displaced');
      await fs.mkdir(project);
      await service.beginRosterAuthorizationTransaction(teamName, transactionId, {
        members: [
          {
            runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
            name: 'alice',
          },
        ],
      });
      const boundaryPersisted = deferred<void>();
      const releaseBoundary = deferred<void>();
      const transactions = service.rosterAuthorizationTransactions;
      const recordLaunchDispatched = transactions.recordLaunchDispatched.bind(transactions);
      transactions.recordLaunchDispatched = async (...args) => {
        const outcome = await recordLaunchDispatched(...args);
        boundaryPersisted.resolve(undefined);
        await releaseBoundary.promise;
        return outcome;
      };
      const invoked = vi.fn();
      const launch = vi.fn(async () => {
        const invocationLease = await crossRosterLaunchInvocationBoundary();
        invocationLease.invoke(invoked);
        return { runId: transactionId, launchStatus: 'started' as const };
      });
      const proof = prepareAuthoritativeExecutionProof({
        cwd: project,
        checks: [{ providerId: 'anthropic', providerBackendId: null, model: 'claude' }],
      });

      const result = runRosterLaunch(
        service,
        teamName,
        transactionId,
        launch,
        proof,
        `stalled-${authorityChange}`
      );
      await boundaryPersisted.promise;
      if (authorityChange === 'root-replacement') {
        await fs.rename(project, displaced);
        await fs.mkdir(project);
      } else {
        invalidateAuthoritativeModelExecutionProofs();
      }
      releaseBoundary.resolve(undefined);

      await expect(result).rejects.toThrow('invalidated during durable dispatch');
      expect(invoked).not.toHaveBeenCalled();
      await expect(
        service.getRosterAuthorizationTransactionOutcome(teamName, transactionId)
      ).resolves.toMatchObject({ status: 'rolled-back' });
    }
  );

  it('does not let an arbitrary callback response manufacture a committed production outcome', async () => {
    const service = new TeamDataService();
    await service.beginRosterAuthorizationTransaction(teamName, transactionId, {
      members: [
        {
          runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
          name: 'alice',
        },
      ],
    });
    await expect(
      runRosterLaunch(
        service,
        teamName,
        transactionId,
        async () => ({ runId: transactionId, launchStatus: 'started' }),
        prepareAuthoritativeExecutionProof({
          cwd: os.tmpdir(),
          checks: [{ providerId: 'anthropic', providerBackendId: null, model: 'claude' }],
        }),
        'exact-launch-request'
      )
    ).resolves.toMatchObject({ launchStatus: 'started' });
    await expect(
      service.getRosterAuthorizationTransactionOutcome(teamName, transactionId)
    ).resolves.toMatchObject({ status: 'launch-unknown' });
  });

  it('proves renderer helper through preload, IPC parser, real service, and fake launch', async () => {
    const service = new TeamDataService();
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerRosterAuthorizationTransactionHandlers(
      { handle: vi.fn((channel, handler) => handlers.set(channel, handler)) } as never,
      () => service
    );
    const bridge = createRosterAuthorizationTransactionBridge((async <T>(
      channel: string,
      ...args: unknown[]
    ): Promise<T> => {
      const response = (await handlers.get(channel)?.({}, ...args)) as
        | { success: true; data: T }
        | { success: false; error: string };
      if (!response.success) throw new Error(response.error);
      return response.data;
    }) as never);
    const proof = prepareAuthoritativeExecutionProof({
      cwd: sandbox,
      checks: [{ providerId: 'anthropic', providerBackendId: null, model: 'claude' }],
    });
    const authorization = {
      prepareState: 'ready',
      providerStatusesAuthoritative: true,
      preparedRequestSignature: 'same',
      currentRequestSignature: 'same',
      preparedGeneration: 1,
      currentGeneration: 1,
      providerProofExpiresAtMs: Date.now() + 60_000,
      executionProof: proof,
    };
    const launch = vi.fn(() => {
      return runRosterLaunch(
        service,
        teamName,
        transactionId,
        async (_roster, binding) => {
          const invocationLease = await crossRosterLaunchInvocationBoundary();
          const runId = binding?.launchCommandId ?? transactionId;
          await invocationLease.invoke(() =>
            fs.writeFile(
              path.join(sandbox, 'teams', teamName, 'bootstrap-state.json'),
              JSON.stringify({
                runId,
                members: [{ name: 'alice', status: 'bootstrap_confirmed' }],
              })
            )
          );
          return { runId, launchStatus: 'started' };
        },
        proof,
        'exact-launch'
      );
    });
    await expect(
      executeLaunchTeamDialogSubmissionWithRecheck(
        () => authorization,
        () =>
          bridge.beginRosterAuthorizationTransaction(teamName, {
            transactionId,
            members: [
              {
                name: 'alice',
                runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
              },
            ],
          }),
        () => bridge.getRosterAuthorizationTransactionOutcome(teamName, transactionId),
        async () => {
          await launch();
        },
        () => bridge.rollbackRosterAuthorizationTransaction(teamName, transactionId)
      )
    ).resolves.toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
    await expect(
      service.getRosterAuthorizationTransactionOutcome(teamName, transactionId)
    ).resolves.toMatchObject({ status: 'committed' });
  });

  it('keeps the durable target roster reserved after stop succeeds and launch fails', async () => {
    const service = new TeamDataService();
    await service.replaceMembers(teamName, {
      members: [
        {
          runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
          name: 'prior',
          role: 'Reviewer',
        },
      ],
    });
    const authorization = {
      prepareState: 'ready' as const,
      providerStatusesAuthoritative: true,
      preparedRequestSignature: 'same',
      currentRequestSignature: 'same',
      preparedGeneration: 1,
      currentGeneration: 1,
      providerProofExpiresAtMs: Date.now() + 60_000,
      executionProof: prepareAuthoritativeExecutionProof({
        cwd: sandbox,
        checks: [{ providerId: 'anthropic', providerBackendId: null, model: 'claude' }],
      }),
    };
    const calls: string[] = [];
    const replaceMembers = vi.fn();
    await expect(
      executeLaunchTeamDialogSubmissionWithRecheck(
        () => authorization,
        async () => {
          calls.push('snapshot');
          return service.beginRosterAuthorizationTransaction(teamName, transactionId, {
            members: [
              {
                runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
                name: 'target',
                role: 'Builder',
              },
            ],
          });
        },
        () => service.getRosterAuthorizationTransactionOutcome(teamName, transactionId),
        () =>
          executeTeamRelaunch({
            teamName,
            isTeamAlive: true,
            request: {
              teamName,
              cwd: '/sandbox/project',
              rosterTransactionId: transactionId,
            },
            members: [{ name: 'target' }],
            stopTeam: async () => {
              calls.push('stop');
              return { status: 'stopped' };
            },
            replaceMembers,
            launchTeam: async () => {
              calls.push('launch');
              throw new Error('fake launch failure');
            },
          }),
        () => service.rollbackRosterAuthorizationTransaction(teamName, transactionId)
      )
    ).rejects.toThrow('fake launch failure');
    expect(calls).toEqual(['snapshot', 'stop', 'launch']);
    expect(replaceMembers).not.toHaveBeenCalled();
    await expect(new TeamMembersMetaStore().getMembers(teamName)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'prior', removedAt: expect.any(Number) }),
        expect.objectContaining({ name: 'target', role: 'Builder', removedAt: undefined }),
      ])
    );
    await expect(
      service.getRosterAuthorizationTransactionOutcome(teamName, transactionId)
    ).resolves.toMatchObject({ status: 'applied' });
  });

  it('immediately restores the exact roster once when relaunch stop is known to reject', async () => {
    const service = new TeamDataService();
    const store = new TeamMembersMetaStore();
    await service.replaceMembers(teamName, {
      members: [
        {
          runtimeSelectionProvenance: EXPLICIT_MODEL_MEMBER_RUNTIME_SELECTION_PROVENANCE,
          name: 'prior',
          role: 'Reviewer',
          model: 'prior-model',
        },
      ],
    });
    const rollback = vi.spyOn(service, 'rollbackRosterAuthorizationTransaction');
    const authorization = {
      prepareState: 'ready' as const,
      providerStatusesAuthoritative: true,
      preparedRequestSignature: 'same',
      currentRequestSignature: 'same',
      preparedGeneration: 1,
      currentGeneration: 1,
      providerProofExpiresAtMs: Date.now() + 60_000,
      executionProof: prepareAuthoritativeExecutionProof({
        cwd: sandbox,
        checks: [{ providerId: 'anthropic', providerBackendId: null, model: 'claude' }],
      }),
    };
    const launchTeam = vi.fn();

    await expect(
      executeLaunchTeamDialogSubmissionWithRecheck(
        () => authorization,
        () =>
          service.beginRosterAuthorizationTransaction(teamName, transactionId, {
            members: [
              {
                runtimeSelectionProvenance: EXPLICIT_MODEL_MEMBER_RUNTIME_SELECTION_PROVENANCE,
                name: 'target',
                role: 'Builder',
                model: 'target-model',
              },
            ],
          }),
        () => service.getRosterAuthorizationTransactionOutcome(teamName, transactionId),
        () =>
          executeTeamRelaunch({
            teamName,
            isTeamAlive: true,
            request: {
              teamName,
              cwd: '/sandbox/project',
              rosterTransactionId: transactionId,
            },
            members: [{ name: 'target' }],
            stopTeam: async () => ({
              status: 'not-dispatched',
              reason: 'validation-rejected',
              diagnostic: 'fake deterministic stop rejection',
            }),
            replaceMembers: vi.fn(),
            launchTeam,
          }),
        () => service.rollbackRosterAuthorizationTransaction(teamName, transactionId)
      )
    ).rejects.toMatchObject({
      name: 'TeamRelaunchKnownPreDispatchFailure',
      kind: 'stop-rejected',
    });

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(launchTeam).not.toHaveBeenCalled();
    await expect(store.getMembers(teamName)).resolves.toEqual([
      expect.objectContaining({ name: 'prior', role: 'Reviewer', model: 'prior-model' }),
    ]);
    await expect(
      service.replaceMembers(teamName, {
        members: [
          {
            runtimeSelectionProvenance: INHERITED_MEMBER_RUNTIME_SELECTION_PROVENANCE,
            name: 'after-rollback',
          },
        ],
      })
    ).resolves.toBeUndefined();
    await expect(
      service.getRosterAuthorizationTransactionOutcome(teamName, transactionId)
    ).resolves.toMatchObject({ status: 'rolled-back' });
  });
});
