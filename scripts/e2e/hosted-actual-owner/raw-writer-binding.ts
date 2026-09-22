import { PRIVATE_HTTP_KIND } from './private-http-types';
import { canonicalJson, type RawOrigin } from './contracts';
import { HTTP_OBSERVATION_KIND, HTTP_OBSERVATION_KIND_V2 } from './raw-http-types';

import type { LocatedRawRecord } from './evidence';
import type { ProcessEvidenceRole, SupervisorOutcome } from './processes';

const LEGACY_WRITERS: Readonly<Record<RawOrigin, ProcessEvidenceRole>> = Object.freeze({
  browser: 'browser',
  'product-http': 'product',
  'product-sse': 'product',
  'owner-wal': 'owner',
  opencode: 'opencode',
  supervisor: 'supervisor',
});

/** The origin names the observed service; the discriminator determines the actual writer. */
export function assertRawRecordWriters(
  origin: RawOrigin,
  records: readonly LocatedRawRecord[],
  outcome: SupervisorOutcome
): void {
  const file = outcome.rawFiles[origin];
  const starts = origin === 'supervisor' ? [outcome.supervisorStart] : outcome.starts;
  function fail(): never {
    throw new Error('p3c_evidence_process_start_disagreement');
  }
  if (!Array.isArray(file.producerStartTokens) || !Array.isArray(file.producerPidfdInodes)) fail();
  const roles = new Set<ProcessEvidenceRole>();
  for (const record of records) {
    const start = starts.find(({ startToken }) => startToken === record.processStartToken);
    // Keep the r936 common membership check BEFORE either discriminator branch. Check pidfd
    // membership too; a matching process token cannot launder another ledger's writer list.
    if (
      !start ||
      !file.producerStartTokens.includes(start.startToken) ||
      !file.producerPidfdInodes.includes(start.pidfdInode) ||
      BigInt(record.monotonicNs) <= BigInt(start.observedMonotonicNs)
    )
      fail();
    if (record.kind === HTTP_OBSERVATION_KIND || record.kind === HTTP_OBSERVATION_KIND_V2 || record.kind === PRIVATE_HTTP_KIND) {
      roles.add('owner');
      if (
        origin !== 'opencode' ||
        start.role !== 'owner' ||
        record.http.context.activation.runId !== outcome.runId ||
        start.pid !== record.http.context.recorder.pid ||
        start.startTime !== record.http.context.recorder.startTicks ||
        start.generation !== record.http.context.recorder.ownerGeneration
      )
        fail();
    } else {
      roles.add(LEGACY_WRITERS[origin]);
      if (
        start.role !== LEGACY_WRITERS[origin] ||
        record.semanticIdentity.harnessRunId !== outcome.runId ||
        (origin === 'owner-wal' && start.generation !== record.ownerGeneration) ||
        (origin === 'supervisor' && record.processEvidenceSetId !== outcome.processEvidenceSetId)
      )
        fail();
    }
  }
  // FD8 may transfer serially between Owners, but cannot mix the legacy OpenCode writer and
  // the Owner HTTP recorder, even when a caller supplies both sets of tokens/pidfds.
  if (roles.size !== 1) fail();
  const writers = starts.filter(({ role }) => roles.has(role));
  if (
    canonicalJson(file.producerStartTokens) !==
      canonicalJson(writers.map(({ startToken }) => startToken).sort()) ||
    canonicalJson(file.producerPidfdInodes) !==
      canonicalJson(writers.map(({ pidfdInode }) => pidfdInode).sort())
  )
    fail();
}
