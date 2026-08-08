import {
  type AppErrorCode,
  createSafeAppError,
  parseRevision,
  parseTeamId,
  type QueryContext,
  type SafeAppError,
} from '@shared/contracts/hosted';

import {
  HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
  type HostedCreateDraftTeamResult,
  type HostedDeleteDraftTeamResult,
  type HostedGetSavedTeamResult,
  type HostedSavedTeamRequest,
  type HostedTeamConfigurationDraftMetadata,
  type HostedTeamConfigurationIdentity,
  type HostedUpdateDraftTeamResult,
  parseHostedCreateDraftTeamRequest,
  parseHostedDeleteDraftTeamRequest,
  parseHostedGetSavedTeamRequest,
  parseHostedUpdateDraftTeamRequest,
} from '../../../../contracts/hosted';

import type {
  HostedTeamConfigurationApplicationPort,
  HostedTeamConfigurationAuthorizationPort,
  HostedTeamConfigurationAuthorizationScope,
  HostedTeamConfigurationOperation,
} from '../../../ports/HostedTeamConfigurationAuthorizationPort';

const METADATA_LIMITS = Object.freeze({
  name: 128,
  description: 4_000,
  color: 64,
  language: 64,
} as const);
const MEMBER_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

function errorResult(
  code: AppErrorCode,
  reason: string,
  retryable: boolean,
  retryAfterMs?: number
) {
  return Object.freeze({
    schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
    kind: 'error' as const,
    error: createSafeAppError({
      code,
      reason,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    }),
    retryable,
  });
}

function unavailable() {
  return errorResult('unavailable', 'team_configuration_unavailable', true);
}

const PUBLIC_APPLICATION_ERRORS = Object.freeze({
  not_found: Object.freeze({ reason: 'team_configuration_not_found', retryable: false }),
  conflict: Object.freeze({ reason: 'team_configuration_revision_conflict', retryable: false }),
  unavailable: Object.freeze({ reason: 'team_configuration_unavailable', retryable: true }),
  cancelled: Object.freeze({ reason: 'team_configuration_cancelled', retryable: false }),
} as const);

function applicationError(error: SafeAppError) {
  try {
    const safe = createSafeAppError(error);
    if (!Object.hasOwn(PUBLIC_APPLICATION_ERRORS, safe.code)) return unavailable();
    const mapping = PUBLIC_APPLICATION_ERRORS[safe.code as keyof typeof PUBLIC_APPLICATION_ERRORS];
    return errorResult(
      safe.code,
      mapping.reason,
      mapping.retryable,
      safe.code === 'unavailable' ? safe.retryAfterMs : undefined
    );
  } catch {
    return unavailable();
  }
}

function sameIdentity(
  left: HostedTeamConfigurationIdentity,
  right: HostedTeamConfigurationIdentity
): boolean {
  return left.workspaceId === right.workspaceId && left.teamId === right.teamId;
}

function sameScope(
  left: HostedTeamConfigurationAuthorizationScope,
  right: HostedTeamConfigurationAuthorizationScope
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'workspace' && right.kind === 'workspace'
    ? left.workspaceId === right.workspaceId
    : left.kind === 'team' && right.kind === 'team' && sameIdentity(left.identity, right.identity);
}

function normalizeMetadata(value: HostedTeamConfigurationDraftMetadata) {
  if (!value || typeof value !== 'object') return null;
  const result: Record<string, string> = {};
  for (const key of Object.keys(METADATA_LIMITS) as (keyof typeof METADATA_LIMITS)[]) {
    const raw = value[key];
    if (raw === undefined && key !== 'name') continue;
    if (typeof raw !== 'string') return null;
    const normalized = raw.trim();
    if (normalized.length < 1 || normalized.length > METADATA_LIMITS[key]) return null;
    result[key] = normalized;
  }
  return Object.freeze(result) as unknown as HostedTeamConfigurationDraftMetadata;
}

function projectDraft(
  identity: HostedTeamConfigurationIdentity,
  value: HostedSavedTeamRequest
): HostedSavedTeamRequest | null {
  if (
    !sameIdentity(identity, value) ||
    !Array.isArray(value.members) ||
    value.members.length < 1 ||
    value.members.length > 32
  ) {
    return null;
  }
  const metadata = normalizeMetadata(value.metadata);
  if (metadata === null) return null;
  let revision: ReturnType<typeof parseRevision>;
  try {
    revision = parseRevision(value.revision);
  } catch {
    return null;
  }
  const names = new Set<string>();
  const members: HostedSavedTeamRequest['members'][number][] = [];
  for (const member of value.members) {
    if (!member || typeof member.name !== 'string') return null;
    const name = member.name.trim();
    if (!MEMBER_NAME_PATTERN.test(name) || names.has(name)) return null;
    names.add(name);
    members.push(Object.freeze({ name }));
  }
  return Object.freeze({ ...identity, revision, metadata, members: Object.freeze(members) });
}

