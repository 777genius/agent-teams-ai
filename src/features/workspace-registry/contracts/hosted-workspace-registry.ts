import {
  type BootId,
  parseBootId,
  parseWorkspaceId,
  type WorkspaceId,
} from '@shared/contracts/hosted';

import {
  MAX_WORKSPACE_REGISTRATIONS,
  parseMountGeneration,
  parseRegistrationRevision,
  type WorkspaceMountHealth,
} from './workspace-registration';

export const HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION = 1 as const;
export const HOSTED_WORKSPACE_REGISTRY_ROUTES = Object.freeze({
  list: '/api/hosted/v1/workspaces/list',
  select: '/api/hosted/v1/workspaces/select',
} as const);

export const HOSTED_WORKSPACE_CAPABILITIES = Object.freeze([
  'git.status.read',
  'git.repository.initialize',
  'git.initial-commit.create',
  'git.branch.read',
  'git.branch-tracking.update',
] as const);

export type HostedWorkspaceCapability = (typeof HOSTED_WORKSPACE_CAPABILITIES)[number];

export interface HostedWorkspaceRegistryListRequest {
  readonly schemaVersion: typeof HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION;
}

export interface HostedWorkspaceRegistrySelectRequest extends HostedWorkspaceRegistryListRequest {
  readonly workspaceId: WorkspaceId;
}

export interface HostedWorkspaceMountDto {
  readonly bootId: BootId;
  readonly mountGeneration: number;
  readonly observedAt: number;
  readonly health: WorkspaceMountHealth;
  readonly capabilities: readonly HostedWorkspaceCapability[];
}

export interface HostedWorkspaceDto {
  readonly workspaceId: WorkspaceId;
  /** Host-generated opaque UI label. Never sourced from a path or registration metadata. */
  readonly label: string;
  readonly registrationRevision: number;
  readonly mount: HostedWorkspaceMountDto;
}

export interface HostedWorkspaceRegistryListResponse {
  readonly schemaVersion: typeof HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION;
  readonly kind: 'workspace-list';
  readonly workspaces: readonly HostedWorkspaceDto[];
}

export interface HostedWorkspaceRegistrySelectResponse {
  readonly schemaVersion: typeof HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION;
  readonly kind: 'workspace-selection';
  readonly workspace: HostedWorkspaceDto;
}

export type HostedWorkspaceRegistryErrorCode = 'invalid_request' | 'not_found' | 'unavailable';

export interface HostedWorkspaceRegistryErrorResponse {
  readonly schemaVersion: typeof HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION;
  readonly kind: 'error';
  readonly code: HostedWorkspaceRegistryErrorCode;
}

const LIST_REQUEST_KEYS = ['schemaVersion'] as const;
const SELECT_REQUEST_KEYS = ['schemaVersion', 'workspaceId'] as const;
const LIST_RESPONSE_KEYS = ['schemaVersion', 'kind', 'workspaces'] as const;
const SELECT_RESPONSE_KEYS = ['schemaVersion', 'kind', 'workspace'] as const;
const WORKSPACE_KEYS = ['workspaceId', 'label', 'registrationRevision', 'mount'] as const;
const MOUNT_KEYS = ['bootId', 'mountGeneration', 'observedAt', 'health', 'capabilities'] as const;
const CAPABILITY_SET = new Set<string>(HOSTED_WORKSPACE_CAPABILITIES);
const CAPABILITY_ORDER = new Map<string, number>(
  HOSTED_WORKSPACE_CAPABILITIES.map((capability, index) => [capability, index])
);
const HEALTH_SET = new Set<string>(['healthy', 'read-only', 'unavailable']);
const OPAQUE_LABEL_PATTERN = /^Workspace ([1-9][0-9]{0,2})$/;
const READ_ONLY_CAPABILITIES = new Set<HostedWorkspaceCapability>([
  'git.status.read',
  'git.branch.read',
]);

export function parseHostedWorkspaceRegistryListRequest(
  value: unknown
): HostedWorkspaceRegistryListRequest {
  const input = exactRecord(value, LIST_REQUEST_KEYS, 'hosted-workspace-list-request-invalid');
  assertSchemaVersion(input.schemaVersion);
  return Object.freeze({ schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION });
}

export function parseHostedWorkspaceRegistrySelectRequest(
  value: unknown
): HostedWorkspaceRegistrySelectRequest {
  const input = exactRecord(value, SELECT_REQUEST_KEYS, 'hosted-workspace-select-request-invalid');
  assertSchemaVersion(input.schemaVersion);
  return Object.freeze({
    schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
    workspaceId: parseWorkspaceId(input.workspaceId),
  });
}

