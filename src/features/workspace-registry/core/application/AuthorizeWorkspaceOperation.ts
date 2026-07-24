import {
  type BootId,
  parseBootId,
  parseWorkspaceId,
  type WorkspaceId,
} from '@shared/contracts/hosted';

import {
  parseMountGeneration,
  parseWorkspaceOperation,
  type WorkspaceOperation,
  type WorkspaceOperationRequest,
} from '../../contracts/workspace-registration';

import type { WorkspaceMountBinding } from '../domain/WorkspaceRegistration';

export interface WorkspaceMountBindingSource {
  /**
   * Returns binding evidence only after operation-time mount revalidation. Implementations must not
   * serve an unchecked startup snapshot or cache a result across mount generations.
   */
  getRevalidatedBinding(workspaceId: WorkspaceId): WorkspaceMountBinding | undefined;
}

const authorizationIntentIssuer: unique symbol = Symbol('workspace-operation-authorization-issuer');

export class AuthorizedWorkspaceOperation<
  TOperation extends WorkspaceOperation = WorkspaceOperation,
> {
  readonly #workspaceId: WorkspaceId;
  readonly #bootId: BootId;
  readonly #mountGeneration: number;
  readonly #operation: TOperation;

  constructor(
    request: WorkspaceOperationRequest & { readonly operation: TOperation },
    issuer: typeof authorizationIntentIssuer
  ) {
    if (issuer !== authorizationIntentIssuer) {
      throw new TypeError('workspace-operation-authorization-intent-forged');
    }
    this.#workspaceId = request.workspaceId;
    this.#bootId = request.bootId;
    this.#mountGeneration = request.mountGeneration;
    this.#operation = request.operation;
    Object.freeze(this);
  }

  get workspaceId(): WorkspaceId {
    return this.#workspaceId;
  }

  get bootId(): BootId {
    return this.#bootId;
  }

  get mountGeneration(): number {
    return this.#mountGeneration;
  }

  get operation(): TOperation {
    return this.#operation;
  }

  toJSON(): never {
    throw new TypeError('workspace-operation-authorization-intent-not-serializable');
  }
}

export class AuthorizeWorkspaceOperation {
  constructor(private readonly bindings: WorkspaceMountBindingSource) {}

  execute<TOperation extends WorkspaceOperation>(
    request: WorkspaceOperationRequest & { readonly operation: TOperation }
  ): AuthorizedWorkspaceOperation<TOperation> {
    const workspaceId = parseWorkspaceId(request.workspaceId);
    const bootId = parseBootId(request.bootId);
    const operation = parseWorkspaceOperation(request.operation) as TOperation;
    const mountGeneration = parseMountGeneration(request.mountGeneration);
    const binding = this.bindings.getRevalidatedBinding(workspaceId);

    if (!binding) {
      throw new Error('workspace-operation-binding-not-found');
    }
    if (binding.workspaceId !== workspaceId) {
      throw new Error('workspace-operation-binding-identity-mismatch');
    }
    if (binding.bootId !== bootId) {
      throw new Error('workspace-operation-prior-boot-rejected');
    }
    if (binding.mountGeneration !== mountGeneration) {
      throw new Error('workspace-operation-stale-generation-rejected');
    }
    if (!binding.allows(operation)) {
      throw new Error('workspace-operation-not-authorized');
    }

    return new AuthorizedWorkspaceOperation(
      {
        workspaceId: binding.workspaceId,
        bootId: binding.bootId,
        mountGeneration: binding.mountGeneration,
        operation,
      },
      authorizationIntentIssuer
    );
  }
}
