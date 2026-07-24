import {
  createRuntimeInstanceContext,
  type RuntimeInstanceContext,
} from '@features/runtime-instance-context';
import {
  MAX_WORKSPACE_ALLOWED_OPERATIONS,
  MAX_WORKSPACE_REGISTRATIONS,
  type WorkspaceMountHealth,
  type WorkspaceOperation,
} from '@features/workspace-registry/contracts';
import {
  AdmittedWorkspaceManifestSource,
  ReadOnlyWorkspaceManifestAdapter,
  type WorkspaceStartupManifestSource,
} from '@features/workspace-registry/main';
import {
  type ActorId,
  type AuthorizedScope,
  type BootId,
  type DeploymentId,
  parseActorId,
  parseAuthorizedScope,
  parseBootId,
  parseDeploymentId,
  parseWorkspaceId,
  type WorkspaceId,
} from '@shared/contracts/hosted';

import {
  createTeamLifecycleReadAuthority,
  type TeamLifecycleReadAuthority,
} from './teamLifecycleReadComposition';

import type { WorkspaceMountBinding } from '@features/workspace-registry';

export const TEAM_LIFECYCLE_READ_BOOTSTRAP_ENV = 'AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP';
const COMPATIBILITY_READ_BOOTSTRAP_ENV = 'AGENT_TEAMS_HOSTED_PHASE2_READ_BOOTSTRAP';
export const TEAM_LIFECYCLE_READ_BOOTSTRAP_FORMAT =
  'agent-teams.team-lifecycle-read-bootstrap/v1' as const;
const COMPATIBILITY_READ_BOOTSTRAP_FORMAT = 'agent-teams.phase2-read-bootstrap/v1';
export const TEAM_LIFECYCLE_READ_AUTHORIZED_SCOPE = 'scope_team-lifecycle.read' as const;

const LAUNCHER_MANIFEST_SOURCE_LOCATION = 'launcher-owned:team-lifecycle-read-bootstrap-manifest';
const MAX_SERIALIZED_BOOTSTRAP_BYTES = 1_048_576;
const BOOTSTRAP_KEYS = [
  'format',
  'issuedAtMs',
  'expiresAtMs',
  'actorId',
  'authorizedScope',
  'deploymentId',
  'bootId',
  'workspaceId',
  'runtimeInstance',
  'workspaceManifest',
] as const;
const MANIFEST_KEYS = ['version', 'registrations'] as const;
const REGISTRATION_KEYS = [
  'schemaVersion',
  'registrationKey',
  'workspaceId',
  'displayName',
  'registrationRevision',
  'declaredRootHash',
  'enabled',
] as const;
const MOUNT_BINDING_KEYS = [
  'bootId',
  'mountGeneration',
  'observedAt',
  'health',
  'allowedOperations',
] as const;

export interface TeamLifecycleReadBootstrapInput {
  /** Reads the single launcher-owned value. Implementations must not perform discovery. */
  readSerializedBootstrap(): unknown | Promise<unknown>;
}

export interface TeamLifecycleReadBootstrapSourceDependencies {
  readonly input: TeamLifecycleReadBootstrapInput;
  readonly nowMs: () => number;
}

export interface TeamLifecycleReadBootstrap {
  readonly actorId: ActorId;
  readonly authorizedScope: AuthorizedScope;
  readonly deploymentId: DeploymentId;
  readonly bootId: BootId;
  readonly workspaceId: WorkspaceId;
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly mountBinding: WorkspaceMountBinding;
  readonly authority: TeamLifecycleReadAuthority;
}

interface StrictWorkspaceManifest {
  readonly version: 1;
  readonly registrations: readonly StrictWorkspaceManifestRegistration[];
}

interface StrictWorkspaceManifestRegistration {
  readonly schemaVersion: unknown;
  readonly registrationKey: unknown;
  readonly workspaceId: unknown;
  readonly displayName: unknown;
  readonly registrationRevision: unknown;
  readonly declaredRootHash: unknown;
  readonly enabled: unknown;
  readonly mountBinding?: StrictWorkspaceManifestMountBinding;
}

interface StrictWorkspaceManifestMountBinding {
  readonly bootId: unknown;
  readonly mountGeneration: unknown;
  readonly observedAt: unknown;
  readonly health: unknown;
  readonly allowedOperations: readonly unknown[];
}

interface ParsedBootstrapEnvelope {
  readonly actorId: ActorId;
  readonly authorizedScope: AuthorizedScope;
  readonly deploymentId: DeploymentId;
  readonly bootId: BootId;
  readonly workspaceId: WorkspaceId;
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly workspaceManifest: StrictWorkspaceManifest;
}

