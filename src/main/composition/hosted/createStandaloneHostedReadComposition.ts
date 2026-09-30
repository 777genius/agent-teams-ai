import {
  createTeamLifecycleReadQueryContext,
  teamLifecycleReadNowMs,
} from '../../standaloneTeamLifecycleReadQueryContext';

import { createCurrentAdmittedReadBindingResolver } from './currentAdmittedReadBinding';
import {
  createBoundTeamLifecycleReadHosts,
  createMountBindingScopedTeamLifecycleReadPorts,
  createTeamLifecycleReadComposition,
  createTeamLifecycleReadHost,
} from './teamLifecycleReadComposition';

import type { TeamLifecycleReadBootstrap } from './teamLifecycleReadBootstrapSource';
import type { TeamIdentityReadGateway } from '@features/internal-storage/main';
import type { WorkspaceRegistryStartupSnapshot } from '@features/workspace-registry/main';

interface StandaloneHostedReadCompositionInput {
  readonly bootstrap: TeamLifecycleReadBootstrap;
  readonly teamIdentities: TeamIdentityReadGateway;
  readonly currentSnapshot: () => WorkspaceRegistryStartupSnapshot | null;
  readonly multiRootActive: boolean;
  readonly scopedReadEnabled: boolean;
  readonly reportMessageDiagnostic: (stage: string, code: string) => void;
}

/** Bind the owner read host, admitted workspace dispatch, and message read fence together. */
export async function createStandaloneHostedReadComposition(
  input: StandaloneHostedReadCompositionInput
) {
  const { bootstrap, teamIdentities, currentSnapshot, multiRootActive } = input;
  const readPorts = createMountBindingScopedTeamLifecycleReadPorts({
    authority: bootstrap.authority,
    mountBinding: bootstrap.mountBinding,
    runtimeInstance: bootstrap.runtimeInstance,
    teamIdentities,
    nowMs: teamLifecycleReadNowMs,
  });
  await readPorts.teamIdentities.listTeamIdentities();
  const composition = createTeamLifecycleReadComposition({
    authority: bootstrap.authority,
    ...readPorts,
    nowMs: teamLifecycleReadNowMs,
  });
  const ownerHost = createTeamLifecycleReadHost(composition, createTeamLifecycleReadQueryContext);
  const boundReads = createBoundTeamLifecycleReadHosts({
    snapshot: bootstrap.workspaceRegistrySnapshot,
    currentSnapshot,
    runtimeInstance: bootstrap.runtimeInstance,
    actorId: bootstrap.actorId,
    authorizedScope: bootstrap.authorizedScope,
    ownerBinding: bootstrap.mountBinding,
    ownerHost,
    teamIdentities,
    nowMs: teamLifecycleReadNowMs,
    createContext: createTeamLifecycleReadQueryContext,
  });
  const teamLifecycleReadHost = Object.freeze({
    listTeamLifecycle: ownerHost.listTeamLifecycle,
    listForWorkspace: boundReads.listForWorkspace,
    scopedReadEnabled: input.scopedReadEnabled,
    ownerRuntimeWorkspaceId: bootstrap.mountBinding.workspaceId,
  });
  const hostedTeamMessageRouteDependencies = {
    runtimeInstance: bootstrap.runtimeInstance,
    mountBinding: bootstrap.mountBinding,
    teamIdentities,
    admittedReadBindings: bootstrap.workspaceRegistrySnapshot.bindings,
    currentReadBinding: createCurrentAdmittedReadBindingResolver({
      admitted: bootstrap.workspaceRegistrySnapshot,
      current: currentSnapshot,
      bootId: bootstrap.runtimeInstance.bootId,
      ownerWorkspaceId: bootstrap.mountBinding.workspaceId,
      multiRootActive,
    }),
    reportReadDiagnostic: input.reportMessageDiagnostic,
  };
  return { teamLifecycleReadHost, hostedTeamMessageRouteDependencies };
}
