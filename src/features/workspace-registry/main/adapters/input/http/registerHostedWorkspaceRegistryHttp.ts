import {
  HOSTED_WORKSPACE_CAPABILITIES,
  HOSTED_WORKSPACE_REGISTRY_ROUTES,
  HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
  type HostedWorkspaceCapability,
  type HostedWorkspaceDto,
  type HostedWorkspaceRegistryErrorCode,
  type HostedWorkspaceRegistryListResponse,
  type HostedWorkspaceRegistrySelectResponse,
  parseHostedWorkspaceRegistryListRequest,
  parseHostedWorkspaceRegistryListResponse,
  parseHostedWorkspaceRegistrySelectRequest,
  parseHostedWorkspaceRegistrySelectResponse,
} from '../../../../contracts';
import {
  WorkspaceMountBinding,
  WorkspaceRegistrationRegistry,
} from '../../../../core/domain/WorkspaceRegistration';

import type { WorkspaceOperation } from '../../../../contracts';
import type { WorkspaceRegistryStartupSnapshot } from '../../../application/ReadOnlyWorkspaceManifestReader';
import type {
  ActorId,
  BootId,
  QueryContext,
  SessionId,
  WorkspaceId,
} from '@shared/contracts/hosted';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface HostedWorkspaceRegistryPrincipal {
  readonly actorId: ActorId;
  readonly sessionId: SessionId;
}

export interface HostedWorkspaceRegistryAuthorizationPort {
  projectPublicWorkspaceId(
    principal: HostedWorkspaceRegistryPrincipal,
    runtimeWorkspaceId: WorkspaceId,
    context: QueryContext
  ): WorkspaceId | null | Promise<WorkspaceId | null>;
  resolveRuntimeWorkspaceId(
    principal: HostedWorkspaceRegistryPrincipal,
    publicWorkspaceId: WorkspaceId,
    context: QueryContext
  ): WorkspaceId | null | Promise<WorkspaceId | null>;
}

export interface HostedWorkspaceRegistryHttpFacade {
  list(context: QueryContext): Promise<HostedWorkspaceRegistryListResponse>;
  select(
    workspaceId: WorkspaceId,
    context: QueryContext
  ): Promise<HostedWorkspaceRegistrySelectResponse | null>;
}

export type HostedWorkspaceRegistryContextFactory = (
  request: FastifyRequest,
  signal: AbortSignal
) => QueryContext | Promise<QueryContext>;

const CAPABILITY_BY_OPERATION: Readonly<Record<WorkspaceOperation, HostedWorkspaceCapability>> =
  Object.freeze({
    'workspace.registry.get-worktree-git-status': 'git.status.read',
    'workspace.registry.initialize-git-repository': 'git.repository.initialize',
    'workspace.registry.create-initial-git-commit': 'git.initial-commit.create',
    'workspace.registry.get-project-branch': 'git.branch.read',
    'workspace.registry.set-project-branch-tracking': 'git.branch-tracking.update',
  });
const CAPABILITY_ORDER = new Map(
  HOSTED_WORKSPACE_CAPABILITIES.map((capability, index) => [capability, index])
);

/** Read-only projection of the launcher-admitted startup snapshot. */
export class HostedWorkspaceRegistryHttpAdapter implements HostedWorkspaceRegistryHttpFacade {
  readonly #registry: WorkspaceRegistrationRegistry;
  readonly #bindings: ReadonlyMap<WorkspaceId, WorkspaceMountBinding>;

  constructor(
    snapshot: WorkspaceRegistryStartupSnapshot,
    private readonly authorization: HostedWorkspaceRegistryAuthorizationPort,
    currentBootId: BootId
  ) {
    if (!(snapshot?.registry instanceof WorkspaceRegistrationRegistry)) {
      throw new TypeError('hosted-workspace-registry-snapshot-invalid');
    }
    if (
      !authorization ||
      typeof authorization.projectPublicWorkspaceId !== 'function' ||
      typeof authorization.resolveRuntimeWorkspaceId !== 'function'
    ) {
      throw new TypeError('hosted-workspace-registry-authorization-invalid');
    }
    const bindings = new Map<WorkspaceId, WorkspaceMountBinding>();
    const seenWorkspaceIds = new Set<WorkspaceId>();
    if (!Array.isArray(snapshot.bindings)) {
      throw new TypeError('hosted-workspace-registry-bindings-invalid');
    }
    for (const binding of snapshot.bindings) {
      if (
        !(binding instanceof WorkspaceMountBinding) ||
        seenWorkspaceIds.has(binding.workspaceId)
      ) {
        throw new TypeError('hosted-workspace-registry-bindings-invalid');
      }
      seenWorkspaceIds.add(binding.workspaceId);
      if (binding.bootId !== currentBootId) continue;
      bindings.set(binding.workspaceId, binding);
    }
    this.#registry = snapshot.registry;
    this.#bindings = bindings;
  }

