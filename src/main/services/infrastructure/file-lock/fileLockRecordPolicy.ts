const MAX_RECORD_BYTES = 256;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const FILE_LOCK_V3_LEGACY_TIMESTAMP = Number.MAX_SAFE_INTEGER;
export const FILE_LOCK_V3_BRAND = 'agent-teams-legacy-authoritative-v3';

export type FileLockRecordClassification =
  | { kind: 'v3'; pid: number; nonce: string }
  | { kind: 'legacy-or-unknown' };

export function buildFileLockV3Record(pid: number, nonce: string): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('File lock V3 record requires a positive safe process id');
  }
  if (!UUID_V4.test(nonce)) {
    throw new Error('File lock V3 record requires a lowercase UUID v4 nonce');
  }
  const record = `${pid}\n${FILE_LOCK_V3_LEGACY_TIMESTAMP}\n${FILE_LOCK_V3_BRAND}\n${nonce}\n`;
  if (Buffer.byteLength(record, 'utf8') > MAX_RECORD_BYTES) {
    throw new Error('File lock V3 record exceeds the bounded record budget');
  }
  return record;
}

/**
 * Classifies only bounded, canonical V3 records. V1, V2, malformed, oversized,
 * and future records deliberately share the same fail-closed result.
 */
export function classifyFileLockRecord(record: string): FileLockRecordClassification {
  if (Buffer.byteLength(record, 'utf8') > MAX_RECORD_BYTES) {
    return { kind: 'legacy-or-unknown' };
  }
  const lines = record.split('\n');
  if (
    lines.length !== 5 ||
    lines[4] !== '' ||
    !/^[1-9]\d*$/.test(lines[0]) ||
    lines[1] !== String(FILE_LOCK_V3_LEGACY_TIMESTAMP) ||
    lines[2] !== FILE_LOCK_V3_BRAND ||
    !UUID_V4.test(lines[3])
  ) {
    return { kind: 'legacy-or-unknown' };
  }
  const pid = Number(lines[0]);
  return Number.isSafeInteger(pid)
    ? { kind: 'v3', pid, nonce: lines[3] }
    : { kind: 'legacy-or-unknown' };
}