/**
 * Reads the stable launcher key first and falls back to the private compatibility key. Keeping the
 * compatibility identifier private makes this the only environment compatibility boundary;
 * callers can export or inject only the stable key.
 */
export function readTeamLifecycleReadBootstrapEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): string | undefined {
  return (
    environment[TEAM_LIFECYCLE_READ_BOOTSTRAP_ENV] ?? environment[COMPATIBILITY_READ_BOOTSTRAP_ENV]
  );
}

/** Accepts the compatibility serialized tag only at bootstrap ingress. */
function isTeamLifecycleReadBootstrapReadFormat(value: unknown): boolean {
  return (
    value === TEAM_LIFECYCLE_READ_BOOTSTRAP_FORMAT || value === COMPATIBILITY_READ_BOOTSTRAP_FORMAT
  );
}

/**
 * Admits the one immutable hosted bootstrap supplied by the launcher. The adapter deliberately has
 * no filesystem, project-discovery, identity-storage, random-ID, or process-environment dependency.
 */
export class TeamLifecycleReadBootstrapSource {
  readonly #readSerializedBootstrap: () => unknown | Promise<unknown>;
  readonly #nowMs: () => number;
  #readAttempted = false;

  constructor(dependencies: TeamLifecycleReadBootstrapSourceDependencies) {
    if (!dependencies || typeof dependencies !== 'object') {
      throw new TypeError('team-lifecycle-read-bootstrap-source-invalid');
    }
    const input = dependencies.input;
    const readSerializedBootstrap = input?.readSerializedBootstrap;
    const nowMs = dependencies.nowMs;
    if (typeof readSerializedBootstrap !== 'function' || typeof nowMs !== 'function') {
      throw new TypeError('team-lifecycle-read-bootstrap-source-invalid');
    }
    this.#readSerializedBootstrap = readSerializedBootstrap.bind(input);
    this.#nowMs = nowMs;
  }

