import {
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
  type Revision,
  type TeamId,
  type WorkspaceId,
} from '@shared/contracts/hosted';

export interface HostedTeamConfigurationStorageDraft {
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly revision: Revision;
  readonly metadata: Readonly<{
    name: string;
    description?: string;
    color?: string;
    language?: string;
  }>;
  readonly members: readonly Readonly<{ name: string }>[];
}

export interface HostedTeamConfigurationStorageCreateRequest {
  readonly workspaceId: WorkspaceId;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly metadata: Readonly<{ name: string }>;
  readonly members: readonly Readonly<{ name: string }>[];
  readonly deadlineAtMs: number;
}

export type HostedTeamConfigurationStorageCreateResult =
  | Readonly<{
      kind: 'created';
      teamId: TeamId;
      revision: Revision;
      outcome: 'created' | 'idempotent_replay';
    }>
  | Readonly<{ kind: 'conflict'; reason: 'idempotency_mismatch' }>;

export type HostedTeamConfigurationStorageReadResult =
  | Readonly<{ kind: 'found'; draft: HostedTeamConfigurationStorageDraft }>
  | Readonly<{ kind: 'not_found' }>;

export interface HostedTeamConfigurationStorageUpdateRequest {
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly expectedRevision: Revision;
  readonly updates: Readonly<{
    name?: string;
    description?: string;
    color?: string;
    language?: string;
  }>;
  readonly deadlineAtMs: number;
}

export type HostedTeamConfigurationStorageUpdateResult =
  | Readonly<{ kind: 'updated'; draft: HostedTeamConfigurationStorageDraft }>
  | Readonly<{ kind: 'not_found' }>
  | Readonly<{ kind: 'conflict'; reason: 'revision_mismatch' }>;

export interface HostedTeamConfigurationStorageDeleteRequest {
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly expectedRevision: Revision;
  readonly deadlineAtMs: number;
}

export interface HostedTeamConfigurationStorageMutationOptions {
  readonly signal: AbortSignal;
}

export type HostedTeamConfigurationStorageDeleteResult =
  | Readonly<{ kind: 'deleted'; outcome: 'deleted' | 'already_absent' }>
  | Readonly<{ kind: 'conflict'; reason: 'revision_mismatch' }>;

export interface HostedTeamConfigurationStorageGateway {
  createHostedTeamConfiguration(
    request: HostedTeamConfigurationStorageCreateRequest,
    options: HostedTeamConfigurationStorageMutationOptions
  ): Promise<HostedTeamConfigurationStorageCreateResult>;
  readHostedTeamConfiguration(input: {
    readonly workspaceId: WorkspaceId;
    readonly teamId: TeamId;
  }): Promise<HostedTeamConfigurationStorageReadResult>;
  updateHostedTeamConfiguration(
    request: HostedTeamConfigurationStorageUpdateRequest,
    options: HostedTeamConfigurationStorageMutationOptions
  ): Promise<HostedTeamConfigurationStorageUpdateResult>;
  deleteHostedTeamConfiguration(
    request: HostedTeamConfigurationStorageDeleteRequest,
    options: HostedTeamConfigurationStorageMutationOptions
  ): Promise<HostedTeamConfigurationStorageDeleteResult>;
}

const HASH = /^[a-f0-9]{64}$/;
const KEY = /^idempotency_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const MEMBER = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const LIMITS = { name: 128, description: 4_000, color: 64, language: 64 } as const;

function deadlineAtMs(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError('hosted-team-configuration-storage-deadline-invalid');
  }
  return value as number;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('hosted-team-configuration-storage-shape-invalid');
  }
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const parsed = record(value);
  const actual = Reflect.ownKeys(parsed);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    throw new TypeError('hosted-team-configuration-storage-fields-invalid');
  }
  return parsed;
}

function text(value: unknown, limit: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > limit ||
    value.trim() !== value
  ) {
    throw new TypeError('hosted-team-configuration-storage-text-invalid');
  }
  return value;
}

