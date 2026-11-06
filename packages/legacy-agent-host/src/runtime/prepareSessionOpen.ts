import type { OpenConfig } from '@agent-teams/provider-session-contracts';
import { RuntimeOwnerError } from './contracts.js';
import { runtimeDigest } from './identity.js';
import { assertGenerationAvailable } from './sessionState.js';
import type { RuntimeBinding, RuntimeSessionRecord, RuntimeTransaction } from './contracts.js';

/** Runs inside the Runtime fence after current admission authority. Keeps old uncertain history intact. */
export function prepareSessionOpen(options: {
  tx: RuntimeTransaction;
  binding: RuntimeBinding;
  config: OpenConfig;
  fingerprint: string;
  hostIncarnation: string;
  empty(): RuntimeSessionRecord;
  freshSource?: RuntimeBinding;
  hasInFlight(binding: RuntimeBinding): boolean;
}): { record: RuntimeSessionRecord; allocate: boolean } {
  const { tx, binding, config, fingerprint, freshSource } = options;
  if (freshSource) {
    const siblings = tx.siblings(),
      source = siblings.find((s) => runtimeDigest(s.binding) === runtimeDigest(freshSource));
    if (
      !source ||
      source.phase !== 'closed' ||
      source.custody !== 'released' ||
      !source.sealed ||
      siblings.some(
        (s) => runtimeDigest(s.binding) !== runtimeDigest(binding) && options.hasInFlight(s.binding)
      )
    )
      throw new RuntimeOwnerError('hold');
  }
  const prior = tx.get();
  if (prior?.openFingerprint) {
    if (prior.openFingerprint !== fingerprint) throw new RuntimeOwnerError('conflict');
    return { record: prior, allocate: false };
  }
  if (prior?.sealed) throw new RuntimeOwnerError('hold');
  assertGenerationAvailable(tx, binding, config, !!freshSource);
  const record = prior ?? options.empty();
  record.hostIncarnation = options.hostIncarnation;
  record.config = config;
  record.openFingerprint = fingerprint;
  record.phase = 'opening';
  record.custody = 'unknown';
  tx.put(record, 'growth'); // Opening intent precedes native allocation.
  return { record, allocate: true };
}