  async load(): Promise<TeamLifecycleReadBootstrap> {
    if (this.#readAttempted) {
      throw new Error('team-lifecycle-read-bootstrap-source-already-read');
    }
    this.#readAttempted = true;

    try {
      const serialized = await this.#readSerializedBootstrap();
      const nowMs = parseTimestamp(this.#nowMs());
      const envelope = parseBootstrapEnvelope(serialized, nowMs);
      const manifestSource: WorkspaceStartupManifestSource = Object.freeze({
        sourceLocation: LAUNCHER_MANIFEST_SOURCE_LOCATION,
        readStartupManifest: () => envelope.workspaceManifest,
      });
      const admittedManifestSource = await AdmittedWorkspaceManifestSource.admit(
        manifestSource,
        Object.freeze({
          assertAdmittedSource(sourceLocation: string): void {
            if (sourceLocation !== LAUNCHER_MANIFEST_SOURCE_LOCATION) {
              throw new TypeError('team-lifecycle-read-bootstrap-manifest-source-invalid');
            }
          },
        })
      );
      const snapshot = await new ReadOnlyWorkspaceManifestAdapter(admittedManifestSource).load({
        kind: 'empty-deployment',
      });
      const matchingBindings = snapshot.bindings.filter(
        (binding) =>
          binding.workspaceId === envelope.workspaceId && binding.bootId === envelope.bootId
      );
      if (matchingBindings.length !== 1 || matchingBindings[0].health === 'unavailable') {
        throw new TypeError('team-lifecycle-read-bootstrap-binding-invalid');
      }

      const mountBinding = matchingBindings[0];
      const authority = createTeamLifecycleReadAuthority({
        actorId: envelope.actorId,
        authorizedScope: envelope.authorizedScope,
        runtimeInstance: envelope.runtimeInstance,
        mountBinding,
      });
      return Object.freeze({
        actorId: envelope.actorId,
        authorizedScope: envelope.authorizedScope,
        deploymentId: envelope.deploymentId,
        bootId: envelope.bootId,
        workspaceId: envelope.workspaceId,
        runtimeInstance: envelope.runtimeInstance,
        mountBinding,
        authority,
      });
    } catch {
      throw new TypeError('team-lifecycle-read-bootstrap-invalid');
    }
  }
}

function parseBootstrapEnvelope(serialized: unknown, nowMs: number): ParsedBootstrapEnvelope {
  if (
    typeof serialized !== 'string' ||
    serialized.length === 0 ||
    Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_BOOTSTRAP_BYTES
  ) {
    throw new TypeError('team-lifecycle-read-bootstrap-serialized-invalid');
  }

  const parsed = JSON.parse(serialized) as unknown;
  const value = readExactRecord(parsed, BOOTSTRAP_KEYS);
  if (!isTeamLifecycleReadBootstrapReadFormat(value.format)) {
    throw new TypeError('team-lifecycle-read-bootstrap-format-invalid');
  }
  const issuedAtMs = parseTimestamp(value.issuedAtMs);
  const expiresAtMs = parseTimestamp(value.expiresAtMs);
  if (issuedAtMs > nowMs || expiresAtMs <= nowMs || expiresAtMs <= issuedAtMs) {
    throw new TypeError('team-lifecycle-read-bootstrap-stale');
  }

  const actorId = parseActorId(value.actorId);
  const authorizedScope = parseAuthorizedScope(value.authorizedScope);
  if (authorizedScope !== TEAM_LIFECYCLE_READ_AUTHORIZED_SCOPE) {
    throw new TypeError('team-lifecycle-read-bootstrap-scope-invalid');
  }
  const deploymentId = parseDeploymentId(value.deploymentId);
  const bootId = parseBootId(value.bootId);
  const workspaceId = parseWorkspaceId(value.workspaceId);
  const runtimeInstance = createRuntimeInstanceContext(value.runtimeInstance);
  if (runtimeInstance.deploymentId !== deploymentId || runtimeInstance.bootId !== bootId) {
    throw new TypeError('team-lifecycle-read-bootstrap-runtime-foreign');
  }

  return Object.freeze({
    actorId,
    authorizedScope,
    deploymentId,
    bootId,
    workspaceId,
    runtimeInstance,
    workspaceManifest: parseStrictWorkspaceManifest(value.workspaceManifest),
  });
}

function parseStrictWorkspaceManifest(value: unknown): StrictWorkspaceManifest {
  const manifest = readExactRecord(value, MANIFEST_KEYS);
  if (manifest.version !== 1) {
    throw new TypeError('team-lifecycle-read-bootstrap-manifest-version-invalid');
  }
  const registrations = readDenseArray(
    manifest.registrations,
    MAX_WORKSPACE_REGISTRATIONS,
    'team-lifecycle-read-bootstrap-manifest-registrations-invalid'
  ).map(parseStrictWorkspaceManifestRegistration);
  return Object.freeze({ version: 1, registrations: Object.freeze(registrations) });
}

function parseStrictWorkspaceManifestRegistration(
  value: unknown
): StrictWorkspaceManifestRegistration {
  const record = readExactRecord(value, REGISTRATION_KEYS, ['mountBinding']);
  const registration = {
    schemaVersion: record.schemaVersion,
    registrationKey: record.registrationKey,
    workspaceId: record.workspaceId,
    displayName: record.displayName,
    registrationRevision: record.registrationRevision,
    declaredRootHash: record.declaredRootHash,
    enabled: record.enabled,
  };
  return Object.hasOwn(record, 'mountBinding')
    ? Object.freeze({
        ...registration,
        mountBinding: parseStrictWorkspaceManifestMountBinding(record.mountBinding),
      })
    : Object.freeze(registration);
}

function parseStrictWorkspaceManifestMountBinding(
  value: unknown
): StrictWorkspaceManifestMountBinding {
  const record = readExactRecord(value, MOUNT_BINDING_KEYS);
  const allowedOperations = readDenseArray(
    record.allowedOperations,
    MAX_WORKSPACE_ALLOWED_OPERATIONS,
    'team-lifecycle-read-bootstrap-manifest-operations-invalid'
  );
  return Object.freeze({
    bootId: record.bootId,
    mountGeneration: record.mountGeneration,
    observedAt: record.observedAt,
    health: record.health as WorkspaceMountHealth,
    allowedOperations: Object.freeze([...allowedOperations]) as readonly WorkspaceOperation[],
  });
}

function parseTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError('team-lifecycle-read-bootstrap-timestamp-invalid');
  }
  return value as number;
}

function readExactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = []
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('team-lifecycle-read-bootstrap-record-invalid');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('team-lifecycle-read-bootstrap-record-invalid');
  }

  const source = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(source);
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !Object.hasOwn(source, key)) ||
    keys.some((key) => typeof key !== 'string' || !allowedKeys.has(key))
  ) {
    throw new TypeError('team-lifecycle-read-bootstrap-record-invalid');
  }

  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string') {
      throw new TypeError('team-lifecycle-read-bootstrap-record-invalid');
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('team-lifecycle-read-bootstrap-record-invalid');
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function readDenseArray(value: unknown, maximum: number, error: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(error);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes('length')) {
    throw new TypeError(error);
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(error);
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}
