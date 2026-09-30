import {
  type BootId,
  parseBootId,
  parseWorkspaceId,
  type WorkspaceId,
} from '@shared/contracts/hosted';

export const WORKSPACE_REGISTRATION_SCHEMA_VERSION = 1 as const;

export const WORKSPACE_OPERATIONS = [
  'workspace.registry.get-worktree-git-status',
  'workspace.registry.initialize-git-repository',
  'workspace.registry.create-initial-git-commit',
  'workspace.registry.get-project-branch',
  'workspace.registry.set-project-branch-tracking',
] as const;

export const MAX_WORKSPACE_REGISTRATIONS = 256;
export const MAX_WORKSPACE_ALLOWED_OPERATIONS = WORKSPACE_OPERATIONS.length;

export type WorkspaceOperation = (typeof WORKSPACE_OPERATIONS)[number];
export type WorkspaceRegistrationSchemaVersion = typeof WORKSPACE_REGISTRATION_SCHEMA_VERSION;
export type WorkspaceMountHealth = 'healthy' | 'read-only' | 'unavailable';

export interface WorkspaceRegistrationValue {
  readonly schemaVersion: WorkspaceRegistrationSchemaVersion;
  readonly registrationKey: string;
  readonly workspaceId: WorkspaceId;
  readonly displayName: string;
  readonly registrationRevision: number;
  readonly declaredRootHash: string;
  readonly enabled: boolean;
}

export interface WorkspaceMountBindingRef {
  readonly workspaceId: WorkspaceId;
  readonly bootId: BootId;
  readonly mountGeneration: number;
}

export interface WorkspaceOperationRequest extends WorkspaceMountBindingRef {
  readonly operation: WorkspaceOperation;
}

const REGISTRATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DECLARED_ROOT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_DISPLAY_NAME_LENGTH = 128;

export function parseWorkspaceRegistrationSchemaVersion(
  value: unknown
): WorkspaceRegistrationSchemaVersion {
  if (value !== WORKSPACE_REGISTRATION_SCHEMA_VERSION) {
    throw new TypeError('workspace-registration-schema-version-unsupported');
  }
  return value;
}

export function parseRegistrationKey(value: unknown): string {
  if (typeof value !== 'string' || !REGISTRATION_KEY_PATTERN.test(value)) {
    throw new TypeError('workspace-registration-key-invalid');
  }
  return value;
}

export function parseWorkspaceDisplayName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_DISPLAY_NAME_LENGTH ||
    value.trim() !== value ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    throw new TypeError('workspace-display-name-invalid');
  }
  return value;
}

export function parseRegistrationRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError('workspace-registration-revision-invalid');
  }
  return value as number;
}

export function parseMountGeneration(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError('workspace-mount-generation-invalid');
  }
  return value as number;
}

export function parseDeclaredRootHash(value: unknown): string {
  if (typeof value !== 'string' || !DECLARED_ROOT_HASH_PATTERN.test(value)) {
    throw new TypeError('workspace-declared-root-hash-invalid');
  }
  return value;
}

export function parseWorkspaceOperation(value: unknown): WorkspaceOperation {
  if (typeof value !== 'string' || !(WORKSPACE_OPERATIONS as readonly string[]).includes(value)) {
    throw new TypeError('workspace-operation-unsupported');
  }
  return value as WorkspaceOperation;
}

export function parseAllowedWorkspaceOperations(value: unknown): readonly WorkspaceOperation[] {
  if (!Array.isArray(value)) {
    throw new TypeError('workspace-allowed-operations-invalid');
  }
  if (value.length > MAX_WORKSPACE_ALLOWED_OPERATIONS) {
    throw new TypeError('workspace-allowed-operations-limit-exceeded');
  }

  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new TypeError('workspace-allowed-operations-sparse');
    }
  }

  const operations: WorkspaceOperation[] = [];
  const seen = new Set<WorkspaceOperation>();
  for (const item of value) {
    const operation = parseWorkspaceOperation(item);
    if (seen.has(operation)) {
      throw new TypeError('workspace-allowed-operation-duplicate');
    }
    seen.add(operation);
    operations.push(operation);
  }
  return Object.freeze(operations);
}

export function parseWorkspaceRegistrationValue(value: unknown): WorkspaceRegistrationValue {
  if (!isRecord(value)) {
    throw new TypeError('workspace-registration-invalid');
  }

  if (typeof value.enabled !== 'boolean') {
    throw new TypeError('workspace-registration-enabled-invalid');
  }

  return Object.freeze({
    schemaVersion: parseWorkspaceRegistrationSchemaVersion(value.schemaVersion),
    registrationKey: parseRegistrationKey(value.registrationKey),
    workspaceId: parseWorkspaceId(value.workspaceId),
    displayName: parseWorkspaceDisplayName(value.displayName),
    registrationRevision: parseRegistrationRevision(value.registrationRevision),
    declaredRootHash: parseDeclaredRootHash(value.declaredRootHash),
    enabled: value.enabled,
  });
}

export function parseWorkspaceMountBindingRef(value: unknown): WorkspaceMountBindingRef {
  if (!isRecord(value)) {
    throw new TypeError('workspace-mount-binding-ref-invalid');
  }

  return Object.freeze({
    workspaceId: parseWorkspaceId(value.workspaceId),
    bootId: parseBootId(value.bootId),
    mountGeneration: parseMountGeneration(value.mountGeneration),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
