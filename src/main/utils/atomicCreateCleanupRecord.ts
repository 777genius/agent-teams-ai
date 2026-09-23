import {
  hasTrustworthyDurablePathIdentity,
  isSameDurablePathIdentity,
} from './durablePathIdentity';

import type { DurableFileIdentity, DurablePathIdentity } from './durablePathIdentity';

const ATOMIC_CREATE_TEMP_LINK_PATTERN = /^\.review-create\.[a-f0-9-]+\.tmp$/i;
const ATOMIC_CREATE_RETIRED_LINK_PATTERN = /^\.atomic-create-retired-[a-f0-9-]{36}$/i;

export interface AtomicCreateRecoveryRecord {
  version: 1;
  nonce: string;
  cleanupAuthority: string;
  directoryName: string;
  directoryIdentity: DurablePathIdentity;
  attachment: { name: string; identity: DurableFileIdentity };
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
}

export function isDurablePathIdentity(value: unknown): value is DurablePathIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as DurablePathIdentity;
  return (
    Number.isSafeInteger(identity.dev) &&
    Number.isSafeInteger(identity.ino) &&
    Number.isFinite(identity.birthtimeMs) &&
    hasTrustworthyDurablePathIdentity(identity)
  );
}

export function isDurableFileIdentity(value: unknown): value is DurableFileIdentity {
  return (
    isDurablePathIdentity(value) &&
    Number.isFinite((value as DurableFileIdentity).size) &&
    (value as DurableFileIdentity).size >= 0
  );
}

/** Parse only records whose capability and attachment remain in their own private directory. */
export function parseAtomicCreateRecoveryRecord(
  value: string,
  directoryName: string,
  allowRetiredDirectory = false
): AtomicCreateRecoveryRecord | null {
  try {
    const record = JSON.parse(value) as Partial<AtomicCreateRecoveryRecord>;
    if (
      record.version !== 1 ||
      !isUuid(record.nonce) ||
      !isUuid(record.cleanupAuthority) ||
      typeof record.directoryName !== 'string' ||
      (record.directoryName !== directoryName && !allowRetiredDirectory) ||
      !record.directoryName.includes(record.nonce) ||
      !record.directoryName.includes(record.cleanupAuthority) ||
      !isDurablePathIdentity(record.directoryIdentity) ||
      !record.attachment ||
      !(
        ATOMIC_CREATE_TEMP_LINK_PATTERN.test(record.attachment.name ?? '') ||
        ATOMIC_CREATE_RETIRED_LINK_PATTERN.test(record.attachment.name ?? '')
      ) ||
      !isDurableFileIdentity(record.attachment.identity)
    )
      return null;
    return record as AtomicCreateRecoveryRecord;
  } catch {
    return null;
  }
}

/** A retired directory is removable only when its own durable journal agrees. */
export function parseAtomicCreateDirectoryRetirementJournal(
  value: string,
  directoryIdentity: DurablePathIdentity
): boolean {
  try {
    const journal = JSON.parse(value) as { version?: unknown; directoryIdentity?: unknown };
    return (
      journal.version === 1 &&
      isDurablePathIdentity(journal.directoryIdentity) &&
      isSameDurablePathIdentity(journal.directoryIdentity, directoryIdentity) &&
      journal.directoryIdentity.birthtimeMs === directoryIdentity.birthtimeMs
    );
  } catch {
    return false;
  }
}
