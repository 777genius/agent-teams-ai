import { createSafeAppError, parseRevision, type Revision } from '@shared/contracts/hosted';

import {
  HOSTED_TEAM_CONFIGURATION_ROUTES,
  HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
  type HostedSavedTeamRequest,
  type HostedTeamConfigurationIdentity,
  parseHostedCreateDraftTeamRequest,
  parseHostedDeleteDraftTeamRequest,
  parseHostedGetSavedTeamRequest,
  parseHostedTeamConfigurationIdentity,
  parseHostedUpdateDraftTeamRequest,
} from '../../contracts/hosted';

import type {
  HostedTeamConfigurationHttpResponse,
  HostedTeamConfigurationTransport,
  HostedTeamConfigurationTransportDependencies,
  HostedTeamConfigurationTransportOptions,
} from '../ports/HostedTeamConfigurationRendererPorts';

const CSRF_TOKEN = /^[A-Za-z0-9_-]{32,512}$/;
const METADATA_LIMITS = Object.freeze({ name: 128, description: 4_000, color: 64, language: 64 });
const MEMBER_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;
const PUBLIC_ERROR_REASONS = Object.freeze({
  invalid_request: 'team_configuration_request_invalid',
  unauthenticated: 'team_configuration_unauthenticated',
  forbidden: 'team_configuration_forbidden',
  not_found: 'team_configuration_not_found',
  conflict: 'team_configuration_revision_conflict',
  unsupported: 'team_configuration_unsupported',
  unavailable: 'team_configuration_unavailable',
  cancelled: 'team_configuration_cancelled',
  internal: 'team_configuration_unavailable',
} as const);

function errorResult(code: 'invalid_request' | 'unavailable' | 'cancelled', reason: string) {
  return Object.freeze({
    schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
    kind: 'error' as const,
    error: createSafeAppError({ code, reason }),
    retryable: code === 'unavailable',
  });
}

function unavailable() {
  return errorResult('unavailable', 'team_configuration_unavailable');
}

function invalidRequest() {
  return errorResult('invalid_request', 'team_configuration_request_invalid');
}

function cancelled() {
  return errorResult('cancelled', 'team_configuration_cancelled');
}

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

function tryParseRevision(value: unknown): Revision | null {
  try {
    return parseRevision(value);
  } catch {
    return null;
  }
}

function parseIdentity(value: unknown, expected: HostedTeamConfigurationIdentity) {
  const parsed = parseHostedTeamConfigurationIdentity(value);
  return parsed.ok &&
    parsed.value.workspaceId === expected.workspaceId &&
    parsed.value.teamId === expected.teamId
    ? parsed.value
    : null;
}

function parseDraft(value: unknown, expected: HostedTeamConfigurationIdentity) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['workspaceId', 'teamId', 'revision', 'metadata', 'members']) ||
    parseIdentity({ workspaceId: value.workspaceId, teamId: value.teamId }, expected) === null ||
    !isRecord(value.metadata) ||
    !Array.isArray(value.members) ||
    value.members.length < 1 ||
    value.members.length > 32
  ) {
    return null;
  }
  const revision = tryParseRevision(value.revision);
  if (revision === null) return null;
  const metadataKeys = Reflect.ownKeys(value.metadata);
  if (
    !Object.hasOwn(value.metadata, 'name') ||
    metadataKeys.some((key) => typeof key !== 'string' || !Object.hasOwn(METADATA_LIMITS, key))
  ) {
    return null;
  }
  const metadata: Record<string, string> = {};
  for (const key of metadataKeys as (keyof typeof METADATA_LIMITS)[]) {
    const field = value.metadata[key];
    if (
      typeof field !== 'string' ||
      field.length < 1 ||
      field.length > METADATA_LIMITS[key] ||
      field !== field.trim()
    ) {
      return null;
    }
    metadata[key] = field;
  }
  const names = new Set<string>();
  const members: { readonly name: string }[] = [];
  for (const member of value.members) {
    if (
      !isRecord(member) ||
      !hasExactKeys(member, ['name']) ||
      typeof member.name !== 'string' ||
      !MEMBER_NAME_PATTERN.test(member.name) ||
      member.name !== member.name.trim() ||
      names.has(member.name)
    ) {
      return null;
    }
    names.add(member.name);
    members.push(Object.freeze({ name: member.name }));
  }
  return Object.freeze({
    ...expected,
    revision,
    metadata: Object.freeze(metadata),
    members: Object.freeze(members),
  }) as unknown as HostedSavedTeamRequest;
}

function parseError(value: unknown, status: number | undefined) {
  try {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['schemaVersion', 'kind', 'error', 'retryable']) ||
      value.schemaVersion !== HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION ||
      value.kind !== 'error' ||
      typeof value.retryable !== 'boolean'
    ) {
      return null;
    }
    const error = createSafeAppError(value.error);
    if (error.reason !== PUBLIC_ERROR_REASONS[error.code] || error.diagnosticId !== undefined) {
      return null;
    }
    const expectedStatus = {
      invalid_request: 400,
      unauthenticated: 401,
      forbidden: 403,
      not_found: 404,
      conflict: 409,
      unsupported: 422,
      unavailable: 503,
      cancelled: 503,
      internal: 500,
    }[error.code];
    if (status !== expectedStatus || value.retryable !== (error.code === 'unavailable'))
      return null;
    return Object.freeze({
      schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
      kind: 'error' as const,
      error,
      retryable: value.retryable,
    });
  } catch {
    return null;
  }
}