export function parseHostedWorkspaceRegistryListResponse(
  value: unknown
): HostedWorkspaceRegistryListResponse {
  const input = exactRecord(value, LIST_RESPONSE_KEYS, 'hosted-workspace-list-response-invalid');
  assertSchemaVersion(input.schemaVersion);
  if (input.kind !== 'workspace-list') invalid('hosted-workspace-list-response-invalid');
  const workspaces = denseArray(
    input.workspaces,
    MAX_WORKSPACE_REGISTRATIONS,
    'hosted-workspace-list-response-invalid'
  ).map(parseHostedWorkspaceDto);
  return Object.freeze({
    schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
    kind: 'workspace-list',
    workspaces: Object.freeze(workspaces),
  });
}

export function parseHostedWorkspaceRegistrySelectResponse(
  value: unknown
): HostedWorkspaceRegistrySelectResponse {
  const input = exactRecord(
    value,
    SELECT_RESPONSE_KEYS,
    'hosted-workspace-select-response-invalid'
  );
  assertSchemaVersion(input.schemaVersion);
  if (input.kind !== 'workspace-selection') invalid('hosted-workspace-select-response-invalid');
  return Object.freeze({
    schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
    kind: 'workspace-selection',
    workspace: parseHostedWorkspaceDto(input.workspace),
  });
}

function parseHostedWorkspaceDto(value: unknown): HostedWorkspaceDto {
  const input = exactRecord(value, WORKSPACE_KEYS, 'hosted-workspace-dto-invalid');
  return Object.freeze({
    workspaceId: parseWorkspaceId(input.workspaceId),
    label: parseOpaqueWorkspaceLabel(input.label),
    registrationRevision: parseRegistrationRevision(input.registrationRevision),
    mount: parseHostedWorkspaceMountDto(input.mount),
  });
}

function parseHostedWorkspaceMountDto(value: unknown): HostedWorkspaceMountDto {
  const input = exactRecord(value, MOUNT_KEYS, 'hosted-workspace-mount-dto-invalid');
  if (!Number.isSafeInteger(input.observedAt) || (input.observedAt as number) < 0) {
    invalid('hosted-workspace-mount-dto-invalid');
  }
  if (typeof input.health !== 'string' || !HEALTH_SET.has(input.health)) {
    invalid('hosted-workspace-mount-dto-invalid');
  }
  const capabilities = denseArray(
    input.capabilities,
    HOSTED_WORKSPACE_CAPABILITIES.length,
    'hosted-workspace-mount-dto-invalid'
  ).map((capability) => {
    if (typeof capability !== 'string' || !CAPABILITY_SET.has(capability)) {
      return invalid('hosted-workspace-mount-dto-invalid');
    }
    return capability as HostedWorkspaceCapability;
  });
  if (new Set(capabilities).size !== capabilities.length) {
    invalid('hosted-workspace-mount-dto-invalid');
  }
  if (
    capabilities.some(
      (capability, index) =>
        index > 0 &&
        (CAPABILITY_ORDER.get(capabilities[index - 1] ?? '') ?? Number.MAX_SAFE_INTEGER) >=
          (CAPABILITY_ORDER.get(capability) ?? -1)
    ) ||
    (input.health === 'unavailable' && capabilities.length !== 0) ||
    (input.health === 'read-only' &&
      capabilities.some((capability) => !READ_ONLY_CAPABILITIES.has(capability)))
  ) {
    invalid('hosted-workspace-mount-dto-invalid');
  }
  return Object.freeze({
    bootId: parseBootId(input.bootId),
    mountGeneration: parseMountGeneration(input.mountGeneration),
    observedAt: input.observedAt as number,
    health: input.health as WorkspaceMountHealth,
    capabilities: Object.freeze(capabilities),
  });
}

function parseOpaqueWorkspaceLabel(value: unknown): string {
  if (typeof value !== 'string') {
    invalid('hosted-workspace-label-invalid');
  }
  const match = OPAQUE_LABEL_PATTERN.exec(value);
  if (!match || Number(match[1]) > MAX_WORKSPACE_REGISTRATIONS) {
    invalid('hosted-workspace-label-invalid');
  }
  return value;
}

function assertSchemaVersion(value: unknown): void {
  if (value !== HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION) {
    invalid('hosted-workspace-registry-schema-version-invalid');
  }
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  reason: string
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(reason);
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) invalid(reason);
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length ||
      keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
    ) {
      invalid(reason);
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) invalid(reason);
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return invalid(reason);
  }
}

function denseArray(value: unknown, limit: number, reason: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > limit) invalid(reason);
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) invalid(reason);
    result.push(value[index]);
  }
  return Object.freeze(result);
}

function invalid(reason: string): never {
  throw new TypeError(reason);
}
