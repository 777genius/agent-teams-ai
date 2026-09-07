// eslint-disable-next-line no-restricted-imports -- Explicit hosted storage composition boundary.
import { createHostedTeamIdentityPublicationBackend } from '@features/internal-storage/main/composition';
// eslint-disable-next-line no-restricted-imports -- Explicit hosted filesystem composition boundary.
import { createHostedDraftPublicationFeature } from '@features/team-lifecycle/main/composition';
import { parseWorkspaceId, type QueryContext, type WorkspaceId } from '@shared/contracts/hosted';

import type { TeamLifecycleReadBootstrap } from './teamLifecycleReadBootstrapSource';
import type { HostedAuthenticatedPrincipal } from '@features/hosted-access';
import type { TeamDraftPublicationStorageGateway, TeamIdentityPublicationGateway } from '@features/internal-storage/contracts';
import type { InternalStorageHostedAuthFeature } from '@features/internal-storage/main';
// eslint-disable-next-line no-restricted-imports -- Bounded server-only configuration publication port.
import type { HostedDraftWorkspaceFence } from '@features/team-configuration/main/hosted';
import type { HostedDraftPublicationFeature } from '@features/team-lifecycle/main';

export interface HostedDraftPublicationComposition {
  readonly journal: TeamDraftPublicationStorageGateway;
  readonly identities: TeamIdentityPublicationGateway;
  readonly publisher: HostedDraftPublicationFeature;
  readonly identityReadSource: { readonly appDataRoot: string; readSnapshot(): Promise<Uint8Array> };
  captureWorkspace(workspaceId: WorkspaceId, principal: HostedAuthenticatedPrincipal,
    context: QueryContext, restoreGeneration: number): Promise<HostedDraftWorkspaceFence>;
  dispose(): Promise<void>;
}

/** Initialize write availability before the existing canonical read composition takes its snapshot. */
export async function createHostedDraftPublicationComposition(input: {
  readonly bootstrap: TeamLifecycleReadBootstrap;
  readonly drafts: InternalStorageHostedAuthFeature;
}): Promise<HostedDraftPublicationComposition> {
  const { bootstrap, drafts } = input;
  const backend = await createHostedTeamIdentityPublicationBackend({
    appDataRoot: bootstrap.runtimeInstance.appDataRoot.reference, drafts,
  });
  let publisher: HostedDraftPublicationFeature;
  try {
    publisher = await createHostedDraftPublicationFeature({
      claudeRoot: bootstrap.runtimeInstance.claudeRoot.reference, identities: backend.gateway,
    });
  } catch (error) { await backend.dispose(); throw error; }
  let closed = false;
  return Object.freeze({
    journal: drafts.draftPublications, identities: backend.gateway, publisher,
    identityReadSource: Object.freeze({ appDataRoot: bootstrap.runtimeInstance.appDataRoot.reference, readSnapshot: () => backend.readSnapshot() }),
    captureWorkspace: async (workspaceId: WorkspaceId, authenticated: HostedAuthenticatedPrincipal,
      context: QueryContext, restoreGeneration: number) => {
      const userId = authenticated.principal.userId;
      if (!userId || !Number.isSafeInteger(restoreGeneration) || restoreGeneration < 0) {
        throw new Error('draft-workspace-principal-invalid');
      }
      const assertContext = () => {
        if (closed || context.signal.aborted || Date.now() >= context.deadlineAtMs ||
            context.deploymentId !== bootstrap.deploymentId || context.bootId !== bootstrap.bootId) {
          throw new Error('draft-workspace-context-expired');
        }
      };
      const readGrant = async () => {
        assertContext();
        const rows = await drafts.gateway.hostedAuthCall('workspace.grant.list', { userId, grantGeneration: restoreGeneration });
        if (!Array.isArray(rows) || rows.length > 256) throw new Error('draft-workspace-grants-invalid');
        const matching = rows.filter((row) => row?.workspaceId === workspaceId);
        if (matching.length !== 1) throw new Error('draft-workspace-grant-absent');
        const row = matching[0] as Record<string, unknown>;
        if (row.userId !== userId || row.grantGeneration !== restoreGeneration ||
            typeof row.grantRevision !== 'string' || !/^[a-f0-9]{64}$/.test(row.grantRevision)) {
          throw new Error('draft-workspace-grant-invalid');
        }
        const runtimeWorkspaceId = parseWorkspaceId(row.runtimeWorkspaceId);
        const registration = bootstrap.workspaceRegistrySnapshot.registry.requireEnabled(runtimeWorkspaceId);
        const mount = bootstrap.mountBinding;
        // This production reader is scoped to the exact launcher-admitted workspace, not an ambient root.
        if (runtimeWorkspaceId !== bootstrap.workspaceId || mount.workspaceId !== runtimeWorkspaceId ||
            mount.bootId !== context.bootId || mount.health !== 'healthy' ||
            mount.declaredRootHash !== registration.declaredRootHash) throw new Error('draft-workspace-mount-invalid');
        assertContext();
        return { runtimeWorkspaceId, revision: row.grantRevision, registrationRevision: registration.registrationRevision,
          mountGeneration: mount.mountGeneration, declaredRootHash: mount.declaredRootHash };
      };
      const captured = await readGrant();
      return {
        runtimeWorkspaceId: captured.runtimeWorkspaceId,
        // A newly created TeamId starts at binding generation 1. Mount/regrant generations never rewrite it.
        bindingGeneration: 1,
        assertCurrent: async () => {
          if (JSON.stringify(await readGrant()) !== JSON.stringify(captured)) throw new Error('draft-workspace-fence-changed');
        },
      };
    },
    dispose: async () => { if (!closed) { closed = true; await publisher.dispose(); await backend.dispose(); } },
  });
}
