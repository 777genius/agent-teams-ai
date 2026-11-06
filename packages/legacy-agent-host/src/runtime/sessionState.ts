import type { OpenConfig } from '@agent-teams/provider-session-contracts';
import { RuntimeOwnerError } from './contracts.js';
import { normalizeBinding, runtimeDigest } from './identity.js';
import type {
  RuntimeBinding,
  RuntimeInput,
  RuntimeSessionRecord,
  RuntimeTransaction,
} from './contracts.js';

export const activeInput = (input: RuntimeInput): boolean =>
  ['claimed', 'consumed', 'unknown'].includes(input.phase);

export function emptySession(
  binding: RuntimeBinding,
  profileId: string,
  hostIncarnation: string
): RuntimeSessionRecord {
  return {
    schemaVersion: 1,
    binding: normalizeBinding(binding),
    profileId,
    config: null,
    openFingerprint: null,
    hostIncarnation,
    phase: 'unopened',
    sealed: false,
    custody: 'released',
    nativeReady: false,
    inputs: [],
    interactions: [],
  };
}

export function normalizeOpenConfig(config: OpenConfig, allowCheckpoint = false): OpenConfig {
  if (!allowCheckpoint && config?.checkpointRef !== undefined) throw new RuntimeOwnerError('hold');
  if (
    !config ||
    [config.tenantId, config.projectId, config.sessionId, config.configRevision].some(
      (value) => typeof value !== 'string' || !value || value.length > 256
    ) ||
    !Number.isSafeInteger(config.generation) ||
    config.generation < 0 ||
    !Array.isArray(config.requiredCapabilities) ||
    config.requiredCapabilities.length > 64 ||
    config.requiredCapabilities.some(
      (value) => typeof value !== 'string' || !value || value.length > 128
    )
  )
    throw new RuntimeOwnerError('invalid');
  return {
    tenantId: config.tenantId,
    projectId: config.projectId,
    sessionId: config.sessionId,
    generation: config.generation,
    configRevision: config.configRevision,
    requiredCapabilities: [...config.requiredCapabilities].sort(),
    ...(config.checkpointRef ? { checkpointRef: config.checkpointRef } : {}),
  };
}

export function assertGenerationAvailable(
  tx: RuntimeTransaction,
  binding: RuntimeBinding,
  config: OpenConfig,
  explicitFresh = false
): void {
  for (const sibling of tx.siblings()) {
    if (
      sibling.config?.sessionId === config.sessionId &&
      config.generation <= sibling.config.generation
    )
      throw new RuntimeOwnerError('conflict');
    if (
      runtimeDigest(sibling.binding) !== runtimeDigest(binding) &&
      (sibling.phase !== 'closed' ||
        sibling.custody !== 'released' ||
        ((sibling.control || sibling.inputs.some(activeInput)) &&
          (!explicitFresh || !sibling.sealed)))
    )
      throw new RuntimeOwnerError('hold');
  }
}

/** Captured native history excludes queued/cancelled/rejected/known-not-sent inputs. */
export function historyDigest(record: RuntimeSessionRecord): string {
  return runtimeDigest({
    baseline: record.restoredFrom?.reference ?? null,
    operations: record.inputs
      .filter((input) => input.phase === 'terminal')
      .map((input) => ({
        inputId: input.intent.inputId,
        operationRef: input.operationRef,
        fingerprint: input.fingerprint,
        outcome: input.terminal,
      })),
  });
}

export function idle(record: RuntimeSessionRecord): boolean {
  return (
    !record.control &&
    !record.inputs.some(activeInput) &&
    !record.interactions.some((item) => item.phase === 'responding')
  );
}
