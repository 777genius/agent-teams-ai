import { type OpenCodeLaunchTeamCommandBody, stableHash } from './OpenCodeBridgeCommandContract';
import {
  decodeOpenCodeLaunchAttemptResponseV1,
  type OpenCodeLaunchAttemptResponse,
} from './OpenCodeLaunchAttemptContractV1';

import type { OpenCodeBridgeCommandLedgerEntry } from './OpenCodeBridgeCommandLedgerStore';

const CONTINUATION_KEY_MARKER = ':continuation-generation:';

export interface OpenCodeStrictLaunchLedgerResolution {
  ledgerIdempotencyKey: string;
  existingEntry: OpenCodeBridgeCommandLedgerEntry | null;
}

export interface OpenCodeStrictLaunchLedgerDiscovery {
  generationKey: string;
  generationEntry: OpenCodeBridgeCommandLedgerEntry | undefined;
  legacyEntry: OpenCodeBridgeCommandLedgerEntry | undefined;
  predecessorEntry: OpenCodeBridgeCommandLedgerEntry | undefined;
}

/**
 * Finds exact generation identities without decoding any persisted response.
 * Callers can therefore publish durable side-effect ownership before corrupt
 * replay evidence reaches the fallible validation path.
 */
export function discoverOpenCodeStrictLaunchLedgerIdentity(input: {
  body: OpenCodeLaunchTeamCommandBody;
  entries: readonly OpenCodeBridgeCommandLedgerEntry[];
}): OpenCodeStrictLaunchLedgerDiscovery {
  const attempt = input.body.launchAttempt;
  const generationKey = createOpenCodeStrictLaunchLedgerKey(attempt.attemptId, attempt.generation);
  const generationEntry = input.entries.find((entry) => entry.idempotencyKey === generationKey);
  const legacyEntry = input.entries.find((entry) => entry.idempotencyKey === attempt.attemptId);
  const predecessorEntry =
    attempt.generation > 1
      ? (input.entries.find(
          (entry) =>
            entry.idempotencyKey ===
            createOpenCodeStrictLaunchLedgerKey(attempt.attemptId, attempt.generation - 1)
        ) ?? (attempt.generation === 2 ? legacyEntry : undefined))
      : undefined;
  return { generationKey, generationEntry, legacyEntry, predecessorEntry };
}

export function hasRecoverableOpenCodeStrictLaunchSideEffects(
  entry: OpenCodeBridgeCommandLedgerEntry | undefined
): boolean {
  return (
    entry?.status === 'completed' ||
    (entry?.status === 'started' && entry.strictLaunchResponseJson != null)
  );
}

/**
 * Resolves Desktop's durable command identity without changing the Orchestrator
 * wire idempotency contract. Generation one retains the legacy attemptId key;
 * continuations receive a generation-qualified local key.
 */
export function resolveOpenCodeStrictLaunchLedgerIdentity(input: {
  body: OpenCodeLaunchTeamCommandBody;
  requestHash: string;
  entries: readonly OpenCodeBridgeCommandLedgerEntry[];
  discovery?: OpenCodeStrictLaunchLedgerDiscovery;
}): OpenCodeStrictLaunchLedgerResolution {
  const attempt = input.body.launchAttempt;
  const discovery =
    input.discovery ??
    discoverOpenCodeStrictLaunchLedgerIdentity({ body: input.body, entries: input.entries });
  assertRequestGenerationShape(attempt.generation, attempt.continuationToken);
  const { generationKey, generationEntry, legacyEntry } = discovery;
  if (generationEntry) {
    return { ledgerIdempotencyKey: generationKey, existingEntry: generationEntry };
  }

  // Before generation-qualified keys existed, every strict launch used the
  // attemptId. Preserve exact durable replays, but never reinterpret a
  // different legacy payload as the current generation.
  if (legacyEntry?.requestHash === input.requestHash) {
    return { ledgerIdempotencyKey: attempt.attemptId, existingEntry: legacyEntry };
  }

  if (attempt.generation === 1) {
    if (legacyEntry || findKnownGenerations(input.entries, attempt.attemptId).length > 0) {
      throw new Error('OpenCode strict launch generation is stale or forked');
    }
    return { ledgerIdempotencyKey: generationKey, existingEntry: null };
  }

  assertMonotonicContinuation({
    body: input.body,
    entries: input.entries,
    predecessor: discovery.predecessorEntry,
  });
  return { ledgerIdempotencyKey: generationKey, existingEntry: null };
}

