import { createHash } from 'crypto';
import * as path from 'path';

import type { TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import type {
  ProviderModelLaunchIdentity,
  TeamCreateRequest,
  TeamLaunchRequest,
} from '@shared/types';

export type LaunchContinuationRetryOutcome = 'failed' | 'missing';

export interface LaunchContinuationPreservedMember {
  name: string;
  runtimeRunId: string;
  bootstrapConfirmedAt: string;
}

export interface LaunchContinuationRetryMember {
  name: string;
  outcome: LaunchContinuationRetryOutcome;
  cleanupRunId: string;
  cleanupConfirmedAt: string;
}

export interface DeterministicLaunchContinuation {
  version: 1;
  sourceRunId: string;
  evidenceId: string;
  evidenceUpdatedAt: string;
  rosterFingerprint: `sha256:${string}`;
  preservedMembers: LaunchContinuationPreservedMember[];
  retryMembers: LaunchContinuationRetryMember[];
}

export type DeterministicLaunchContinuationDecision =
  | { kind: 'fresh'; rosterFingerprint: `sha256:${string}` }
  | {
      kind: 'continue';
      rosterFingerprint: `sha256:${string}`;
      continuation: DeterministicLaunchContinuation;
    }
  | {
      kind: 'complete';
      rosterFingerprint: `sha256:${string}`;
      sourceRunId: string;
    };

export interface DurableLaunchContinuationMemberEvidence {
  name: string;
  outcome: 'bootstrap_confirmed' | LaunchContinuationRetryOutcome;
  runtimeRunId?: string;
  observedAt: string;
  cleanup?: {
    status: 'confirmed';
    runId: string;
    observedAt: string;
  };
}

export interface DurableLaunchContinuationEvidence {
  version: 1;
  sourceRunId: string;
  teamName: string;
  evidenceId: string;
  updatedAt: string;
  rosterFingerprint: `sha256:${string}`;
  terminalStatus: 'partial_success' | 'completed';
  members: DurableLaunchContinuationMemberEvidence[];
}

export type DurableLaunchContinuationEvidenceRead =
  | { kind: 'absent' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'evidence'; evidence: DurableLaunchContinuationEvidence };

const VOLATILE_EVIDENCE_KEYS = new Set([
  'executionProof',
  'launchCommandId',
  'launchRequestFingerprint',
  'rosterTransactionId',
  'transactionId',
  'catalogFetchedAt',
]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, entry]) => entry !== undefined && !VOLATILE_EVIDENCE_KEYS.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => {
        if ((key === 'cwd' || key === 'projectPath') && typeof entry === 'string') {
          return [key, path.resolve(entry)];
        }
        return [key, canonicalize(entry)];
      })
  );
}

export interface LaunchContinuationCanonicalEvidenceInput {
  request: TeamLaunchRequest;
  materializedMemberSpecs: TeamCreateRequest['members'];
  launchIdentity: ProviderModelLaunchIdentity;
  runtimeLanePlan: TeamRuntimeLanePlan;
}

