import {
  type BootId,
  parseBootId,
  parseWorkspaceId,
  type WorkspaceId,
} from '@shared/contracts/hosted';

import {
  MAX_WORKSPACE_REGISTRATIONS,
  parseAllowedWorkspaceOperations,
  parseDeclaredRootHash,
  parseMountGeneration,
  parseRegistrationKey,
  parseRegistrationRevision,
  parseWorkspaceDisplayName,
  parseWorkspaceRegistrationSchemaVersion,
  type WorkspaceMountHealth,
  type WorkspaceOperation,
  type WorkspaceRegistrationValue,
} from '../../contracts/workspace-registration';

export class WorkspaceRegistration {
  readonly schemaVersion: WorkspaceRegistrationValue['schemaVersion'];
  readonly registrationKey: string;
  readonly workspaceId: WorkspaceId;
  readonly displayName: string;
  readonly registrationRevision: number;
  readonly declaredRootHash: string;
  readonly enabled: boolean;

  constructor(value: WorkspaceRegistrationValue) {
    if (typeof value.enabled !== 'boolean') {
      throw new TypeError('workspace-registration-enabled-invalid');
    }
    this.schemaVersion = parseWorkspaceRegistrationSchemaVersion(value.schemaVersion);
    this.registrationKey = parseRegistrationKey(value.registrationKey);
    this.workspaceId = parseWorkspaceId(value.workspaceId);
    this.displayName = parseWorkspaceDisplayName(value.displayName);
    this.registrationRevision = parseRegistrationRevision(value.registrationRevision);
    this.declaredRootHash = parseDeclaredRootHash(value.declaredRootHash);
    this.enabled = value.enabled;
    Object.freeze(this);
  }

  assertEnabled(): void {
    if (!this.enabled) {
      throw new Error('workspace-registration-disabled');
    }
  }

  assertStableSuccessor(next: WorkspaceRegistration): void {
    if (next.registrationKey !== this.registrationKey) {
      throw new Error('workspace-registration-key-changed');
    }
    if (next.workspaceId !== this.workspaceId) {
      throw new Error('workspace-registration-identity-changed');
    }
    if (next.declaredRootHash !== this.declaredRootHash) {
      throw new Error('workspace-registration-root-changed');
    }
    if (next.registrationRevision < this.registrationRevision) {
      throw new Error('workspace-registration-revision-regressed');
    }
    if (
      next.registrationRevision === this.registrationRevision &&
      (next.displayName !== this.displayName || next.enabled !== this.enabled)
    ) {
      throw new Error('workspace-registration-revision-not-advanced');
    }
  }

  toValue(): WorkspaceRegistrationValue {
    return Object.freeze({
      schemaVersion: this.schemaVersion,
      registrationKey: this.registrationKey,
      workspaceId: this.workspaceId,
      displayName: this.displayName,
      registrationRevision: this.registrationRevision,
      declaredRootHash: this.declaredRootHash,
      enabled: this.enabled,
    });
  }
}

export class WorkspaceRegistrationRegistry {
  readonly #byRegistrationKey: ReadonlyMap<string, WorkspaceRegistration>;
  readonly #byWorkspaceId: ReadonlyMap<WorkspaceId, WorkspaceRegistration>;

  constructor(
    registrations: readonly WorkspaceRegistration[],
    previous?: WorkspaceRegistrationRegistry
  ) {
    assertBoundedDenseRegistrations(registrations);
    const byRegistrationKey = new Map<string, WorkspaceRegistration>();
    const byWorkspaceId = new Map<WorkspaceId, WorkspaceRegistration>();
    const byDeclaredRootHash = new Map<string, WorkspaceRegistration>();

    for (const registration of registrations) {
      if (byRegistrationKey.has(registration.registrationKey)) {
        throw new Error('workspace-registration-key-duplicate');
      }
      if (byWorkspaceId.has(registration.workspaceId)) {
        throw new Error('workspace-registration-identity-ambiguous');
      }
      if (byDeclaredRootHash.has(registration.declaredRootHash)) {
        throw new Error('workspace-registration-root-ambiguous');
      }

      previous
        ?.getByRegistrationKey(registration.registrationKey)
        ?.assertStableSuccessor(registration);
      byRegistrationKey.set(registration.registrationKey, registration);
      byWorkspaceId.set(registration.workspaceId, registration);
      byDeclaredRootHash.set(registration.declaredRootHash, registration);
    }

    for (const previousRegistration of previous?.values() ?? []) {
      if (!byRegistrationKey.has(previousRegistration.registrationKey)) {
        throw new Error('workspace-registration-removed-without-tombstone');
      }
    }

    this.#byRegistrationKey = byRegistrationKey;
    this.#byWorkspaceId = byWorkspaceId;
    Object.freeze(this);
  }

