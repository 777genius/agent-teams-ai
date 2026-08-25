import {
  HOSTED_SCHEMA_VERSION,
  parseRevision,
  parseTeamId,
  parseWorkspaceId,
  type Revision,
  type SafeAppError,
  type TeamId,
  type WorkspaceId,
} from '@shared/contracts/hosted';

export const HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION = HOSTED_SCHEMA_VERSION;

export const HOSTED_TEAM_CONFIGURATION_ROUTES = Object.freeze({
  getSavedRequest: '/api/hosted/v1/team-configuration/saved-request',
  createDraft: '/api/hosted/v1/team-configuration/draft/create',
  updateDraft: '/api/hosted/v1/team-configuration/draft/update',
  deleteDraft: '/api/hosted/v1/team-configuration/draft/delete',
} as const);

export interface HostedTeamConfigurationIdentity {
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
}

declare const hostedTeamConfigurationBrand: unique symbol;
export type HostedTeamConfigurationIdempotencyKey = string & {
  readonly [hostedTeamConfigurationBrand]: 'HostedTeamConfigurationIdempotencyKey';
};

export interface HostedTeamConfigurationMember {
  readonly name: string;
}

/** The bounded, provider-neutral draft fields which may cross the hosted boundary. */
export interface HostedTeamConfigurationDraftMetadata {
  readonly name: string;
  readonly description?: string;
  readonly color?: string;
  readonly language?: string;
}

export interface HostedSavedTeamRequest extends HostedTeamConfigurationIdentity {
  readonly revision: Revision;
  readonly metadata: HostedTeamConfigurationDraftMetadata;
  readonly members: readonly HostedTeamConfigurationMember[];
}

export interface HostedGetSavedTeamRequest extends HostedTeamConfigurationIdentity {
  readonly schemaVersion: typeof HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION;
}

export interface HostedCreateDraftTeamRequest {
  readonly schemaVersion: typeof HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION;
  readonly workspaceId: WorkspaceId;
  readonly idempotencyKey: HostedTeamConfigurationIdempotencyKey;
  readonly name: string;
  readonly members: readonly HostedTeamConfigurationMember[];
}

export interface HostedUpdateDraftTeamRequest extends HostedGetSavedTeamRequest {
  readonly expectedRevision: Revision;
  readonly updates: Readonly<{
    name?: string;
    description?: string;
    color?: string;
    language?: string;
  }>;
}

export interface HostedDeleteDraftTeamRequest extends HostedGetSavedTeamRequest {
  readonly expectedRevision: Revision;
}

export interface HostedTeamConfigurationErrorResult {
  readonly schemaVersion: typeof HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION;
  readonly kind: 'error';
  readonly error: SafeAppError;
  readonly retryable: boolean;
}

export type HostedGetSavedTeamResult =
  | Readonly<{
      schemaVersion: typeof HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION;
      kind: 'found';
      draft: HostedSavedTeamRequest;
    }>
  | HostedTeamConfigurationErrorResult;

export type HostedCreateDraftTeamResult =
  | Readonly<{
      schemaVersion: typeof HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION;
      kind: 'created';
      identity: HostedTeamConfigurationIdentity;
      revision: Revision;
      outcome: 'created' | 'idempotent_replay';
    }>
  | HostedTeamConfigurationErrorResult;

export type HostedUpdateDraftTeamResult =
  | Readonly<{
      schemaVersion: typeof HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION;
      kind: 'updated';
      draft: HostedSavedTeamRequest;
    }>
  | HostedTeamConfigurationErrorResult;

export type HostedDeleteDraftTeamResult =
  | Readonly<{
      schemaVersion: typeof HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION;
      kind: 'deleted';
      identity: HostedTeamConfigurationIdentity;
      outcome: 'deleted' | 'already_absent';
    }>
  | HostedTeamConfigurationErrorResult;

type ParseResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>;

const IDENTITY_KEYS = Object.freeze(['workspaceId', 'teamId'] as const);
const IDEMPOTENCY_KEY_PATTERN = /^idempotency_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const TEAM_NAME_LIMIT = 128;
const MEMBER_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const MAX_MEMBERS = 32;
const UPDATE_LIMITS = Object.freeze({
  name: TEAM_NAME_LIMIT,
  description: 4_000,
  color: 64,
  language: 64,
} as const);

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<PropertyKey, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function failure(): ParseResult<never> {
  return Object.freeze({ ok: false });
}

