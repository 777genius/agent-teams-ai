// eslint-disable-next-line no-restricted-imports -- Hosted query context exposes a bounded server-only facet.
import { createAuthenticatedHostedQueryContextFactory } from '@features/hosted-query-context/main/hosted';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
// eslint-disable-next-line no-restricted-imports -- Task-board hosted exports are main-process-only.
import {
  createHostedTeamTaskBoardFeature,
  createHostedTeamTaskBoardOutputAdapters,
  createHostedTeamTaskBoardRouteContribution,
  type HostedTaskBoardAuthorityMutationRequest,
  type HostedTaskBoardAuthorityMutationResult,
  type HostedTaskBoardAuthorityObserveCreationRequest,
  type HostedTaskBoardAuthorityObserveCreationResult,
  type HostedTaskBoardAuthorityPort,
  type HostedTaskBoardAuthorityReadWindowRequest,
  type HostedTaskBoardAuthorityReadWindowResult,
  registerHostedTeamTaskBoardHttp,
} from '@features/team-task-board/main/hosted';
import { WorkspaceMountBinding } from '@features/workspace-registry';

import {
  createHostedBoundTeamReadDispatcher,
  type HostedBoundTeamReadDependencies,
} from './hostedBoundTeamReadDispatcher';
import { DescriptorBoundHostedTaskBoardReadSource } from './hostedTaskBoardReadFileSource';

import type { HostedAuthenticatedPrincipal } from '@features/hosted-access';
// eslint-disable-next-line no-restricted-imports -- Hosted mutation fencing is exposed by the feature's hosted entrypoint.
import type { HostedMutationGrantFence } from '@features/team-message-delivery/main/hosted';
import type { QueryContext, TeamId } from '@shared/contracts/hosted';
import type { FastifyInstance } from 'fastify';

interface HostedTaskBoardReadAuthentication {
  authenticatedPrincipalFor(request: object): HostedAuthenticatedPrincipal | null;
  isHostedQueryAuthorized(request: object): Promise<boolean>;
  isHostedTaskMutationAuthorized?(request: object, teamId: TeamId): Promise<boolean>;
  isTeamWorkspaceAuthorized(request: object, teamId: TeamId): Promise<boolean>;
  captureTeamWorkspaceGrantFence?(
    request: object,
    teamId: TeamId,
    permission: 'hosted.query' | 'hosted.command'
  ): Promise<(HostedMutationGrantFence & { readonly publicWorkspaceId?: string }) | null>;
}

interface HostedTaskMutationAuthority extends Pick<
  HostedTaskBoardAuthorityPort,
  'admitTaskMutation'
> {
  bindGrantFence(context: QueryContext, fence: HostedMutationGrantFence): void;
}

function isExactHostedMutationGrantFence(value: unknown): value is HostedMutationGrantFence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const fence = value as Record<string, unknown>;
  const ownerEffectFence = fence.ownerEffectFence;
  if (
    typeof fence.revalidate !== 'function' ||
    typeof ownerEffectFence !== 'object' ||
    ownerEffectFence === null ||
    Array.isArray(ownerEffectFence)
  ) {
    return false;
  }
  const effect = ownerEffectFence as Record<string, unknown>;
  const keys = Reflect.ownKeys(effect);
  return (
    keys.length === 2 &&
    keys.every((key) => key === 'grantRevision' || key === 'identityChecksum') &&
    typeof effect.grantRevision === 'string' &&
    /^[0-9a-f]{64}$/u.test(effect.grantRevision) &&
    typeof effect.identityChecksum === 'string' &&
    /^[0-9a-f]{64}$/u.test(effect.identityChecksum)
  );
}

export interface CreateHostedTaskBoardReadCompositionDependencies extends HostedBoundTeamReadDependencies {
  readonly authentication: HostedTaskBoardReadAuthentication;
  readonly expectedDeploymentId: string;
  readonly nowMs?: () => number;
  /** Narrow test seam; production always uses the descriptor-bound file source. */
  readonly source?: HostedTaskBoardAuthorityPort;
  /** Mutation capability supplied only by the live lifecycle-owner socket composition. */
  readonly mutationAuthority?: HostedTaskMutationAuthority;
  readonly reportReadDiagnostic?: (stage: string, code: string) => void;
}

export interface HostedTaskBoardReadComposition {
  readonly mutationsEnabled: boolean;
  canReadWorkspace(runtimeWorkspaceId: string): boolean;
  register(app: FastifyInstance): void;
}

