import { createHash } from 'node:crypto';

import { stableHash } from './OpenCodeBridgeCommandContract';

import type { OpenCodeLaunchTeamCommandBody } from './OpenCodeBridgeCommandContract';
import type { OpenCodeBridgeCommandLedgerEntry } from './OpenCodeBridgeCommandLedgerStore';
import type { OpenCodeLaunchAttemptResponse } from './OpenCodeLaunchAttemptContractV1';

const STRICT_LAUNCH_MEMBER_LINKAGE_SCHEMA_VERSION = 1;

export interface StrictLaunchMemberLinkage {
  schemaVersion: typeof STRICT_LAUNCH_MEMBER_LINKAGE_SCHEMA_VERSION;
  members: Record<string, { sessionId: string }>;
}

export function collectValidatedStrictLaunchMemberLinkage(
  body: OpenCodeLaunchTeamCommandBody,
  response: OpenCodeLaunchAttemptResponse,
  data: unknown
): StrictLaunchMemberLinkage {
  const rawMembers = isRecord(data) && isRecord(data.members) ? data.members : {};
  const members: StrictLaunchMemberLinkage['members'] = {};
  for (const member of body.members) {
    const committed = response.members.committed.find(
      (candidate) => candidate.memberIdentity === member.memberIdentity
    );
    const rawMember = rawMembers[member.name];
    const sessionId = isRecord(rawMember) ? rawMember.sessionId : undefined;
    if (
      committed &&
      isNonEmptyString(sessionId) &&
      createOpenCodeSessionIdentity(sessionId) === committed.sessionIdentity
    ) {
      members[member.name] = { sessionId };
    }
  }
  return { schemaVersion: STRICT_LAUNCH_MEMBER_LINKAGE_SCHEMA_VERSION, members };
}

export function recoverStrictLaunchMemberLinkage(
  entry: OpenCodeBridgeCommandLedgerEntry,
  body: OpenCodeLaunchTeamCommandBody,
  response: OpenCodeLaunchAttemptResponse
): StrictLaunchMemberLinkage {
  if (!entry.strictLaunchMemberLinkageJson || !entry.strictLaunchMemberLinkageHash) {
    return emptyLinkage();
  }
  let stored: unknown;
  try {
    stored = JSON.parse(entry.strictLaunchMemberLinkageJson);
  } catch {
    return emptyLinkage();
  }
  if (
    stableHash(stored) !== entry.strictLaunchMemberLinkageHash ||
    !isRecord(stored) ||
    stored.schemaVersion !== STRICT_LAUNCH_MEMBER_LINKAGE_SCHEMA_VERSION ||
    !isRecord(stored.members)
  ) {
    return emptyLinkage();
  }
  const candidate = collectValidatedStrictLaunchMemberLinkage(body, response, {
    members: stored.members,
  });
  return Object.keys(candidate.members).length === Object.keys(stored.members).length
    ? candidate
    : emptyLinkage();
}

export function toReconciliationRequiredReplay(
  response: OpenCodeLaunchAttemptResponse
): OpenCodeLaunchAttemptResponse {
  return {
    ...response,
    launchAttempt: {
      ...response.launchAttempt,
      outcome: 'reconciliation_required',
      phase: 'cleanup',
    },
    failure: {
      code: 'unknown_transport_after_side_effect',
      origin: 'session',
      retryDisposition: 'never',
      retryable: false,
      phase: 'member_materialize',
      sideEffectsStarted: true,
    },
  };
}

function emptyLinkage(): StrictLaunchMemberLinkage {
  return { schemaVersion: STRICT_LAUNCH_MEMBER_LINKAGE_SCHEMA_VERSION, members: {} };
}

function createOpenCodeSessionIdentity(sessionId: string): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ kind: 'opencode-session', id: sessionId }))
    .digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
