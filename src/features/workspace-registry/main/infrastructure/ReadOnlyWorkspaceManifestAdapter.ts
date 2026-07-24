import { parseBootId, parseWorkspaceId } from '@shared/contracts/hosted';

import {
  MAX_WORKSPACE_REGISTRATIONS,
  parseAllowedWorkspaceOperations,
  parseDeclaredRootHash,
  parseMountGeneration,
  parseRegistrationRevision,
  parseWorkspaceDisplayName,
  parseWorkspaceRegistrationSchemaVersion,
  type WorkspaceMountHealth,
  type WorkspaceOperation,
} from '../../contracts/workspace-registration';
import {
  WorkspaceMountBinding,
  WorkspaceRegistration,
  WorkspaceRegistrationRegistry,
} from '../../core/domain/WorkspaceRegistration';

export interface WorkspaceStartupManifestSource {
  readonly sourceLocation: string;
  readStartupManifest(): unknown | Promise<unknown>;
}

export interface WorkspaceManifestSourceAdmission {
  assertAdmittedSource(sourceLocation: string): void | Promise<void>;
}

const admittedSourceIssuer: unique symbol = Symbol('admitted-workspace-manifest-source-issuer');

export class AdmittedWorkspaceManifestSource {
  readonly #source: WorkspaceStartupManifestSource;

  private constructor(source: WorkspaceStartupManifestSource, issuer: typeof admittedSourceIssuer) {
    if (issuer !== admittedSourceIssuer) {
      throw new TypeError('workspace-manifest-source-admission-forged');
    }
    this.#source = source;
  }

  static async admit(
    source: WorkspaceStartupManifestSource,
    admission: WorkspaceManifestSourceAdmission
  ): Promise<AdmittedWorkspaceManifestSource> {
    if (!source || typeof source.readStartupManifest !== 'function') {
      throw new TypeError('workspace-manifest-source-invalid');
    }
    await admission.assertAdmittedSource(source.sourceLocation);
    const admittedSource = new AdmittedWorkspaceManifestSource(source, admittedSourceIssuer);
    admittedManifestSources.add(admittedSource);
    return admittedSource;
  }

  read(): unknown | Promise<unknown> {
    return this.#source.readStartupManifest();
  }
}

const admittedManifestSources = new WeakSet<AdmittedWorkspaceManifestSource>();

export interface WorkspaceRegistryStartupSnapshot {
  readonly registry: WorkspaceRegistrationRegistry;
  readonly bindings: readonly WorkspaceMountBinding[];
}

export type WorkspaceRegistryStartupBaseline =
  | { readonly kind: 'empty-deployment' }
  | {
      readonly kind: 'previous-snapshot';
      readonly snapshot: WorkspaceRegistryStartupSnapshot;
    };

export class ReadOnlyWorkspaceManifestAdapter {
  readonly #source: AdmittedWorkspaceManifestSource;
  #snapshot?: WorkspaceRegistryStartupSnapshot;
  #readAttempted = false;

  constructor(source: AdmittedWorkspaceManifestSource) {
    if (!admittedManifestSources.has(source)) {
      throw new TypeError('workspace-manifest-source-not-admitted');
    }
    this.#source = source;
  }

  async load(
    baseline: WorkspaceRegistryStartupBaseline
  ): Promise<WorkspaceRegistryStartupSnapshot> {
    if (this.#readAttempted) {
      throw new Error('workspace-manifest-startup-source-already-read');
    }
    this.#readAttempted = true;

    if (
      !baseline ||
      (baseline.kind !== 'empty-deployment' && baseline.kind !== 'previous-snapshot')
    ) {
      throw new TypeError('workspace-manifest-startup-baseline-invalid');
    }
    const previousSnapshot = baseline.kind === 'previous-snapshot' ? baseline.snapshot : undefined;
    const previousBindingsByWorkspaceId = indexPreviousBindings(previousSnapshot?.bindings);

    const manifest = parseManifest(await this.#source.read());
    const registrations = manifest.registrations.map(
      (entry) =>
        new WorkspaceRegistration({
          schemaVersion: parseWorkspaceRegistrationSchemaVersion(entry.schemaVersion),
          registrationKey: entry.registrationKey,
          workspaceId: parseWorkspaceId(entry.workspaceId),
          displayName: parseWorkspaceDisplayName(entry.displayName),
          registrationRevision: parseRegistrationRevision(entry.registrationRevision),
          declaredRootHash: parseDeclaredRootHash(entry.declaredRootHash),
          enabled: entry.enabled,
        })
    );
    const registry = new WorkspaceRegistrationRegistry(registrations, previousSnapshot?.registry);
    const bindings = manifest.registrations.flatMap((entry) => {
      if (!entry.enabled) {
        return [];
      }
      if (!entry.mountBinding) {
        throw new Error('workspace-manifest-enabled-registration-unbound');
      }
      const registration = registry.requireEnabled(parseWorkspaceId(entry.workspaceId));
      const previousBinding = previousBindingsByWorkspaceId.get(registration.workspaceId);
      const previousRegistration = previousSnapshot?.registry.getByWorkspaceId(
        registration.workspaceId
      );
      if (previousRegistration?.enabled && !previousBinding) {
        throw new Error('workspace-manifest-previous-binding-missing');
      }
      return [
        new WorkspaceMountBinding({
          registration,
          bootId: parseBootId(entry.mountBinding.bootId),
          mountGeneration: parseMountGeneration(entry.mountBinding.mountGeneration),
          previousMountGeneration: previousBinding?.mountGeneration,
          declaredRootHash: parseDeclaredRootHash(entry.declaredRootHash),
          observedAt: entry.mountBinding.observedAt,
          health: entry.mountBinding.health,
          allowedOperations: entry.mountBinding.allowedOperations,
        }),
      ];
    });

    const workspaceIds = bindings.map((binding) => binding.workspaceId);
    if (new Set(workspaceIds).size !== workspaceIds.length) {
      throw new Error('workspace-manifest-mount-binding-ambiguous');
    }

    this.#snapshot = Object.freeze({
      registry,
      bindings: Object.freeze(bindings),
    });
    return this.#snapshot;
  }
}