export function buildLaunchContinuationRosterFingerprint(
  input: LaunchContinuationCanonicalEvidenceInput
): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(serializeLaunchContinuationCanonicalEvidence(input))
    .digest('hex')}`;
}

function serializeLaunchContinuationCanonicalEvidence(
  input: LaunchContinuationCanonicalEvidenceInput
): string {
  const materializedMemberSpecs = [...input.materializedMemberSpecs].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  return JSON.stringify(
    canonicalize({
      schemaVersion: 2,
      request: {
        ...input.request,
        fastMode: input.request.fastMode ?? 'inherit',
        limitContext: input.request.limitContext ?? false,
        clearContext: input.request.clearContext ?? false,
        skipPermissions: input.request.skipPermissions ?? true,
      },
      materializedMemberSpecs,
      launchIdentity: input.launchIdentity,
      runtimeLanePlan: input.runtimeLanePlan,
    })
  );
}

function normalizedNames(names: readonly string[]): string[] {
  return names.map((name) => name.trim()).sort((left, right) => left.localeCompare(right));
}

function hasExactUniqueRoster(
  evidence: DurableLaunchContinuationEvidence,
  expectedMemberNames: readonly string[]
): boolean {
  const expected = normalizedNames(expectedMemberNames);
  const observed = normalizedNames(evidence.members.map((member) => member.name));
  return (
    expected.length === new Set(expected).size &&
    observed.length === new Set(observed).size &&
    expected.length === observed.length &&
    expected.every((name, index) => name === observed[index])
  );
}

export function resolveDeterministicLaunchContinuation(input: {
  teamName: string;
  expectedMemberNames: readonly string[];
  rosterFingerprint: `sha256:${string}`;
  evidenceRead: DurableLaunchContinuationEvidenceRead;
}): DeterministicLaunchContinuationDecision {
  if (input.evidenceRead.kind === 'absent') {
    return { kind: 'fresh', rosterFingerprint: input.rosterFingerprint };
  }
  if (input.evidenceRead.kind === 'invalid') {
    throw new Error(
      `Deterministic partial-launch continuation is unavailable: ${input.evidenceRead.reason}. ` +
        'Stop/reset the team before launching the full roster again.'
    );
  }

  const evidence = input.evidenceRead.evidence;
  if (evidence.teamName !== input.teamName) {
    throw new Error('Deterministic partial-launch continuation evidence belongs to another team');
  }
  if (evidence.rosterFingerprint !== input.rosterFingerprint) {
    throw new Error(
      'Deterministic partial-launch continuation evidence does not match the current launch ' +
        `configuration (${evidence.rosterFingerprint} != ${input.rosterFingerprint})`
    );
  }
  if (!hasExactUniqueRoster(evidence, input.expectedMemberNames)) {
    throw new Error(
      'Deterministic partial-launch continuation evidence does not contain the exact configured roster'
    );
  }

  const preservedMembers: LaunchContinuationPreservedMember[] = [];
  const retryMembers: LaunchContinuationRetryMember[] = [];
  for (const member of evidence.members) {
    if (member.outcome === 'bootstrap_confirmed') {
      if (!member.runtimeRunId) {
        throw new Error(
          `Deterministic partial-launch continuation lacks run-bound success evidence for ${member.name}`
        );
      }
      preservedMembers.push({
        name: member.name,
        runtimeRunId: member.runtimeRunId,
        bootstrapConfirmedAt: member.observedAt,
      });
      continue;
    }
    if (member.cleanup?.status !== 'confirmed' || member.cleanup.runId !== evidence.sourceRunId) {
      throw new Error(
        `Deterministic partial-launch continuation lacks cleanup proof for ${member.name}`
      );
    }
    retryMembers.push({
      name: member.name,
      outcome: member.outcome,
      cleanupRunId: member.cleanup.runId,
      cleanupConfirmedAt: member.cleanup.observedAt,
    });
  }

  if (evidence.terminalStatus === 'completed') {
    if (retryMembers.length > 0 || preservedMembers.length !== evidence.members.length) {
      throw new Error('Completed deterministic launch evidence contains an unresolved member');
    }
    return {
      kind: 'complete',
      rosterFingerprint: input.rosterFingerprint,
      sourceRunId: evidence.sourceRunId,
    };
  }
  if (preservedMembers.length === 0 || retryMembers.length === 0) {
    throw new Error('Partial deterministic launch evidence is not an exact partial outcome');
  }
  return {
    kind: 'continue',
    rosterFingerprint: input.rosterFingerprint,
    continuation: {
      version: 1,
      sourceRunId: evidence.sourceRunId,
      evidenceId: evidence.evidenceId,
      evidenceUpdatedAt: evidence.updatedAt,
      rosterFingerprint: evidence.rosterFingerprint,
      preservedMembers,
      retryMembers,
    },
  };
}