export function createOpenCodeStrictLaunchLedgerKey(attemptId: string, generation: number): string {
  return generation === 1 ? attemptId : `${attemptId}${CONTINUATION_KEY_MARKER}${generation}`;
}

function assertRequestGenerationShape(
  generation: number,
  continuationToken: string | undefined
): void {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('OpenCode strict launch generation must be a positive integer');
  }
  if (generation === 1 && continuationToken !== undefined) {
    throw new Error('OpenCode strict launch generation 1 cannot carry continuation evidence');
  }
  if (generation > 1 && !isNonEmptyString(continuationToken)) {
    throw new Error('OpenCode strict launch continuation requires durable evidence');
  }
}

function assertMonotonicContinuation(input: {
  body: OpenCodeLaunchTeamCommandBody;
  entries: readonly OpenCodeBridgeCommandLedgerEntry[];
  predecessor: OpenCodeBridgeCommandLedgerEntry | undefined;
}): void {
  const attempt = input.body.launchAttempt;
  const knownGenerations = findKnownGenerations(input.entries, attempt.attemptId);
  const latestGeneration = knownGenerations.length > 0 ? Math.max(...knownGenerations) : 0;
  if (latestGeneration !== attempt.generation - 1) {
    throw new Error('OpenCode strict launch continuation cannot skip or fork generations');
  }

  const evidence = decodeCompletedContinuationEvidence(input.predecessor);
  if (
    evidence.launchAttempt.attemptId !== attempt.attemptId ||
    evidence.launchAttempt.payloadHash !== attempt.payloadHash ||
    evidence.launchAttempt.generation !== attempt.generation - 1 ||
    evidence.launchAttempt.providerId !== attempt.providerId ||
    evidence.launchAttempt.modelId !== attempt.modelId ||
    evidence.launchAttempt.outcome !== 'partial' ||
    evidence.members.continuationToken !== attempt.continuationToken
  ) {
    throw new Error('OpenCode strict launch continuation evidence does not match its predecessor');
  }
}

function findKnownGenerations(
  entries: readonly OpenCodeBridgeCommandLedgerEntry[],
  attemptId: string
): number[] {
  const generations: number[] = [];
  for (const entry of entries) {
    const keyGeneration = parseGenerationKey(entry.idempotencyKey, attemptId);
    if (keyGeneration !== null) {
      generations.push(keyGeneration);
      continue;
    }
    if (entry.idempotencyKey === attemptId) {
      generations.push(readPersistedGeneration(entry) ?? 1);
    }
  }
  return generations;
}

function parseGenerationKey(key: string, attemptId: string): number | null {
  const prefix = `${attemptId}${CONTINUATION_KEY_MARKER}`;
  if (!key.startsWith(prefix)) return null;
  const generation = Number(key.slice(prefix.length));
  return Number.isSafeInteger(generation) && generation > 1 ? generation : null;
}

function readPersistedGeneration(entry: OpenCodeBridgeCommandLedgerEntry): number | null {
  const response = decodePersistedResponse(entry);
  return response?.launchAttempt.generation ?? null;
}

function decodeCompletedContinuationEvidence(
  entry: OpenCodeBridgeCommandLedgerEntry | undefined
): OpenCodeLaunchAttemptResponse {
  if (!entry || entry.status !== 'completed') {
    throw new Error('OpenCode strict launch predecessor must be durably completed');
  }
  const response = decodePersistedResponse(entry);
  if (!response) {
    throw new Error('OpenCode strict launch predecessor evidence is missing or corrupt');
  }
  if (
    !entry.requestCorrelationDigest ||
    response.launchAttempt.requestCorrelationDigest !== entry.requestCorrelationDigest
  ) {
    throw new Error('OpenCode strict launch predecessor lacks request correlation evidence');
  }
  return response;
}

function decodePersistedResponse(
  entry: Pick<OpenCodeBridgeCommandLedgerEntry, 'strictLaunchResponseJson' | 'responseHash'>
): OpenCodeLaunchAttemptResponse | null {
  if (!entry.strictLaunchResponseJson || !entry.responseHash) return null;
  try {
    const stored: unknown = JSON.parse(entry.strictLaunchResponseJson);
    if (stableHash(stored) !== entry.responseHash) return null;
    const decoded = decodeOpenCodeLaunchAttemptResponseV1(stored);
    return decoded.ok ? decoded.value : null;
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
