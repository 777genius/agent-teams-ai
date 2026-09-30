import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { parseHostedRecentProjectsResult } from '@features/recent-projects/contracts';
// eslint-disable-next-line no-restricted-imports -- Reviewed exact server-only facet.
import {
  type HostedRecentAuthoritySnapshot,
  HostedRecentMetadataReader,
  HostedRecentProjectsFacade,
  type HostedRecentRootBoundary,
  registerHostedRecentProjectsHttp,
} from '@features/recent-projects/main/hosted';
import { parseWorkspaceId, type WorkspaceId } from '@shared/contracts/hosted';

import { AdmittedWorkspaceRootResolver } from './admittedWorkspaceRootResolver';

import type { HostedAuthenticatedPrincipal } from '@features/hosted-access';
import type { HostedRecentProjectsResult } from '@features/recent-projects/contracts';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type { WorkspaceMountBinding } from '@features/workspace-registry';
import type { WorkspaceRegistryStartupSnapshot } from '@features/workspace-registry/main';
import type { FastifyInstance } from 'fastify';

export interface HostedRecentProjectsAuthenticationPort {
  authenticatedPrincipalFor(request: object): HostedAuthenticatedPrincipal | null;
  isHostedQueryAuthorized(request: unknown): Promise<boolean>;
  projectGrantedPublicWorkspaceId(
    request: object,
    runtimeWorkspaceId: string
  ): Promise<string | null>;
  captureWorkspaceReadGrantFence(
    request: object,
    publicWorkspaceId: string
  ): Promise<{
    runtimeWorkspaceId: string;
    grantSetFingerprint: string;
    revalidate(): Promise<boolean>;
  } | null>;
}

export interface CreateHostedRecentProjectsCompositionDependencies {
  readonly authentication: HostedRecentProjectsAuthenticationPort;
  readonly snapshot: WorkspaceRegistryStartupSnapshot;
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly expectedDeploymentId: string;
  /** Signed bootstrap workspace while the launcher-owned activation switch is off. */
  readonly primaryRuntimeWorkspaceId: string;
  readonly multiRootActive?: boolean;
  readonly metadataMounts: {
    readonly claudeProjectsDir: string;
    readonly codexSessionsDir?: string;
    readonly codexArchivedSessionsDir?: string;
  };
}

const unavailable = (
  code: 'source_unavailable' | 'authority_changed'
): HostedRecentProjectsResult => ({
  schemaVersion: 1,
  kind: 'unavailable',
  code,
});