function parseName(value: unknown, limit = TEAM_NAME_LIMIT): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= limit ? normalized : null;
}

export function parseHostedTeamConfigurationIdempotencyKey(
  value: unknown
): HostedTeamConfigurationIdempotencyKey {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new TypeError('hosted-team-configuration-idempotency-key-invalid');
  }
  return value as HostedTeamConfigurationIdempotencyKey;
}

export function parseHostedTeamConfigurationIdentity(
  value: unknown
): ParseResult<HostedTeamConfigurationIdentity> {
  try {
    if (!isRecord(value) || !hasExactKeys(value, IDENTITY_KEYS)) return failure();
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        workspaceId: parseWorkspaceId(value.workspaceId),
        teamId: parseTeamId(value.teamId),
      }),
    });
  } catch {
    return failure();
  }
}

function parseIdentityRequest(
  value: unknown,
  keys: readonly string[] = ['schemaVersion', ...IDENTITY_KEYS]
): ParseResult<HostedGetSavedTeamRequest> {
  try {
    if (!isRecord(value) || !hasExactKeys(value, keys)) return failure();
    const identity = parseHostedTeamConfigurationIdentity({
      workspaceId: value.workspaceId,
      teamId: value.teamId,
    });
    if (!identity.ok || value.schemaVersion !== HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION) {
      return failure();
    }
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        ...identity.value,
      }),
    });
  } catch {
    return failure();
  }
}

function parseMembers(value: unknown): readonly HostedTeamConfigurationMember[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MEMBERS) return null;
  const names = new Set<string>();
  const members: HostedTeamConfigurationMember[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ['name'])) return null;
    const name = parseName(candidate.name, 64);
    if (name === null || !MEMBER_NAME_PATTERN.test(name) || names.has(name)) return null;
    names.add(name);
    members.push(Object.freeze({ name }));
  }
  return Object.freeze(members);
}

export function parseHostedGetSavedTeamRequest(
  value: unknown
): ParseResult<HostedGetSavedTeamRequest> {
  return parseIdentityRequest(value);
}

export function parseHostedDeleteDraftTeamRequest(
  value: unknown
): ParseResult<HostedDeleteDraftTeamRequest> {
  try {
    const base = parseIdentityRequest(value, [
      'schemaVersion',
      ...IDENTITY_KEYS,
      'expectedRevision',
    ]);
    return base.ok
      ? Object.freeze({
          ok: true,
          value: Object.freeze({
            ...base.value,
            expectedRevision: parseRevision((value as Record<string, unknown>).expectedRevision),
          }),
        })
      : failure();
  } catch {
    return failure();
  }
}

export function parseHostedCreateDraftTeamRequest(
  value: unknown
): ParseResult<HostedCreateDraftTeamRequest> {
  try {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['schemaVersion', 'workspaceId', 'idempotencyKey', 'name', 'members']) ||
      value.schemaVersion !== HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION
    ) {
      return failure();
    }
    const workspaceId = parseWorkspaceId(value.workspaceId);
    const name = parseName(value.name);
    const members = parseMembers(value.members);
    if (name === null || members === null) return failure();
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        workspaceId,
        idempotencyKey: parseHostedTeamConfigurationIdempotencyKey(value.idempotencyKey),
        name,
        members,
      }),
    });
  } catch {
    return failure();
  }
}

export function parseHostedUpdateDraftTeamRequest(
  value: unknown
): ParseResult<HostedUpdateDraftTeamRequest> {
  try {
    const base = parseIdentityRequest(value, [
      'schemaVersion',
      ...IDENTITY_KEYS,
      'expectedRevision',
      'updates',
    ]);
    if (!base.ok || !isRecord(value) || !isRecord(value.updates)) return failure();
    const updateKeys = Reflect.ownKeys(value.updates);
    if (
      updateKeys.length < 1 ||
      updateKeys.some((key) => typeof key !== 'string' || !Object.hasOwn(UPDATE_LIMITS, key))
    ) {
      return failure();
    }
    const updates: Record<string, string> = {};
    for (const key of updateKeys as (keyof typeof UPDATE_LIMITS)[]) {
      const normalized = parseName(value.updates[key], UPDATE_LIMITS[key]);
      if (normalized === null) return failure();
      updates[key] = normalized;
    }
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        ...base.value,
        expectedRevision: parseRevision(value.expectedRevision),
        updates: Object.freeze(updates),
      }),
    }) as ParseResult<HostedUpdateDraftTeamRequest>;
  } catch {
    return failure();
  }
}