export interface HostedTaskBoardReadCompositionAccess {
  readonly http: HostedTaskBoardReadAuthentication;
  readonly deploymentId: string;
}

export type HostedTaskBoardReadRouteFactory = (
  access: HostedTaskBoardReadCompositionAccess
) => HostedTaskBoardReadComposition;

export function createHostedTaskBoardReadRouteFactory(
  dependencies: Omit<
    CreateHostedTaskBoardReadCompositionDependencies,
    'authentication' | 'expectedDeploymentId'
  >
): HostedTaskBoardReadRouteFactory {
  return Object.freeze((access: HostedTaskBoardReadCompositionAccess) =>
    createHostedTaskBoardReadComposition({
      ...dependencies,
      authentication: access.http,
      expectedDeploymentId: access.deploymentId,
    })
  );
}

class LiveGrantTaskBoardReadAuthority implements HostedTaskBoardAuthorityPort {
  readonly admitTaskMutation?: (
    request: HostedTaskBoardAuthorityMutationRequest,
    context: QueryContext
  ) => Promise<HostedTaskBoardAuthorityMutationResult>;
  readonly observeTaskCreation?: (
    request: HostedTaskBoardAuthorityObserveCreationRequest,
    context: QueryContext
  ) => Promise<HostedTaskBoardAuthorityObserveCreationResult>;

  constructor(
    private readonly source: HostedTaskBoardAuthorityPort,
    private readonly mutationAuthority: HostedTaskMutationAuthority | undefined,
    private readonly requests: WeakMap<QueryContext, object>,
    private readonly authentication: HostedTaskBoardReadAuthentication,
    private readonly reportReadDiagnostic?: (stage: string, code: string) => void,
    private readonly isOwnerTeam?: (teamId: TeamId) => Promise<boolean>
  ) {
    if (
      typeof mutationAuthority?.admitTaskMutation === 'function' &&
      typeof mutationAuthority.bindGrantFence === 'function'
    ) {
      this.admitTaskMutation = (request, context) => this.mutate(request, context);
    }
    if (typeof source.observeTaskCreation === 'function') {
      this.observeTaskCreation = (request, context) => this.observeCreation(request, context);
    }
  }

  private async observeCreation(
    request: HostedTaskBoardAuthorityObserveCreationRequest,
    context: QueryContext
  ): Promise<HostedTaskBoardAuthorityObserveCreationResult> {
    const httpRequest = this.requests.get(context);
    const observe = this.source.observeTaskCreation;
    if (context.signal.aborted || httpRequest === undefined || typeof observe !== 'function') {
      return Object.freeze({ kind: 'unavailable' });
    }
    try {
      const fence = await this.authentication.captureTeamWorkspaceGrantFence?.(
        httpRequest,
        request.original.teamId,
        'hosted.query'
      );
      if (!isExactHostedMutationGrantFence(fence) || !(await fence.revalidate())) {
        return Object.freeze({ kind: 'unavailable' });
      }
      const result = await observe.call(this.source, request, context);
      if (context.signal.aborted || !(await fence.revalidate())) {
        return Object.freeze({ kind: 'unavailable' });
      }
      return result;
    } catch (error) {
      this.reportReadDiagnostic?.(
        'authorized-creation-observation-exception',
        diagnosticCode(error)
      );
      return Object.freeze({ kind: 'unavailable' });
    }
  }

  async readWindow(
    request: HostedTaskBoardAuthorityReadWindowRequest,
    context: QueryContext
  ): Promise<HostedTaskBoardAuthorityReadWindowResult> {
    const httpRequest = this.requests.get(context);
    if (httpRequest === undefined) {
      this.reportReadDiagnostic?.('authorization-context-missing', 'unavailable');
      return Object.freeze({ kind: 'unavailable' });
    }
    try {
      const fence = await this.authentication.captureTeamWorkspaceGrantFence?.(
        httpRequest,
        request.teamId,
        'hosted.query'
      );
      if (!isExactHostedMutationGrantFence(fence)) {
        this.reportReadDiagnostic?.('authorization-fence-missing', 'unavailable');
        return Object.freeze({ kind: 'unavailable' });
      }
      if (!(await fence.revalidate())) {
        this.reportReadDiagnostic?.('authorization-fence-stale-before-read', 'unavailable');
        return Object.freeze({ kind: 'unavailable' });
      }
      const result = await this.source.readWindow(request, context);
      if (result.kind === 'unavailable') {
        this.reportReadDiagnostic?.('task-source-unavailable', 'unavailable');
      }
      if (!(await fence.revalidate())) {
        this.reportReadDiagnostic?.('authorization-fence-stale-after-read', 'unavailable');
        return Object.freeze({ kind: 'unavailable' });
      }
      return result;
    } catch (error) {
      this.reportReadDiagnostic?.('authorized-read-exception', diagnosticCode(error));
      return Object.freeze({ kind: 'unavailable' });
    }
  }