  async list(context: QueryContext): Promise<HostedWorkspaceRegistryListResponse> {
    assertContextActive(context);
    const principal = principalFrom(context);
    const workspaces: HostedWorkspaceDto[] = [];
    const registrations = [...this.#registry.values()].sort((left, right) =>
      compareText(left.workspaceId, right.workspaceId)
    );
    for (const registration of registrations) {
      if (!registration.enabled) continue;
      const binding = this.#bindings.get(registration.workspaceId);
      if (!binding) continue;
      const publicWorkspaceId = await this.authorization.projectPublicWorkspaceId(
        principal,
        registration.workspaceId,
        context
      );
      assertContextActive(context);
      if (publicWorkspaceId === null) {
        continue;
      }
      workspaces.push(
        projectWorkspace(registration, binding, publicWorkspaceId, opaqueLabel(workspaces.length))
      );
    }
    // Projection awaits can allow an earlier grant to be revoked or ABA-remapped while a later row
    // is being resolved. Revalidate every exact public/runtime pair at the final return boundary.
    for (const workspace of workspaces) {
      if (!(await this.mappingStillAuthorized(principal, workspace.workspaceId, context))) {
        throw new Error('hosted-workspace-registry-grant-fence-changed');
      }
    }
    return parseHostedWorkspaceRegistryListResponse({
      schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
      kind: 'workspace-list',
      workspaces,
    });
  }

  async select(
    workspaceId: WorkspaceId,
    context: QueryContext
  ): Promise<HostedWorkspaceRegistrySelectResponse | null> {
    assertContextActive(context);
    const principal = principalFrom(context);
    const runtimeWorkspaceId = await this.authorization.resolveRuntimeWorkspaceId(
      principal,
      workspaceId,
      context
    );
    assertContextActive(context);
    if (runtimeWorkspaceId === null) {
      return null;
    }
    const registration = this.#registry.getByWorkspaceId(runtimeWorkspaceId);
    const binding = this.#bindings.get(runtimeWorkspaceId);
    if (!registration?.enabled || !binding) return null;
    const registrations = [...this.#registry.values()].sort((left, right) =>
      compareText(left.workspaceId, right.workspaceId)
    );
    let authorizedIndex = 0;
    for (const candidate of registrations) {
      if (!candidate.enabled) continue;
      const candidateBinding = this.#bindings.get(candidate.workspaceId);
      if (!candidateBinding) continue;
      const candidatePublicWorkspaceId =
        candidate.workspaceId === runtimeWorkspaceId
          ? workspaceId
          : await this.authorization.projectPublicWorkspaceId(
              principal,
              candidate.workspaceId,
              context
            );
      assertContextActive(context);
      if (candidatePublicWorkspaceId === null) continue;
      if (candidate.workspaceId === runtimeWorkspaceId) {
        if (!(await this.mappingStillAuthorized(principal, workspaceId, context))) return null;
        return parseHostedWorkspaceRegistrySelectResponse({
          schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
          kind: 'workspace-selection',
          workspace: projectWorkspace(
            registration,
            binding,
            workspaceId,
            opaqueLabel(authorizedIndex)
          ),
        });
      }
      authorizedIndex += 1;
    }
    return null;
  }

  private async mappingStillAuthorized(
    principal: HostedWorkspaceRegistryPrincipal,
    publicWorkspaceId: WorkspaceId,
    context: QueryContext
  ): Promise<boolean> {
    const runtimeWorkspaceId = await this.authorization.resolveRuntimeWorkspaceId(
      principal,
      publicWorkspaceId,
      context
    );
    assertContextActive(context);
    if (runtimeWorkspaceId === null) return false;
    const projected = await this.authorization.projectPublicWorkspaceId(
      principal,
      runtimeWorkspaceId,
      context
    );
    assertContextActive(context);
    return projected === publicWorkspaceId;
  }
}