  getByRegistrationKey(registrationKey: string): WorkspaceRegistration | undefined {
    return this.#byRegistrationKey.get(parseRegistrationKey(registrationKey));
  }

  getByWorkspaceId(workspaceId: WorkspaceId): WorkspaceRegistration | undefined {
    return this.#byWorkspaceId.get(parseWorkspaceId(workspaceId));
  }

  requireEnabled(workspaceId: WorkspaceId): WorkspaceRegistration {
    const registration = this.getByWorkspaceId(workspaceId);
    if (!registration) {
      throw new Error('workspace-registration-not-found');
    }
    registration.assertEnabled();
    return registration;
  }

  values(): readonly WorkspaceRegistration[] {
    return Object.freeze([...this.#byRegistrationKey.values()]);
  }
}

export interface WorkspaceMountBindingInput {
  readonly registration: WorkspaceRegistration;
  readonly bootId: BootId;
  readonly mountGeneration: number;
  readonly previousMountGeneration?: number;
  readonly declaredRootHash: string;
  readonly observedAt: number;
  readonly health: WorkspaceMountHealth;
  readonly allowedOperations: readonly WorkspaceOperation[];
}

export class WorkspaceMountBinding {
  readonly workspaceId: WorkspaceId;
  readonly bootId: BootId;
  readonly mountGeneration: number;
  readonly declaredRootHash: string;
  readonly observedAt: number;
  readonly health: WorkspaceMountHealth;
  readonly allowedOperations: readonly WorkspaceOperation[];

  constructor(input: WorkspaceMountBindingInput) {
    input.registration.assertEnabled();
    const declaredRootHash = parseDeclaredRootHash(input.declaredRootHash);
    if (declaredRootHash !== input.registration.declaredRootHash) {
      throw new Error('workspace-mount-declared-root-mismatch');
    }

    const mountGeneration = parseMountGeneration(input.mountGeneration);
    if (input.previousMountGeneration !== undefined) {
      const previousMountGeneration = parseMountGeneration(input.previousMountGeneration);
      if (mountGeneration !== previousMountGeneration + 1) {
        throw new Error('workspace-mount-generation-not-advanced');
      }
    } else if (mountGeneration !== 1) {
      throw new Error('workspace-mount-initial-generation-invalid');
    }

    if (!Number.isSafeInteger(input.observedAt) || input.observedAt < 0) {
      throw new TypeError('workspace-mount-observed-at-invalid');
    }
    if (!['healthy', 'read-only', 'unavailable'].includes(input.health)) {
      throw new TypeError('workspace-mount-health-invalid');
    }

    const operations = parseAllowedWorkspaceOperations(input.allowedOperations);
    if (
      input.health === 'read-only' &&
      operations.some((operation) =>
        [
          'workspace.registry.initialize-git-repository',
          'workspace.registry.create-initial-git-commit',
          'workspace.registry.set-project-branch-tracking',
        ].includes(operation)
      )
    ) {
      throw new Error('workspace-mount-read-only-operation-invalid');
    }

    this.workspaceId = input.registration.workspaceId;
    this.bootId = parseBootId(input.bootId);
    this.mountGeneration = mountGeneration;
    this.declaredRootHash = declaredRootHash;
    this.observedAt = input.observedAt;
    this.health = input.health;
    this.allowedOperations = Object.freeze([...operations]);
    Object.freeze(this);
  }

  allows(operation: WorkspaceOperation): boolean {
    return this.health !== 'unavailable' && this.allowedOperations.includes(operation);
  }
}

function assertBoundedDenseRegistrations(
  value: unknown
): asserts value is readonly WorkspaceRegistration[] {
  if (!Array.isArray(value)) {
    throw new TypeError('workspace-registration-collection-invalid');
  }
  if (value.length > MAX_WORKSPACE_REGISTRATIONS) {
    throw new TypeError('workspace-registration-collection-limit-exceeded');
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new TypeError('workspace-registration-collection-sparse');
    }
  }
}