  private async mutate(
    request: HostedTaskBoardAuthorityMutationRequest,
    context: QueryContext
  ): Promise<HostedTaskBoardAuthorityMutationResult> {
    const httpRequest = this.requests.get(context);
    const mutationAuthority = this.mutationAuthority;
    const admitTaskMutation = mutationAuthority?.admitTaskMutation;
    if (
      context.signal.aborted ||
      httpRequest === undefined ||
      mutationAuthority === undefined ||
      typeof admitTaskMutation !== 'function' ||
      (this.isOwnerTeam !== undefined && !(await this.isOwnerTeam(request.command.teamId))) ||
      !(await this.isMutationAuthorized(httpRequest, request.command.teamId))
    ) {
      return Object.freeze({ kind: 'unavailable' });
    }
    try {
      const fence = await this.authentication.captureTeamWorkspaceGrantFence?.(
        httpRequest,
        request.command.teamId,
        'hosted.command'
      );
      if (
        !isExactHostedMutationGrantFence(fence) ||
        typeof mutationAuthority.bindGrantFence !== 'function' ||
        !(await fence.revalidate())
      ) {
        return Object.freeze({ kind: 'unavailable' });
      }
      mutationAuthority.bindGrantFence(
        context,
        Object.freeze({
          ownerEffectFence: fence.ownerEffectFence,
          revalidate: () => fence.revalidate(),
        })
      );
      const result = await admitTaskMutation.call(mutationAuthority, request, context);
      if (context.signal.aborted) return Object.freeze({ kind: 'unavailable' });
      return (await fence.revalidate()) ? result : Object.freeze({ kind: 'unavailable' });
    } catch {
      return Object.freeze({ kind: 'unavailable' });
    }
  }

  private async isMutationAuthorized(request: object, teamId: TeamId): Promise<boolean> {
    try {
      return (await this.authentication.isHostedTaskMutationAuthorized?.(request, teamId)) === true;
    } catch {
      return false;
    }
  }
}

function diagnosticCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const errno = Reflect.get(error, 'code');
    if (typeof errno === 'string' && /^[A-Z0-9_]{1,32}$/u.test(errno)) {
      return `errno-${errno.toLowerCase().replaceAll('_', '-')}`;
    }
  }
  const message = error instanceof Error ? error.message : '';
  return /^[a-z0-9][a-z0-9-]{0,127}$/u.test(message) ? message : 'unknown';
}

/**
 * Owns the single hosted task-board HTTP contribution. It deliberately exposes only `register`;
 * the standalone/lifecycle owner decides whether and where to mount that contribution later.
 */
