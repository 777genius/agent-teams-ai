import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { fromProvisioningMembers } from '@features/team-runtime-lanes';
import { createAnthropicApiKeyHelperCleanupRetryOwner } from '@main/services/team/provisioning/TeamProvisioningAnthropicApiKeyHelperLease';
import { prepareDeterministicLaunchSetup } from '@main/services/team/provisioning/TeamProvisioningLaunchDeterministicSetupFlow';
import { buildEffectiveTeamMemberSpecs } from '@main/services/team/provisioning/TeamProvisioningMemberSpecs';
import { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';

import type { TeamLaunchRequest } from '@shared/types';

/** Real setup/discovery/materialization wiring; process/provider/auth ports are inert. */
export async function prepareModelLaunchFixture(request: TeamLaunchRequest, root: string) {
  const noop = async (): Promise<void> => {};
  const setup = await prepareDeterministicLaunchSetup(request, {
    readTeamConfigRaw: (name) => readFile(join(root, name, 'config.json'), 'utf8'),
    getExistingAliveRunId: () => null,
    getExistingRun: () => null,
    getRunTrackedCwd: () => null,
    deleteProvisioningRunByTeam: () => {},
    launchExpectedMembersPorts: {
      readLaunchState: async () => null,
      readBootstrapLaunchSnapshot: async () => null,
      getMeta: (name) => new TeamMembersMetaStore().getMeta(name),
      listInboxNames: async () => [],
      warn: () => {},
    },
    materializeLaunchCompatibilityRepair: noop,
    normalizeTeamConfigForLaunch: noop,
    assertConfigLeadOnlyForLaunch: noop,
    updateConfigProjectPath: noop,
    restorePrelaunchConfig: noop,
    resolveClaudePath: async () => '/sandbox/unused-cli',
    buildProvisioningEnv: async () => ({
      env: {},
      providerArgs: [],
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
    }),
    workspaceTrustCoordinator: null,
    workspaceTrustWorkspaceCollectionPorts: {
      getHomeDir: () => root,
      realpath: async (value) => value,
      resolveGitRoot: async () => null,
      resolveCanonicalGitRoot: async (value) => value,
      platform: 'posix',
    },
    materializeEffectiveTeamMemberSpecs: async ({ members, defaults }) =>
      buildEffectiveTeamMemberSpecs(members, defaults),
    resolveOpenCodeMemberWorkspacesForRuntime: async ({ members }) => members,
    runtimeTurnSettledEnvironmentProvider: async () => ({}),
    planRuntimeLanesOrThrow: (provider, members) => {
      const result = fromProvisioningMembers(provider, members);
      if (!result.ok) throw new Error(result.message);
      return result.plan;
    },
    createMixedSecondaryLaneStates: () => [],
    buildCrossProviderMemberArgs: async () => ({
      args: [],
      providerArgsByProvider: new Map(),
      envPatch: {},
      usesAnthropicApiKeyHelper: false,
      anthropicApiKeyHelper: null,
    }),
    resolveAndValidateLaunchIdentity: async () => ({
      providerId: request.providerId ?? 'anthropic',
      providerBackendId: null,
      selectedModel: request.model ?? null,
      selectedModelKind: request.model ? 'explicit' : 'default',
      resolvedLaunchModel: request.model ?? null,
      catalogId: null,
      catalogSource: 'runtime',
      catalogFetchedAt: null,
      selectedEffort: request.effort ?? null,
      resolvedEffort: request.effort ?? null,
    }),
    randomUUID: () => 'sandbox-run',
    nowIso: () => new Date(0).toISOString(),
    logger: { info: () => {}, warn: () => {} },
    anthropicApiKeyHelperCleanupRetryOwner: createAnthropicApiKeyHelperCleanupRetryOwner(),
  });
  if (setup.kind !== 'prepared') throw new Error('Fixture unexpectedly reused a run');
  return setup;
}
