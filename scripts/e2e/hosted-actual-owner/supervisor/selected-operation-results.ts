/** DATA ONLY. Matching never grants dispatch, lease, effect or WAL authority.
 * The later permit consumer must install a trusted retained-result adapter; no
 * namespace callback, plain-result echo, or default authority provider exists. */
import { parseHostedTeamApprovalPage, parseHostedTeamApprovalPageRequest,
  parseHostedTeamApprovalPreviewRequest, type HostedTeamApprovalPreviewRequest } from '../../../../src/features/team-approvals/contracts';
import { deriveRuntimePermissionApprovalIdentity } from '../../../../src/features/team-runtime-control/contracts';
import { canonicalJson, exactRecord, sha256 } from './canonical';
import { allocationId, requireAllocation, type NativeAllocationSelection,
  type NativeOperationAllocation } from './selected-operation-allocation';

export type DependentPreviewBody = Readonly<{
  schemaVersion: 1; teamId: string; expectedRunId: string;
  resultBinding: Readonly<{ kind: 'approval-page-item'; operationId: string;
    subjectOperationId: string; field: 'pending-preview' }>;
}>;
export function decodeDependentPreviewBody(value: unknown): DependentPreviewBody {
  const b = exactRecord(value, ['schemaVersion', 'teamId', 'expectedRunId', 'resultBinding'], 'dependent_preview');
  const r = exactRecord(b.resultBinding, ['kind', 'operationId', 'subjectOperationId', 'field'], 'preview_result_binding');
  requireAllocation(r.kind === 'approval-page-item' && r.field === 'pending-preview');
  allocationId(r.operationId); allocationId(r.subjectOperationId);
  requireAllocation(parseHostedTeamApprovalPageRequest({ schemaVersion: b.schemaVersion,
    teamId: b.teamId, expectedRunId: b.expectedRunId, cursor: null, limit: 1 }).ok);
  return b as DependentPreviewBody;
}
export function validatePreviewDependencies(entry: NativeOperationAllocation,
  preceding: ReadonlyMap<string, NativeOperationAllocation>): void {
  const body = entry.operation.body;
  if (!body || !('resultBinding' in body)) return;
  const r = body.resultBinding, page = preceding.get(r.operationId), subject = preceding.get(r.subjectOperationId);
  requireAllocation(page && subject && entry.dependencies.includes(page.id) && entry.dependencies.includes(subject.id));
  requireAllocation(subject.operation.kind === 'pending-ingress' && subject.operation.binding.kind === 'exact' &&
    ['product-read', 'product-list'].includes(page.operation.kind) && page.dependencies.includes(subject.id));
  for (const source of [page, subject]) requireAllocation(source.generation === entry.generation &&
    source.slot === entry.slot && source.routeId === entry.routeId && source.routeDigest === entry.routeDigest &&
    source.maximumUses === 1 && source.operation.binding.sessionId === entry.operation.binding.sessionId &&
    source.operation.binding.requestId === entry.operation.binding.requestId);
  const binding = entry.operation.binding;
  requireAllocation(binding.kind === 'operation-result' && binding.operationId === page.id && binding.field === 'pending-item');
  requireAllocation(page.operation.body && page.operation.body.teamId === body.teamId &&
    page.operation.body.expectedRunId === body.expectedRunId);
}
/** One successful admitted operation, retained under its full immutable origin.
 * payload is either the committed ingress projection or the actual Product page.
 * sequence orders retained completions; stale/replaced records are not current. */
export type RetainedObservationData = Readonly<{
  allocationSha256: string; operationId: string; generation: number; slot: string;
  routeId: string; routeDigest: string; origin: string; sessionId: string; requestId: string;
  teamId: string; runId: string; sequence: number; current: boolean;
  kind: 'committed-pending' | 'product-page'; requestBody: unknown; payload: unknown;
}>;
/** Nominal integration origin, deliberately without a production constructor.
 * A later root-owned adapter must bind authenticated completions to admitted
 * operations and retain an immutable snapshot. This type alone is NOT proof or
 * a permit; subclasses in tests are explicitly synthetic data adapters. */