interface RawManifestRegistration {
  readonly schemaVersion: unknown;
  readonly registrationKey: string;
  readonly workspaceId: unknown;
  readonly displayName: unknown;
  readonly registrationRevision: unknown;
  readonly declaredRootHash: unknown;
  readonly enabled: boolean;
  readonly mountBinding?: RawManifestMountBinding;
}

interface RawManifestMountBinding {
  readonly bootId: unknown;
  readonly mountGeneration: unknown;
  readonly observedAt: number;
  readonly health: WorkspaceMountHealth;
  readonly allowedOperations: readonly WorkspaceOperation[];
}

interface RawManifest {
  readonly version: 1;
  readonly registrations: readonly RawManifestRegistration[];
}

function parseManifest(value: unknown): RawManifest {
  if (!isRecord(value) || value.version !== 1) {
    throw new TypeError('workspace-manifest-version-unsupported');
  }
  assertBoundedDenseManifestRegistrations(value.registrations);

  const registrations: RawManifestRegistration[] = [];
  for (const entry of value.registrations) {
    if (!isRecord(entry) || typeof entry.registrationKey !== 'string') {
      throw new TypeError('workspace-manifest-registration-invalid');
    }
    if (typeof entry.enabled !== 'boolean') {
      throw new TypeError('workspace-manifest-registration-enabled-invalid');
    }

    registrations.push({
      schemaVersion: entry.schemaVersion,
      registrationKey: entry.registrationKey,
      workspaceId: entry.workspaceId,
      displayName: entry.displayName,
      registrationRevision: entry.registrationRevision,
      declaredRootHash: entry.declaredRootHash,
      enabled: entry.enabled,
      mountBinding:
        entry.mountBinding === undefined ? undefined : parseMountBinding(entry.mountBinding),
    });
  }

  return { version: 1, registrations };
}

function parseMountBinding(value: unknown): RawManifestMountBinding {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.observedAt) ||
    (value.observedAt as number) < 0 ||
    !['healthy', 'read-only', 'unavailable'].includes(value.health as string)
  ) {
    throw new TypeError('workspace-manifest-mount-binding-invalid');
  }
  if (Object.prototype.hasOwnProperty.call(value, 'previousMountGeneration')) {
    throw new TypeError('workspace-manifest-mount-binding-predecessor-forbidden');
  }

  return {
    bootId: value.bootId,
    mountGeneration: value.mountGeneration,
    observedAt: value.observedAt as number,
    health: value.health as WorkspaceMountHealth,
    allowedOperations: parseAllowedWorkspaceOperations(value.allowedOperations),
  };
}

function assertBoundedDenseManifestRegistrations(
  value: unknown
): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError('workspace-manifest-registrations-invalid');
  }
  if (value.length > MAX_WORKSPACE_REGISTRATIONS) {
    throw new TypeError('workspace-manifest-registrations-limit-exceeded');
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new TypeError('workspace-manifest-registrations-sparse');
    }
  }
}

function indexPreviousBindings(
  bindings: readonly WorkspaceMountBinding[] | undefined
): ReadonlyMap<WorkspaceMountBinding['workspaceId'], WorkspaceMountBinding> {
  if (!bindings) {
    return new Map();
  }
  if (!Array.isArray(bindings) || bindings.length > MAX_WORKSPACE_REGISTRATIONS) {
    throw new TypeError('workspace-previous-bindings-invalid');
  }

  const indexed = new Map<WorkspaceMountBinding['workspaceId'], WorkspaceMountBinding>();
  for (let index = 0; index < bindings.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(bindings, index)) {
      throw new TypeError('workspace-previous-bindings-invalid');
    }
    const binding = bindings[index];
    if (indexed.has(binding.workspaceId)) {
      throw new TypeError('workspace-previous-bindings-ambiguous');
    }
    indexed.set(binding.workspaceId, binding);
  }
  return indexed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