export interface HostedTeamConfigurationFacade {
  getSavedRequest(body: unknown, principal: QueryContext): Promise<HostedGetSavedTeamResult>;
  createDraft(body: unknown, principal: QueryContext): Promise<HostedCreateDraftTeamResult>;
  updateDraft(body: unknown, principal: QueryContext): Promise<HostedUpdateDraftTeamResult>;
  deleteDraft(body: unknown, principal: QueryContext): Promise<HostedDeleteDraftTeamResult>;
}

/** Hosted driving adapter; domain behavior and persistence stay behind the application port. */
export class HostedTeamConfigurationAdapter implements HostedTeamConfigurationFacade {
  constructor(
    private readonly application: HostedTeamConfigurationApplicationPort,
    private readonly authorization: HostedTeamConfigurationAuthorizationPort
  ) {}

  async getSavedRequest(body: unknown, principal: QueryContext): Promise<HostedGetSavedTeamResult> {
    const parsed = parseHostedGetSavedTeamRequest(body);
    if (!parsed.ok)
      return errorResult('invalid_request', 'team_configuration_request_invalid', false);
    const identity = Object.freeze({
      workspaceId: parsed.value.workspaceId,
      teamId: parsed.value.teamId,
    });
    if (!(await this.authorize('get_saved_request', { kind: 'team', identity }, principal))) {
      return errorResult('forbidden', 'team_configuration_forbidden', false);
    }
    try {
      const result = await this.application.getSavedRequest(identity, principal);
      if (result.kind === 'error') return applicationError(result.error);
      const draft = projectDraft(identity, result.draft);
      return draft === null
        ? unavailable()
        : Object.freeze({
            schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
            kind: 'found',
            draft,
          });
    } catch {
      return unavailable();
    }
  }

  async createDraft(body: unknown, principal: QueryContext): Promise<HostedCreateDraftTeamResult> {
    const parsed = parseHostedCreateDraftTeamRequest(body);
    if (!parsed.ok)
      return errorResult('invalid_request', 'team_configuration_request_invalid', false);
    const scope = Object.freeze({
      kind: 'workspace' as const,
      workspaceId: parsed.value.workspaceId,
    });
    if (!(await this.authorize('create_draft', scope, principal))) {
      return errorResult('forbidden', 'team_configuration_forbidden', false);
    }
    try {
      const result = await this.application.createDraft({
        workspaceId: parsed.value.workspaceId,
        idempotencyKey: parsed.value.idempotencyKey,
        name: parsed.value.name,
        members: parsed.value.members,
        context: principal,
      });
      if (result.kind === 'error') return applicationError(result.error);
      const identity = Object.freeze({
        workspaceId: parsed.value.workspaceId,
        teamId: parseTeamId(result.teamId),
      });
      return Object.freeze({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        kind: 'created',
        identity,
        revision: parseRevision(result.revision),
        outcome: result.outcome,
      });
    } catch {
      return unavailable();
    }
  }

  async updateDraft(body: unknown, principal: QueryContext): Promise<HostedUpdateDraftTeamResult> {
    const parsed = parseHostedUpdateDraftTeamRequest(body);
    if (!parsed.ok)
      return errorResult('invalid_request', 'team_configuration_request_invalid', false);
    const identity = Object.freeze({
      workspaceId: parsed.value.workspaceId,
      teamId: parsed.value.teamId,
    });
    if (!(await this.authorize('update_draft', { kind: 'team', identity }, principal))) {
      return errorResult('forbidden', 'team_configuration_forbidden', false);
    }
    try {
      const result = await this.application.updateDraft(
        identity,
        parsed.value.expectedRevision,
        parsed.value.updates,
        principal
      );
      if (result.kind === 'error') return applicationError(result.error);
      const draft = projectDraft(identity, result.draft);
      return draft === null
        ? unavailable()
        : Object.freeze({
            schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
            kind: 'updated',
            draft,
          });
    } catch {
      return unavailable();
    }
  }

  async deleteDraft(body: unknown, principal: QueryContext): Promise<HostedDeleteDraftTeamResult> {
    const parsed = parseHostedDeleteDraftTeamRequest(body);
    if (!parsed.ok)
      return errorResult('invalid_request', 'team_configuration_request_invalid', false);
    const identity = Object.freeze({
      workspaceId: parsed.value.workspaceId,
      teamId: parsed.value.teamId,
    });
    if (!(await this.authorize('delete_draft', { kind: 'team', identity }, principal))) {
      return errorResult('forbidden', 'team_configuration_forbidden', false);
    }
    try {
      const result = await this.application.deleteDraft(
        identity,
        parsed.value.expectedRevision,
        principal
      );
      if (result.kind === 'error') return applicationError(result.error);
      return Object.freeze({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        kind: 'deleted',
        identity,
        outcome: result.outcome,
      });
    } catch {
      return unavailable();
    }
  }

  private async authorize(
    operation: HostedTeamConfigurationOperation,
    scope: HostedTeamConfigurationAuthorizationScope,
    principal: QueryContext
  ): Promise<boolean> {
    try {
      const result = await this.authorization.authorize({ operation, scope, principal });
      return (
        result.kind === 'authorized' &&
        result.principalId === principal.actorId &&
        sameScope(result.scope, scope)
      );
    } catch {
      return false;
    }
  }
}