/** Wires H3a's bounded metadata readers to the signed roots and live personal grants. */
export function createHostedRecentProjectsComposition(
  dependencies: CreateHostedRecentProjectsCompositionDependencies
): { register(app: FastifyInstance): void } {
  const { snapshot, runtimeInstance, authentication } = dependencies;
  if (runtimeInstance.deploymentId !== dependencies.expectedDeploymentId) {
    throw new TypeError('hosted-recent-deployment-binding-invalid');
  }
  const primaryId = parseWorkspaceId(dependencies.primaryRuntimeWorkspaceId);
  const primary = snapshot.registry.getByWorkspaceId(primaryId);
  if (
    !primary?.enabled ||
    !snapshot.bindings.some((binding) => binding.workspaceId === primaryId)
  ) {
    throw new TypeError('hosted-recent-primary-workspace-invalid');
  }
  if (
    dependencies.metadataMounts.claudeProjectsDir !==
      join(runtimeInstance.claudeRoot.reference, 'projects') ||
    (dependencies.metadataMounts.codexSessionsDir !== undefined &&
      dependencies.metadataMounts.codexSessionsDir !== '/data/codex-metadata/sessions') ||
    (dependencies.metadataMounts.codexArchivedSessionsDir !== undefined &&
      dependencies.metadataMounts.codexArchivedSessionsDir !==
        '/data/codex-metadata/archived_sessions')
  ) {
    throw new TypeError('hosted-recent-metadata-mount-invalid');
  }
  const resolver = new AdmittedWorkspaceRootResolver(snapshot, runtimeInstance);
  const registrations = [...snapshot.registry.values()].sort((a, b) =>
    a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0
  );
  const bindings = new Map(snapshot.bindings.map((binding) => [binding.workspaceId, binding]));
  const rootFingerprint = createHash('sha256')
    .update(
      JSON.stringify(
        registrations.map((item) => [
          item.workspaceId,
          item.declaredRootHash,
          item.registrationRevision,
          item.enabled,
          bindings.get(item.workspaceId)?.mountGeneration ?? null,
          bindings.get(item.workspaceId)?.health ?? null,
        ])
      )
    )
    .digest('hex');
  const claude = new HostedRecentMetadataReader('anthropic', [
    dependencies.metadataMounts.claudeProjectsDir,
  ]);
  const codexMounts =
    dependencies.metadataMounts.codexSessionsDir &&
    dependencies.metadataMounts.codexArchivedSessionsDir
      ? [
          dependencies.metadataMounts.codexSessionsDir,
          dependencies.metadataMounts.codexArchivedSessionsDir,
        ]
      : [];
  const codex = new HostedRecentMetadataReader('codex', codexMounts);
  let registered = false;

  interface RequestScope {
    readonly request: object;
    readonly signal: AbortSignal;
    readonly initial: HostedAuthenticatedPrincipal;
    readonly grantSetFingerprint: string;
    readonly authoritySnapshot: HostedRecentAuthoritySnapshot;
    readonly fences: ReadonlyMap<WorkspaceId, { revalidate(): Promise<boolean> }>;
    readonly publicIds: ReadonlyMap<WorkspaceId, WorkspaceId>;
    readonly labels: ReadonlyMap<WorkspaceId, string>;
    readonly sourceStatuses: string[];
    authorityInvalid: boolean;
  }
  interface CacheOwner {
    facade: HostedRecentProjectsFacade;
    active: RequestScope | null;
    lastUsed: number;
  }
  const owners = new Map<string, CacheOwner>();
  const MAX_CACHE_OWNERS = 32;
  const boundary: HostedRecentRootBoundary = {
    rootFingerprint,
    attribute: async (cwd) => {
      for (const binding of bindings.values()) {
        const id = await resolver.resolveGrantedWorkspaceId(cwd, binding, () => true);
        if (id !== null) {
          const registration = snapshot.registry.requireEnabled(id);
          return {
            runtimeWorkspaceId: id,
            registrationRevision: registration.registrationRevision,
            mountGeneration: binding.mountGeneration,
            mountAvailable: binding.health !== 'unavailable',
          };
        }
      }
      return null;
    },
  };

  function createCacheOwner(): CacheOwner {
    const owner = { active: null, lastUsed: 0 } as CacheOwner;
    const active = (): RequestScope => {
      if (!owner.active) throw new Error('hosted-recent-request-context-unavailable');
      return owner.active;
    };
    owner.facade = new HostedRecentProjectsFacade(
      {
        async current() {
          const scope = active();
          if (
            scope.signal.aborted ||
            !(await authentication.isHostedQueryAuthorized(scope.request))
          )
            return null;
          const principal = authentication.authenticatedPrincipalFor(scope.request);
          if (
            !principal ||
            principal.principal.userId !== scope.initial.principal.userId ||
            principal.authenticatedSessionId !== scope.initial.authenticatedSessionId
          )
            return null;
          for (const fence of scope.fences.values()) {
            if (!(await fence.revalidate())) return null;
          }
          return scope.authoritySnapshot;
        },
      },
      {
        async resolve() {
          return boundary;
        },
      },
      {
        async projectGrantedWorkspace(_captured, runtimeId) {
          const scope = active();
          const publicId = scope.publicIds.get(runtimeId);
          if (!publicId) return null;
          const latest = await authentication.captureWorkspaceReadGrantFence(
            scope.request,
            publicId
          );
          if (
            !latest ||
            latest.runtimeWorkspaceId !== runtimeId ||
            latest.grantSetFingerprint !== scope.grantSetFingerprint
          ) {
            scope.authorityInvalid = true;
            return null;
          }
          // The original fence stays captured. A revoke/regrant cannot replace its revision.
          return { workspaceId: publicId, label: scope.labels.get(runtimeId)! };
        },
      },
      [
        {
          provider: 'anthropic',
          async read(admit) {
            const scope = active();
            const result = await claude.read(admit);
            scope.sourceStatuses.push(result.status);
            return result;
          },
        },
        {
          provider: 'codex',
          async read(admit) {
            const scope = active();
            const result = await codex.read(admit);
            scope.sourceStatuses.push(result.status);
            return result;
          },
        },
      ]
    );
    return owner;
  }

  async function list(request: object, signal: AbortSignal): Promise<HostedRecentProjectsResult> {
    const initial = authentication.authenticatedPrincipalFor(request);
    if (!initial || signal.aborted || !(await authentication.isHostedQueryAuthorized(request))) {
      return unavailable('authority_changed');
    }
    const fences = new Map<WorkspaceId, { revalidate(): Promise<boolean> }>();
    const publicIds = new Map<WorkspaceId, WorkspaceId>();
    const labels = new Map<WorkspaceId, string>();
    let grantSetFingerprint: string | null = null;
    // Establish labels in the same visible, granted order as registry/list.
    for (const registration of registrations) {
      if (
        !registration.enabled ||
        (!dependencies.multiRootActive && registration.workspaceId !== primaryId)
      )
        continue;
      const binding: WorkspaceMountBinding | undefined = bindings.get(registration.workspaceId);
      if (!binding || binding.bootId !== runtimeInstance.bootId) continue;
      const projected = await authentication.projectGrantedPublicWorkspaceId(
        request,
        registration.workspaceId
      );
      if (projected === null) continue;
      const publicId = parseWorkspaceId(projected);
      const fence = await authentication.captureWorkspaceReadGrantFence(request, publicId);
      if (
        !fence ||
        fence.runtimeWorkspaceId !== registration.workspaceId ||
        !/^[0-9a-f]{64}$/.test(fence.grantSetFingerprint) ||
        (grantSetFingerprint !== null && grantSetFingerprint !== fence.grantSetFingerprint)
      ) {
        return unavailable('authority_changed');
      }
      grantSetFingerprint = fence.grantSetFingerprint;
      publicIds.set(registration.workspaceId, publicId);
      labels.set(registration.workspaceId, `Workspace ${labels.size + 1}`);
      fences.set(registration.workspaceId, fence);
    }
    const authorityFingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          initial.principal.userId,
          initial.authenticatedSessionId,
          runtimeInstance.bootId,
          grantSetFingerprint,
          dependencies.multiRootActive === true,
        ])
      )
      .digest('hex');
    const authoritySnapshot: HostedRecentAuthoritySnapshot = {
      authorityFingerprint,
      deploymentId: runtimeInstance.deploymentId,
      bootId: runtimeInstance.bootId,
      registrationRevision: Math.max(...registrations.map((item) => item.registrationRevision)),
      mountGeneration: Math.max(...snapshot.bindings.map((item) => item.mountGeneration)),
      // The numeric field is only a compact cache discriminator; the full digest above is authoritative.
      grantRevision:
        grantSetFingerprint === null ? 0 : Number.parseInt(grantSetFingerprint.slice(0, 13), 16),
    };
    const scope: RequestScope = {
      request,
      signal,
      initial,
      authoritySnapshot,
      fences,
      publicIds,
      labels,
      grantSetFingerprint: grantSetFingerprint ?? '',
      sourceStatuses: [],
      authorityInvalid: false,
    };
    let owner = grantSetFingerprint === null ? undefined : owners.get(authorityFingerprint);
    if (!owner && grantSetFingerprint !== null) {
      if (owners.size >= MAX_CACHE_OWNERS) {
        const idle = [...owners]
          .filter(([, candidate]) => candidate.active === null)
          .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (idle) owners.delete(idle[0]);
      }
      if (owners.size < MAX_CACHE_OWNERS) {
        owner = createCacheOwner();
        owners.set(authorityFingerprint, owner);
      }
    }
    // Concurrent requests use an independent reader; no request closure is retained in a busy owner.
    const selected = owner?.active === null ? owner : createCacheOwner();
    selected.active = scope;
    try {
      const result = await selected.facade.list();
      if (scope.authorityInvalid || !(await authentication.isHostedQueryAuthorized(request))) {
        return unavailable('authority_changed');
      }
      for (const fence of fences.values()) {
        if (!(await fence.revalidate())) return unavailable('authority_changed');
      }
      if (
        scope.sourceStatuses.length === 2 &&
        scope.sourceStatuses.every((status) => status === 'unavailable') &&
        result.kind === 'recent-projects' &&
        result.projects.length === 0
      ) {
        // An empty all-unavailable read has no admitted evidence to cache. Retry next request.
        if (owners.get(authorityFingerprint) === selected) owners.delete(authorityFingerprint);
        return unavailable('source_unavailable');
      }
      return parseHostedRecentProjectsResult(result);
    } finally {
      selected.active = null;
      selected.lastUsed = Date.now();
    }
  }

  return {
    register(app: FastifyInstance): void {
      if (registered) throw new Error('hosted-recent-composition-already-registered');
      registered = true;
      registerHostedRecentProjectsHttp(app, { list });
    },
  };
}