function metadata(
  value: unknown,
  createOnly = false
): HostedTeamConfigurationStorageDraft['metadata'] {
  const input = record(value);
  const keys = Object.keys(input);
  if (
    keys.length < 1 ||
    keys.some((key) => !Object.hasOwn(LIMITS, key)) ||
    (createOnly && (keys.length !== 1 || keys[0] !== 'name'))
  ) {
    throw new TypeError('hosted-team-configuration-storage-metadata-invalid');
  }
  const output: Record<string, string> = {};
  for (const key of keys as (keyof typeof LIMITS)[]) output[key] = text(input[key], LIMITS[key]);
  return Object.freeze(output) as HostedTeamConfigurationStorageDraft['metadata'];
}

function members(value: unknown): HostedTeamConfigurationStorageDraft['members'] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new TypeError('hosted-team-configuration-storage-members-invalid');
  }
  const names = new Set<string>();
  const output = value.map((candidate) => {
    const name = text(exact(candidate, ['name']).name, 64);
    if (!MEMBER.test(name) || names.has(name)) {
      throw new TypeError('hosted-team-configuration-storage-member-invalid');
    }
    names.add(name);
    return Object.freeze({ name });
  });
  return Object.freeze(output);
}

export function parseHostedTeamConfigurationStorageCreateRequest(
  value: unknown
): HostedTeamConfigurationStorageCreateRequest {
  const input = exact(value, [
    'workspaceId',
    'idempotencyKey',
    'payloadHash',
    'metadata',
    'members',
    'deadlineAtMs',
  ]);
  if (
    typeof input.idempotencyKey !== 'string' ||
    !KEY.test(input.idempotencyKey) ||
    typeof input.payloadHash !== 'string' ||
    !HASH.test(input.payloadHash)
  ) {
    throw new TypeError('hosted-team-configuration-storage-create-invalid');
  }
  return Object.freeze({
    workspaceId: parseWorkspaceId(input.workspaceId),
    idempotencyKey: input.idempotencyKey,
    payloadHash: input.payloadHash,
    metadata: metadata(input.metadata, true) as Readonly<{ name: string }>,
    members: members(input.members),
    deadlineAtMs: deadlineAtMs(input.deadlineAtMs),
  });
}

export function parseHostedTeamConfigurationStorageIdentity(value: unknown): {
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
} {
  const input = exact(value, ['workspaceId', 'teamId']);
  return Object.freeze({
    workspaceId: parseWorkspaceId(input.workspaceId),
    teamId: parseTeamId(input.teamId),
  });
}

export function parseHostedTeamConfigurationStorageUpdateRequest(
  value: unknown
): HostedTeamConfigurationStorageUpdateRequest {
  const input = exact(value, [
    'workspaceId',
    'teamId',
    'expectedRevision',
    'updates',
    'deadlineAtMs',
  ]);
  return Object.freeze({
    ...parseHostedTeamConfigurationStorageIdentity({
      workspaceId: input.workspaceId,
      teamId: input.teamId,
    }),
    expectedRevision: parseRevision(input.expectedRevision),
    updates: metadata(input.updates),
    deadlineAtMs: deadlineAtMs(input.deadlineAtMs),
  });
}

export function parseHostedTeamConfigurationStorageDeleteRequest(
  value: unknown
): HostedTeamConfigurationStorageDeleteRequest {
  const input = exact(value, ['workspaceId', 'teamId', 'expectedRevision', 'deadlineAtMs']);
  return Object.freeze({
    ...parseHostedTeamConfigurationStorageIdentity({
      workspaceId: input.workspaceId,
      teamId: input.teamId,
    }),
    expectedRevision: parseRevision(input.expectedRevision),
    deadlineAtMs: deadlineAtMs(input.deadlineAtMs),
  });
}

export function parseHostedTeamConfigurationStorageDraft(
  value: unknown
): HostedTeamConfigurationStorageDraft {
  const input = exact(value, ['workspaceId', 'teamId', 'revision', 'metadata', 'members']);
  return Object.freeze({
    ...parseHostedTeamConfigurationStorageIdentity({
      workspaceId: input.workspaceId,
      teamId: input.teamId,
    }),
    revision: parseRevision(input.revision),
    metadata: metadata(input.metadata),
    members: members(input.members),
  });
}