export abstract class RetainedProductObservationResults {
  protected abstract readonly retainedIntegrationOrigin: 'root-admitted-operation-results';
  abstract readonly allocation: NativeAllocationSelection;
  abstract readonly records: readonly RetainedObservationData[];
}
export function resolveDependentPreviewData(entry: NativeOperationAllocation,
  retained: RetainedProductObservationResults | undefined): HostedTeamApprovalPreviewRequest {
  requireAllocation(retained instanceof RetainedProductObservationResults);
  const allocation = retained.allocation;
  requireAllocation(Object.isFrozen(allocation) && allocation.entries.includes(entry));
  const body = entry.operation.body;
  requireAllocation(body && 'resultBinding' in body);
  const preceding = new Map(allocation.entries.slice(0, allocation.entries.indexOf(entry)).map(e => [e.id, e]));
  validatePreviewDependencies(entry, preceding);
  requireAllocation(Object.isFrozen(retained.records) && retained.records.length <= 256);
  const digest = sha256(canonicalJson(allocation));
  const get = (id: string, kind: RetainedObservationData['kind']) => {
    const source = preceding.get(id)!;
    const records = retained.records.filter(r => r.operationId === id);
    requireAllocation(records.length === 1);
    const r = records[0];
    requireAllocation(Object.isFrozen(r));
    exactRecord(r, ['allocationSha256', 'operationId', 'generation', 'slot', 'routeId', 'routeDigest',
      'origin', 'sessionId', 'requestId', 'teamId', 'runId', 'sequence', 'current', 'kind', 'requestBody', 'payload'], 'retained_observation');
    requireAllocation(r.kind === kind && r.current === true && Number.isSafeInteger(r.sequence) && r.sequence > 0 &&
      r.allocationSha256 === digest && r.generation === source.generation && r.slot === source.slot &&
      r.routeId === source.routeId && r.routeDigest === source.routeDigest && r.origin === source.origin &&
      r.sessionId === source.operation.binding.sessionId && r.requestId === source.operation.binding.requestId &&
      r.teamId === body.teamId && r.runId === body.expectedRunId &&
      canonicalJson(r.requestBody) === canonicalJson(source.operation.body));
    return r;
  };
  const pending = get(body.resultBinding.subjectOperationId, 'committed-pending');
  const observed = get(body.resultBinding.operationId, 'product-page');
  requireAllocation(pending.sequence < observed.sequence);
  const p = exactRecord(pending.payload, ['teamId', 'runId', 'requestId', 'effectRef', 'approvalId',
    'approvalGeneration', 'previewRef'], 'retained_pending_identity');
  requireAllocation(p.teamId === body.teamId && p.runId === body.expectedRunId && p.requestId === pending.requestId);
  const identity = deriveRuntimePermissionApprovalIdentity({ teamId: p.teamId, runId: p.runId,
    requestId: p.requestId, effectRef: p.effectRef });
  requireAllocation(p.approvalId === identity.approvalId && p.approvalGeneration === identity.approvalGeneration);
  const parsed = parseHostedTeamApprovalPage(observed.payload);
  requireAllocation(parsed.ok && parsed.value.teamId === body.teamId);
  const items = parsed.value.items.filter(i => i.approvalId === identity.approvalId);
  requireAllocation(items.length === 1);
  const item = items[0];
  requireAllocation(item.runId === identity.runId && item.generation === identity.approvalGeneration &&
    item.previewRef !== null && item.previewRef === p.previewRef);
  const preview = parseHostedTeamApprovalPreviewRequest({ schemaVersion: 1, teamId: body.teamId,
    expectedRunId: item.runId, approvalId: item.approvalId, expectedGeneration: item.generation, previewRef: item.previewRef });
  requireAllocation(preview.ok); return preview.value;
}