async function post(
  dependencies: HostedTeamConfigurationTransportDependencies,
  path: string,
  body: unknown,
  mutation: boolean,
  options: HostedTeamConfigurationTransportOptions | undefined
): Promise<HostedTeamConfigurationHttpResponse | null> {
  try {
    if (options?.signal?.aborted) return null;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (mutation) {
      const csrfToken = dependencies.getCsrfToken();
      if (typeof csrfToken !== 'string' || !CSRF_TOKEN.test(csrfToken)) return null;
      headers['x-agent-teams-csrf'] = csrfToken;
    }
    if (options?.signal?.aborted) return null;
    return await dependencies.fetch(path, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: Object.freeze(headers),
      body: JSON.stringify(body),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    return null;
  }
}

async function json(response: HostedTeamConfigurationHttpResponse | null): Promise<unknown> {
  if (response === null) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function createHostedTeamConfigurationTransport(
  dependencies: HostedTeamConfigurationTransportDependencies
): HostedTeamConfigurationTransport {
  const transport: HostedTeamConfigurationTransport = {
    async getSavedRequest(request, options) {
      const normalized = parseHostedGetSavedTeamRequest(request);
      if (!normalized.ok) return invalidRequest();
      if (options?.signal?.aborted) return cancelled();
      const identity = Object.freeze({
        workspaceId: normalized.value.workspaceId,
        teamId: normalized.value.teamId,
      });
      const response = await post(
        dependencies,
        HOSTED_TEAM_CONFIGURATION_ROUTES.getSavedRequest,
        normalized.value,
        false,
        options
      );
      if (options?.signal?.aborted) return cancelled();
      const value = await json(response);
      if (options?.signal?.aborted) return cancelled();
      if (
        response?.status === 200 &&
        isRecord(value) &&
        hasExactKeys(value, ['schemaVersion', 'kind', 'draft']) &&
        value.schemaVersion === HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION &&
        value.kind === 'found'
      ) {
        const draft = parseDraft(value.draft, identity);
        if (draft !== null) {
          return Object.freeze({
            schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
            kind: 'found',
            draft,
          });
        }
      }
      return parseError(value, response?.status) ?? unavailable();
    },

    async createDraft(request, options) {
      const normalized = parseHostedCreateDraftTeamRequest(request);
      if (!normalized.ok) return invalidRequest();
      if (options?.signal?.aborted) return cancelled();
      const response = await post(
        dependencies,
        HOSTED_TEAM_CONFIGURATION_ROUTES.createDraft,
        normalized.value,
        true,
        options
      );
      if (options?.signal?.aborted) return cancelled();
      const value = await json(response);
      if (options?.signal?.aborted) return cancelled();
      if (
        response?.status === 201 &&
        isRecord(value) &&
        hasExactKeys(value, ['schemaVersion', 'kind', 'identity', 'revision', 'outcome']) &&
        value.schemaVersion === HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION &&
        value.kind === 'created' &&
        (value.outcome === 'created' || value.outcome === 'idempotent_replay') &&
        isRecord(value.identity) &&
        value.identity.workspaceId === normalized.value.workspaceId
      ) {
        const identity = parseHostedTeamConfigurationIdentity(value.identity);
        const revision = tryParseRevision(value.revision);
        if (identity.ok && revision !== null) {
          return Object.freeze({
            schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
            kind: 'created',
            identity: identity.value,
            revision,
            outcome: value.outcome,
          });
        }
      }
      return parseError(value, response?.status) ?? unavailable();
    },

    async updateDraft(request, options) {
      const normalized = parseHostedUpdateDraftTeamRequest(request);
      if (!normalized.ok) return invalidRequest();
      if (options?.signal?.aborted) return cancelled();
      const identity = Object.freeze({
        workspaceId: normalized.value.workspaceId,
        teamId: normalized.value.teamId,
      });
      const response = await post(
        dependencies,
        HOSTED_TEAM_CONFIGURATION_ROUTES.updateDraft,
        normalized.value,
        true,
        options
      );
      if (options?.signal?.aborted) return cancelled();
      const value = await json(response);
      if (options?.signal?.aborted) return cancelled();
      if (
        response?.status === 200 &&
        isRecord(value) &&
        hasExactKeys(value, ['schemaVersion', 'kind', 'draft']) &&
        value.schemaVersion === HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION &&
        value.kind === 'updated'
      ) {
        const draft = parseDraft(value.draft, identity);
        if (draft !== null) {
          return Object.freeze({
            schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
            kind: 'updated',
            draft,
          });
        }
      }
      return parseError(value, response?.status) ?? unavailable();
    },

    async deleteDraft(request, options) {
      const normalized = parseHostedDeleteDraftTeamRequest(request);
      if (!normalized.ok) return invalidRequest();
      if (options?.signal?.aborted) return cancelled();
      const identity = Object.freeze({
        workspaceId: normalized.value.workspaceId,
        teamId: normalized.value.teamId,
      });
      const response = await post(
        dependencies,
        HOSTED_TEAM_CONFIGURATION_ROUTES.deleteDraft,
        normalized.value,
        true,
        options
      );
      if (options?.signal?.aborted) return cancelled();
      const value = await json(response);
      if (options?.signal?.aborted) return cancelled();
      if (
        response?.status === 200 &&
        isRecord(value) &&
        hasExactKeys(value, ['schemaVersion', 'kind', 'identity', 'outcome']) &&
        value.schemaVersion === HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION &&
        value.kind === 'deleted' &&
        (value.outcome === 'deleted' || value.outcome === 'already_absent') &&
        parseIdentity(value.identity, identity) !== null
      ) {
        return Object.freeze({
          schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
          kind: 'deleted',
          identity,
          outcome: value.outcome,
        });
      }
      return parseError(value, response?.status) ?? unavailable();
    },
  };
  return Object.freeze(transport);
}