export function registerHostedWorkspaceRegistryHttp(
  app: FastifyInstance,
  facade: HostedWorkspaceRegistryHttpFacade,
  createContext: HostedWorkspaceRegistryContextFactory,
  releaseContext?: (context: QueryContext) => void
): void {
  app.post<{ Body: unknown }>(HOSTED_WORKSPACE_REGISTRY_ROUTES.list, async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    try {
      parseHostedWorkspaceRegistryListRequest(request.body);
    } catch {
      return sendError(reply, 400, 'invalid_request');
    }
    try {
      return await withRequestSignal(request, reply, async (signal) => {
        const context = await createContext(request, signal);
        try {
          return await withContextDeadline(context, async (boundedContext) => {
            const result = await facade.list(boundedContext);
            assertContextActive(boundedContext);
            return reply.status(200).send(parseHostedWorkspaceRegistryListResponse(result));
          });
        } finally {
          releaseContext?.(context);
        }
      });
    } catch {
      return sendError(reply, 503, 'unavailable');
    }
  });

  app.post<{ Body: unknown }>(HOSTED_WORKSPACE_REGISTRY_ROUTES.select, async (request, reply) => {
    void reply.header('Cache-Control', 'no-store');
    let workspaceId: WorkspaceId;
    try {
      workspaceId = parseHostedWorkspaceRegistrySelectRequest(request.body).workspaceId;
    } catch {
      return sendError(reply, 400, 'invalid_request');
    }
    try {
      return await withRequestSignal(request, reply, async (signal) => {
        const context = await createContext(request, signal);
        try {
          return await withContextDeadline(context, async (boundedContext) => {
            const result = await facade.select(workspaceId, boundedContext);
            assertContextActive(boundedContext);
            if (result === null) return sendError(reply, 404, 'not_found');
            return reply.status(200).send(parseHostedWorkspaceRegistrySelectResponse(result));
          });
        } finally {
          releaseContext?.(context);
        }
      });
    } catch {
      return sendError(reply, 503, 'unavailable');
    }
  });
}

function projectWorkspace(
  registration: ReturnType<WorkspaceRegistrationRegistry['requireEnabled']>,
  binding: WorkspaceMountBinding,
  publicWorkspaceId: WorkspaceId,
  label: string
): HostedWorkspaceDto {
  const capabilities = (binding.health === 'unavailable' ? [] : binding.allowedOperations)
    .map((operation) => CAPABILITY_BY_OPERATION[operation])
    .sort(
      (left, right) =>
        (CAPABILITY_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (CAPABILITY_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER)
    );
  return Object.freeze({
    workspaceId: publicWorkspaceId,
    label,
    registrationRevision: registration.registrationRevision,
    mount: Object.freeze({
      bootId: binding.bootId,
      mountGeneration: binding.mountGeneration,
      observedAt: binding.observedAt,
      health: binding.health,
      capabilities: Object.freeze(capabilities),
    }),
  });
}

function opaqueLabel(index: number): string {
  return `Workspace ${index + 1}`;
}

function principalFrom(context: QueryContext): HostedWorkspaceRegistryPrincipal {
  return Object.freeze({ actorId: context.actorId, sessionId: context.sessionId });
}

function assertContextActive(context: QueryContext): void {
  if (context.signal.aborted || Date.now() >= context.deadlineAtMs) {
    throw new Error('hosted-workspace-registry-request-ended');
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sendError(
  reply: FastifyReply,
  status: 400 | 404 | 503,
  code: HostedWorkspaceRegistryErrorCode
): FastifyReply {
  if (reply.sent || reply.raw.destroyed) return reply;
  return reply.status(status).send({
    schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
    kind: 'error',
    code,
  });
}

async function withRequestSignal<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  request.raw.once('aborted', abort);
  request.raw.socket.once('close', abort);
  reply.raw.once('close', abort);
  try {
    if (request.raw.aborted || request.raw.socket.destroyed || reply.raw.destroyed) {
      controller.abort();
    }
    if (controller.signal.aborted) {
      throw new Error('hosted-workspace-registry-request-ended');
    }
    return await raceAbort(operation(controller.signal), controller.signal);
  } finally {
    request.raw.removeListener('aborted', abort);
    request.raw.socket.removeListener('close', abort);
    reply.raw.removeListener('close', abort);
  }
}

async function withContextDeadline<T>(
  context: QueryContext,
  operation: (boundedContext: QueryContext) => Promise<T>
): Promise<T> {
  if (context.signal.aborted || Date.now() >= context.deadlineAtMs) {
    throw new Error('hosted-workspace-registry-request-ended');
  }
  const deadlineController = new AbortController();
  const timeout = setTimeout(
    () => deadlineController.abort(),
    Math.max(0, context.deadlineAtMs - Date.now())
  );
  const abort = (): void => deadlineController.abort();
  context.signal.addEventListener('abort', abort, { once: true });
  const boundedContext = Object.freeze({ ...context, signal: deadlineController.signal });
  try {
    return await raceAbort(operation(boundedContext), deadlineController.signal);
  } finally {
    clearTimeout(timeout);
    context.signal.removeEventListener('abort', abort);
  }
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('hosted-workspace-registry-request-ended'));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error('hosted-workspace-registry-request-ended'));
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