export function createHostedTaskBoardReadComposition(
  dependencies: CreateHostedTaskBoardReadCompositionDependencies
): HostedTaskBoardReadComposition {
  const runtimeInstance = createRuntimeInstanceContext(dependencies.runtimeInstance);
  if (
    runtimeInstance.deploymentId !== dependencies.expectedDeploymentId ||
    !(dependencies.mountBinding instanceof WorkspaceMountBinding) ||
    dependencies.mountBinding.bootId !== runtimeInstance.bootId ||
    dependencies.mountBinding.health === 'unavailable'
  ) {
    throw new TypeError('hosted-task-board-read-composition-binding-invalid');
  }
  const nowMs = dependencies.nowMs ?? Date.now;
  const contexts = createAuthenticatedHostedQueryContextFactory({
    authentication: dependencies.authentication,
    runtimeInstance,
    clock: Object.freeze({ nowMs }),
  });
  const contextRequests = new WeakMap<QueryContext, object>();
  const ownerSource =
    dependencies.source ??
    new DescriptorBoundHostedTaskBoardReadSource({
      runtimeInstance,
      mountBinding: dependencies.mountBinding,
      teamIdentities: dependencies.teamIdentities,
      nowMs,
      ...(dependencies.reportReadDiagnostic === undefined
        ? {}
        : { reportReadDiagnostic: dependencies.reportReadDiagnostic }),
    });
  const boundReads =
    dependencies.admittedReadBindings === undefined
      ? null
      : createHostedBoundTeamReadDispatcher(dependencies);
  const sources =
    boundReads === null
      ? null
      : new Map(
          boundReads.bindings.map((binding) => [
            binding.workspaceId,
            binding === dependencies.mountBinding
              ? ownerSource
              : new DescriptorBoundHostedTaskBoardReadSource({
                  runtimeInstance,
                  mountBinding: binding,
                  teamIdentities: dependencies.teamIdentities,
                  nowMs,
                  ...(dependencies.reportReadDiagnostic === undefined
                    ? {}
                    : { reportReadDiagnostic: dependencies.reportReadDiagnostic }),
                }),
          ])
        );
  const source: HostedTaskBoardAuthorityPort =
    boundReads === null || sources === null
      ? ownerSource
      : Object.freeze({
          async readWindow(
            request: HostedTaskBoardAuthorityReadWindowRequest,
            context: QueryContext
          ) {
            const found = await boundReads.target(request.teamId);
            if (found.kind === 'not_found') return Object.freeze({ kind: 'not_found' });
            if (found.kind !== 'found') return Object.freeze({ kind: 'unavailable' });
            const selected = sources.get(found.target.binding.workspaceId);
            if (!selected) return Object.freeze({ kind: 'unavailable' });
            const result = await selected.readWindow(request, context);
            return (await found.target.stillCurrent())
              ? result
              : Object.freeze({ kind: 'unavailable' });
          },
          ...(ownerSource.observeTaskCreation === undefined
            ? {}
            : {
                async observeTaskCreation(
                  request: HostedTaskBoardAuthorityObserveCreationRequest,
                  context: QueryContext
                ) {
                  const found = await boundReads.target(request.original.teamId);
                  if (
                    found.kind !== 'found' ||
                    found.target.binding !== dependencies.mountBinding
                  ) {
                    return Object.freeze({ kind: 'unavailable' });
                  }
                  const result = await ownerSource.observeTaskCreation!(request, context);
                  return (await found.target.stillCurrent())
                    ? result
                    : Object.freeze({ kind: 'unavailable' });
                },
              }),
        });
  const mutationAuthorityCandidate =
    dependencies.mountBinding.health !== 'healthy' ||
    typeof dependencies.authentication.isHostedTaskMutationAuthorized !== 'function'
      ? undefined
      : dependencies.mutationAuthority;
  const mutationAuthority =
    typeof mutationAuthorityCandidate?.admitTaskMutation === 'function' &&
    typeof mutationAuthorityCandidate.bindGrantFence === 'function'
      ? mutationAuthorityCandidate
      : undefined;
  const authority = new LiveGrantTaskBoardReadAuthority(
    source,
    mutationAuthority,
    contextRequests,
    dependencies.authentication,
    dependencies.reportReadDiagnostic,
    boundReads === null
      ? undefined
      : async (teamId) => {
          const found = await boundReads.target(teamId);
          return (
            found.kind === 'found' &&
            found.target.binding === dependencies.mountBinding &&
            (await found.target.stillCurrent())
          );
        }
  );
  const feature = createHostedTeamTaskBoardFeature({
    ...createHostedTeamTaskBoardOutputAdapters(authority),
    clock: Object.freeze({ now: nowMs }),
  });
  const contribution = createHostedTeamTaskBoardRouteContribution(feature);
  let registered = false;

  return Object.freeze({
    get mutationsEnabled(): boolean {
      return registered && typeof feature.executeMutation === 'function';
    },
    canReadWorkspace(runtimeWorkspaceId: string): boolean {
      return boundReads === null
        ? runtimeWorkspaceId === dependencies.mountBinding.workspaceId
        : boundReads.canReadWorkspace(runtimeWorkspaceId);
    },
    register(app: FastifyInstance): void {
      if (registered) throw new Error('hosted-task-board-read-composition-already-registered');
      registerHostedTeamTaskBoardHttp(app, contribution.facade, (request, signal) => {
        const result = contexts.create(request, signal);
        if (result.kind !== 'success') {
          throw new Error(`hosted-task-board-read-query-context-${result.code}`);
        }
        contextRequests.set(result.context, request);
        return result.context;
      });
      registered = true;
    },
  });
}
