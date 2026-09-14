import { readExactRecord } from './MutationReadinessScope';

export type RuntimeRootKind = 'claude' | 'app-data' | 'workspace' | 'temp' | 'logs';

export function snapshotRuntimeRoot<Kind extends RuntimeRootKind>(
  value: unknown,
  expectedKind: Kind
): Readonly<{ kind: Kind; reference: string }> | null {
  const record = readExactRecord(value, ['kind', 'reference']);
  const reference = record?.reference;
  return !(
    record?.kind !== expectedKind ||
    typeof reference !== 'string' ||
    reference.length === 0 ||
    reference.length > 4_096 ||
    reference.trim() !== reference ||
    // eslint-disable-next-line no-control-regex -- Runtime roots reject ASCII controls.
    /[\x00-\x1f\x7f]/.test(reference)
  )
    ? Object.freeze({ kind: expectedKind, reference })
    : null;
}

interface InspectionLike {
  readonly status: string;
  readonly evidence?: unknown;
}

export function sameExternalWriterEvidence(left: InspectionLike, right: InspectionLike): boolean {
  if (left.status !== 'verified' || right.status !== 'verified') return true;
  const leftRecord = readExactRecord(left.evidence, [
    'deploymentId',
    'bootId',
    'workspaceBinding',
    'classification',
    'coordination',
    'observation',
    'fileWriterEpoch',
    'observationWatermark',
  ]);
  const rightRecord = readExactRecord(right.evidence, [
    'deploymentId',
    'bootId',
    'workspaceBinding',
    'classification',
    'coordination',
    'observation',
    'fileWriterEpoch',
    'observationWatermark',
  ]);
  return (
    leftRecord?.fileWriterEpoch === rightRecord?.fileWriterEpoch &&
    leftRecord?.observationWatermark === rightRecord?.observationWatermark
  );
}
