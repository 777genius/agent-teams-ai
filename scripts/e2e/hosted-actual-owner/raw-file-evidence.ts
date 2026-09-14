import {
  RAW_ORIGINS,
  canonicalJson,
  exactRecord,
  validateDecimal,
  validateRecordId,
  type RawOrigin,
} from './contracts';
import type { ProcessEvidenceRole, ProcessStartEvidence, RawFileEvidence } from './processes';

export function parseRawFiles(
  value: unknown,
  starts: readonly ProcessStartEvidence[],
  supervisorStart: ProcessStartEvidence
): Readonly<Record<RawOrigin, RawFileEvidence>> {
  const item = exactRecord(value, RAW_ORIGINS, 'supervisor_raw_files');
  const result = {} as Record<RawOrigin, RawFileEvidence>;
  for (const origin of RAW_ORIGINS) {
    const file = exactRecord(
      item[origin],
      [
        'path',
        'sha256',
        'size',
        'captureDevice',
        'captureInode',
        'producerStartTokens',
        'producerPidfdInodes',
        'parentCreatedExclusive',
        'writerDescriptorsClosed',
        'sealedBeforeParse',
      ],
      `supervisor_raw_${origin}`
    );
    const producerRoles: Record<RawOrigin, readonly ProcessEvidenceRole[]> = {
      browser: ['browser'],
      'product-http': ['product'],
      'product-sse': ['product'],
      'owner-wal': ['owner'],
      opencode: ['opencode'],
      supervisor: ['supervisor'],
    };
    const ownerTokens = starts
      .filter(({ role }) => role === 'owner')
      .map(({ startToken }) => startToken)
      .sort();
    if (
      origin === 'opencode' &&
      ownerTokens.length > 0 &&
      canonicalJson(file.producerStartTokens) === canonicalJson(ownerTokens)
    ) {
      producerRoles.opencode = ['owner'];
    }
    const producers =
      origin === 'supervisor'
        ? [supervisorStart]
        : starts.filter(({ role }) => producerRoles[origin].includes(role));
    const expectedStartTokens = producers.map(({ startToken }) => startToken).sort();
    const expectedPidfds = producers.map(({ pidfdInode }) => pidfdInode).sort();
    if (
      file.path !== `/sandbox/raw/${origin}.ndjson` ||
      !Number.isSafeInteger(file.size) ||
      (file.size as number) < 1 ||
      (file.size as number) > 64 * 1024 * 1024 ||
      canonicalJson(file.producerStartTokens) !== canonicalJson(expectedStartTokens) ||
      canonicalJson(file.producerPidfdInodes) !== canonicalJson(expectedPidfds) ||
      file.parentCreatedExclusive !== true ||
      file.writerDescriptorsClosed !== true ||
      file.sealedBeforeParse !== true
    )
      throw new Error('p3c_supervisor_raw_file');
    result[origin] = Object.freeze({
      path: file.path,
      sha256: validateRecordId(file.sha256, `supervisor_raw_${origin}_sha`),
      size: file.size as number,
      captureDevice: validateDecimal(file.captureDevice, `supervisor_raw_${origin}_device`),
      captureInode: validateDecimal(file.captureInode, `supervisor_raw_${origin}_inode`),
      producerStartTokens: Object.freeze(expectedStartTokens),
      producerPidfdInodes: Object.freeze(expectedPidfds),
      parentCreatedExclusive: true,
      writerDescriptorsClosed: true,
      sealedBeforeParse: true,
    });
  }
  return Object.freeze(result);
}
