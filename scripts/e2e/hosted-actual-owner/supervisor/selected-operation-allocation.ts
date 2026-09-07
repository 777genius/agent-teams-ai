import { HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS } from '../../../../src/features/team-approvals/main/hosted';
import { parseHostedTeamApprovalPageRequest, parseHostedTeamApprovalPreviewRequest,
  type HostedTeamApprovalPageRequest, type HostedTeamApprovalPreviewRequest } from '../../../../src/features/team-approvals/contracts';
import { decodeDependentPreviewBody, validatePreviewDependencies, resolveDependentPreviewData,
  type DependentPreviewBody, type RetainedProductObservationResults } from './selected-operation-results';
import type { MatrixRow } from '../contracts';
import { canonicalJson, exactRecord, sha256 } from './canonical';
import { ROOT_PROCESS_SCHEDULE } from './launch-schedule';

export const NATIVE_ALLOCATION = 'agent-teams.native-operation-allocation/v1' as const;
export const ALLOCATION_LIMITS = Object.freeze({ entries: 128, uses: 256, dependencies: 8, bytes: 64 * 1024 });
export type NativeGeneration = 1 | 2 | 3 | 4;
export type NativeSlot = 'A' | 'B';
export const NATIVE_ROWS = Object.freeze([
  '01_pending_before_http', '02_browser_allow_deny', '03_owner_effect_settlement',
  '04_auth_replay_rejections', '05_restart_generation_fences', '06_ambiguity_reconciliation',
  '07_socket_capability_admission', '08_cross_team_isolation', '09_forced_failure_shutdown',
  '10_normal_shutdown_cleanup',
] as const satisfies readonly MatrixRow[]);
export const OPERATION_ORIGINS = Object.freeze(['lifecycle-command', 'approval-observation', 'persisted-delivery',
  'explicit-reconciliation', 'selected-negative', 'private-preflight'] as const);
/** These are service operations, not success/effect assertions. Paths are fixed
 * templates; result bindings select one named request, never the first pending. */
export const OPERATION_RULES = immutableAllocation({
  capability: ['GET', '/experimental/agent-teams/hosted-approval-capability', 'approval-observation'],
  observe: ['GET', '/experimental/agent-teams/hosted-approval/session/:sessionId/permissions', 'approval-observation'],
  'conditional-reply': ['POST', '/experimental/agent-teams/hosted-approval/session/:sessionId/permission/:requestId/reply', 'persisted-delivery'],
  'retry-reply': ['POST', '/experimental/agent-teams/hosted-approval/session/:sessionId/permission/:requestId/reply', 'explicit-reconciliation'],
  'negative-reply': ['POST', '/experimental/agent-teams/hosted-approval/session/:sessionId/permission/:requestId/reply', 'selected-negative'],
  'pending-ingress': ['COMMAND', 'pending-ingress', 'lifecycle-command'],
  'hold-before-delivery': ['COMMAND', 'hold-before-delivery', 'persisted-delivery'],
  'reconcile-not-dispatched': ['COMMAND', 'reconcile-not-dispatched', 'explicit-reconciliation'],
  'reconcile-retained-result': ['COMMAND', 'reconcile-retained-result', 'explicit-reconciliation'],
  'reconcile-unknown': ['COMMAND', 'reconcile-unknown', 'explicit-reconciliation'],
  'product-read': [HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS[0].method, HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS[0].path, 'approval-observation'],
  'product-preview': [HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS[1].method, HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS[1].path, 'approval-observation'],
  'product-list': [HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS[0].method, HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS[0].path, 'approval-observation'],
  'product-events': ['GET', '/api/hosted/v1/events', 'approval-observation'],
  'browser-decision': [HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS[2].method, HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS[2].path, 'persisted-delivery'],
  'admission-negative': ['COMMAND', 'admission-negative', 'selected-negative'],
  'request-negative': ['COMMAND', 'request-negative', 'selected-negative'],
  'restart': ['COMMAND', 'restart', 'lifecycle-command'],
  'forced-failure': ['COMMAND', 'forced-failure', 'lifecycle-command'],
  'normal-shutdown': ['COMMAND', 'normal-shutdown', 'lifecycle-command'],
  'private-health': ['GET', '/global/health', 'private-preflight'],
  'private-config': ['GET', '/config', 'private-preflight'],
  'private-events': ['GET', '/event', 'private-preflight'],
} as const);
export type NativeRequestBinding = Readonly<{
  kind: 'exact'; sessionId: string; requestId: string;
}> | Readonly<{
  kind: 'operation-result'; operationId: string; sessionId: string; requestId: string;
  field: 'permission' | 'delivery' | 'pending-item' | 'retained-result';
}>;
export type ClosedOperationRule = Readonly<{
  kind: keyof typeof OPERATION_RULES;
  method: string;
  path: string;
  binding: NativeRequestBinding;
  body: HostedTeamApprovalPageRequest | HostedTeamApprovalPreviewRequest | DependentPreviewBody | null;
  decision: 'none' | 'allow_once' | 'reject';
  /** Exact negative case from the independently evaluated matrix obligation. */
  negativeCase: string | null;
}>;
export type NativeOperationAllocation = Readonly<{
  id: string; generation: NativeGeneration; slot: NativeSlot; row: MatrixRow;
  routeId: string; routeDigest: string;
  origin: (typeof OPERATION_ORIGINS)[number]; operation: ClosedOperationRule;
  maximumUses: number; dependencies: readonly string[];
}>;
export type NativeTeamSlotSelection = Readonly<{
  slot: NativeSlot; teamId: string; teamRoot: string; walLineage: string;
  routeId: string; routeDigest: string; activationEndpoint: string; lifecycleEndpoint: string;
}>;
export type NativeGenerationSelection = Readonly<{
  generation: NativeGeneration; ownerSessionId: string;
  admissionDocumentSha256: string; manifestSha256: string;
  slots: readonly NativeTeamSlotSelection[];
  supplemental: Readonly<{ contract: 'agent-teams.native-supplemental-resources/v1';
    operationChannelFd: 10; teamBActivationFd: 12 | null; trustDirectoryFd: 19 }>;
}>;
export type NativeAllocationSelection = Readonly<{
  contract: typeof NATIVE_ALLOCATION;
  starts: typeof ROOT_PROCESS_SCHEDULE;
  generations: readonly NativeGenerationSelection[];
  entries: readonly NativeOperationAllocation[];
  /** References are coverage requirements only; they grant no result/effect. */
  obligations: readonly Readonly<{ row: MatrixRow; operationIds: readonly string[]; requirements: readonly string[] }>[];
}>;
export function requireAllocation(value: unknown): asserts value {
  if (!value) throw new Error('native_operation_allocation_rejected');
}
export function allocationId(value: unknown): string {
  requireAllocation(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(value)); return value;
}
export function allocationDigest(value: unknown): string {
  requireAllocation(typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)); return value;
}
export function immutableAllocation<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(immutableAllocation); Object.freeze(value); }
  return value;
}
function array(value: unknown, maximum: number): unknown[] {
  requireAllocation(Array.isArray(value) && value.length > 0 && value.length <= maximum); return value;
}
function path(value: unknown): string {
  requireAllocation(typeof value === 'string' && value.length <= 512 && /^\/[A-Za-z0-9/_.-]+$/u.test(value) &&
    value.split('/').slice(1).every(p => p && p !== '.' && p !== '..')); return value;
}
function unique(values: readonly unknown[]): void { requireAllocation(new Set(values).size === values.length); }
function binding(value: unknown): NativeRequestBinding {
  const b = value as NativeRequestBinding;
  exactRecord(value, b?.kind === 'exact' ? ['kind', 'sessionId', 'requestId'] :
    ['kind', 'operationId', 'sessionId', 'requestId', 'field'], 'operation_binding');
  requireAllocation(b.kind === 'exact' || b.kind === 'operation-result');
  allocationId(b.sessionId); allocationId(b.requestId);
  if (b.kind === 'operation-result') {
    allocationId(b.operationId); requireAllocation(['permission', 'delivery', 'pending-item', 'retained-result'].includes(b.field));
  }
  return b;
}
export function decodeNativeAllocation(value: unknown): NativeAllocationSelection {
  requireAllocation(Buffer.byteLength(canonicalJson(value)) <= ALLOCATION_LIMITS.bytes);
  const v = exactRecord(value, ['contract', 'starts', 'generations', 'entries', 'obligations'], 'native_allocation');
  requireAllocation(v.contract === NATIVE_ALLOCATION && canonicalJson(v.starts) === canonicalJson(ROOT_PROCESS_SCHEDULE));
  const generations = array(v.generations, 4).map((value, index) => {
    const g = exactRecord(value, ['generation', 'ownerSessionId', 'admissionDocumentSha256', 'manifestSha256', 'slots', 'supplemental'], 'allocation_generation');
    requireAllocation(g.generation === index + 1); allocationId(g.ownerSessionId);
    allocationDigest(g.admissionDocumentSha256); allocationDigest(g.manifestSha256);
    const slots = array(g.slots, 2).map((value, slotIndex) => {
      const s = exactRecord(value, ['slot', 'teamId', 'teamRoot', 'walLineage', 'routeId', 'routeDigest', 'activationEndpoint', 'lifecycleEndpoint'], 'allocation_slot');
      requireAllocation(s.slot === (slotIndex === 0 ? 'A' : 'B'));
      for (const key of ['teamId', 'walLineage', 'routeId']) allocationId(s[key]);
      allocationDigest(s.routeDigest);
      for (const key of ['teamRoot', 'activationEndpoint', 'lifecycleEndpoint']) path(s[key]);
      return s as NativeTeamSlotSelection;
    });
    requireAllocation(slots.length === (index === 3 ? 2 : 1));
    for (const key of ['teamId', 'teamRoot', 'walLineage', 'routeId', 'routeDigest'] as const) unique(slots.map(s => s[key]));
    unique(slots.flatMap(s => [s.activationEndpoint, s.lifecycleEndpoint]));
    requireAllocation(canonicalJson(g.supplemental) === canonicalJson({ contract: 'agent-teams.native-supplemental-resources/v1',
      operationChannelFd: 10, teamBActivationFd: index === 3 ? 12 : null, trustDirectoryFd: 19 }));
    const result: NativeGenerationSelection = { generation: (index + 1) as NativeGeneration,
      ownerSessionId: allocationId(g.ownerSessionId), admissionDocumentSha256: allocationDigest(g.admissionDocumentSha256),
      manifestSha256: allocationDigest(g.manifestSha256), slots, supplemental: {
        contract: 'agent-teams.native-supplemental-resources/v1', operationChannelFd: 10,
        teamBActivationFd: index === 3 ? 12 : null, trustDirectoryFd: 19 } };
    return result;
  });
  requireAllocation(generations.length === 4); unique(generations.map(g => g.ownerSessionId));
  for (const g of generations.slice(1)) {
    const a = generations[0].slots[0], b = g.slots[0];
    requireAllocation(a.teamId === b.teamId && a.teamRoot === b.teamRoot && a.walLineage === b.walLineage);
  }
  const entries = array(v.entries, ALLOCATION_LIMITS.entries).map(value => {
    const e = exactRecord(value, ['id', 'generation', 'slot', 'row', 'routeId', 'routeDigest', 'origin', 'operation', 'maximumUses', 'dependencies'], 'allocation_entry');
    allocationId(e.id); allocationId(e.routeId); allocationDigest(e.routeDigest);
    requireAllocation(NATIVE_ROWS.includes(e.row as MatrixRow) && OPERATION_ORIGINS.includes(e.origin as NativeOperationAllocation['origin']));
    const slot = generations.find(g => g.generation === e.generation)?.slots.find(s => s.slot === e.slot);
    requireAllocation(slot && slot.routeId === e.routeId && slot.routeDigest === e.routeDigest);
    requireAllocation(Number.isSafeInteger(e.maximumUses) && Number(e.maximumUses) > 0 && Number(e.maximumUses) <= 256);
    requireAllocation(Array.isArray(e.dependencies) && e.dependencies.length <= ALLOCATION_LIMITS.dependencies);
    e.dependencies.forEach(allocationId); unique(e.dependencies);
    const o = exactRecord(e.operation, ['kind', 'method', 'path', 'binding', 'body', 'decision', 'negativeCase'], 'operation_rule');
    requireAllocation(typeof o.kind === 'string' && Object.hasOwn(OPERATION_RULES, o.kind));
    const rule = OPERATION_RULES[o.kind as keyof typeof OPERATION_RULES];
    requireAllocation(o.method === rule[0] && o.path === rule[1] && e.origin === rule[2]); binding(o.binding);
    const body = decodeProductObservationBody(o.kind, o.body);
    if (body) requireAllocation(body.teamId === slot.teamId);
    requireAllocation(['none', 'allow_once', 'reject'].includes(String(o.decision)));
    const reply = ['conditional-reply', 'retry-reply', 'negative-reply', 'browser-decision'].includes(o.kind);
    requireAllocation(reply ? o.decision !== 'none' : o.decision === 'none');
    if (reply) requireAllocation(e.maximumUses === 1);
    if (o.kind === 'conditional-reply') requireAllocation(e.generation === 2 && e.slot === 'A');
    if (o.kind === 'retry-reply') requireAllocation(e.generation === 3 && e.slot === 'A' && o.decision === 'allow_once');
    if (o.kind === 'negative-reply') requireAllocation(e.generation === 4 && e.slot === 'A' && o.decision === 'reject');
    requireAllocation(e.origin === 'selected-negative' ? typeof o.negativeCase === 'string' &&
      (o.kind === 'negative-reply' ? o.negativeCase === 'incomplete-negative-response' :
        requiredNativeNegative(o.negativeCase) && NATIVE_OBLIGATION_REQUIREMENTS[e.row as MatrixRow].includes(o.negativeCase)) : o.negativeCase === null);
    return e as NativeOperationAllocation;
  });
  unique(entries.map(e => e.id));
  requireAllocation(entries.reduce((sum, e) => sum + e.maximumUses, 0) <= ALLOCATION_LIMITS.uses);
  // Ignore claimed row, ID and negativeCase for overlap: none is request authority.
  unique(entries.map(e => canonicalJson([e.generation, e.slot, e.routeId, e.origin, e.operation.method,
    e.operation.path, e.operation.body && 'resultBinding' in e.operation.body
      ? { ...e.operation.body, resultBinding: { kind: 'approval-page-item',
          requestId: e.operation.binding.requestId, field: 'pending-preview' } } : e.operation.body,
    e.operation.method === 'COMMAND' || e.operation.path.includes(':sessionId') ? e.operation.binding.sessionId : null,
    e.operation.method === 'COMMAND' || e.operation.path.includes(':requestId') ? e.operation.binding.requestId : null,
    e.operation.decision])));
  const seen = new Map<string, NativeOperationAllocation>();
  for (const e of entries) {
    for (const d of e.dependencies) requireAllocation(seen.has(d) && seen.get(d)!.generation <= e.generation);
    const b = e.operation.binding;
    if (b.kind === 'operation-result') {
      const source = seen.get(b.operationId);
      requireAllocation(source && e.dependencies.includes(b.operationId) && source.slot === e.slot &&
        source.operation.binding.sessionId === b.sessionId && source.operation.binding.requestId === b.requestId);
    }
    validatePreviewDependencies(e, seen);
    seen.set(e.id, e);
  }
  const obligations = array(v.obligations, 10).map((value, index) => {
    const o = exactRecord(value, ['row', 'operationIds', 'requirements'], 'allocation_obligation');
    requireAllocation(o.row === NATIVE_ROWS[index]);
    const ids = array(o.operationIds, 128).map(allocationId); unique(ids);
    requireAllocation(ids.every(id => seen.has(id)) && canonicalJson(o.requirements) === canonicalJson(NATIVE_OBLIGATION_REQUIREMENTS[NATIVE_ROWS[index]]));
    return { row: o.row, operationIds: ids, requirements: o.requirements } as NativeAllocationSelection['obligations'][number];
  });
  requireAllocation(obligations.length === 10 && entries.every(e => obligations.some(o => o.operationIds.includes(e.id))) &&
    generations.every(g => g.slots.every(s => entries.some(e => e.generation === g.generation && e.slot === s.slot))));
  // Require the selected timeline, not a singleton relabeled by ten obligations.
  const one = (generation: NativeGeneration, slot: NativeSlot, kind: ClosedOperationRule['kind'], decision = 'none') => {
    const matches = entries.filter(e => e.generation === generation && e.slot === slot &&
      e.operation.kind === kind && e.operation.decision === decision);
    requireAllocation(matches.length === 1); return matches[0];
  };
  one(1, 'A', 'pending-ingress');
  const allow = one(2, 'A', 'conditional-reply', 'allow_once'), deny = one(2, 'A', 'conditional-reply', 'reject');
  requireAllocation(allow.operation.binding.requestId !== deny.operation.binding.requestId);
  const hold = one(2, 'A', 'hold-before-delivery');
  requireAllocation(![allow, deny].some(e => e.operation.binding.requestId === hold.operation.binding.requestId));
  const notDispatched = one(3, 'A', 'reconcile-not-dispatched');
  const retry = one(3, 'A', 'retry-reply', 'allow_once');
  const settled = one(4, 'A', 'reconcile-retained-result');
  requireAllocation(notDispatched.dependencies.includes(hold.id) && retry.dependencies.includes(notDispatched.id) &&
    settled.dependencies.includes(retry.id));
  for (const e of [notDispatched, retry, settled]) requireAllocation(e.operation.binding.requestId === hold.operation.binding.requestId);
  const b = one(4, 'B', 'pending-ingress');
  const unknown = one(4, 'A', 'negative-reply', 'reject');
  const unknownHeld = one(4, 'A', 'reconcile-unknown');
  requireAllocation(unknown.dependencies.includes(b.id) && unknownHeld.dependencies.includes(unknown.id) &&
    unknownHeld.operation.binding.requestId === unknown.operation.binding.requestId);
  requireAllocation(![allow, deny, hold].some(e => e.operation.binding.requestId === unknown.operation.binding.requestId));
  for (const generation of [2, 3, 4] as const) one(generation, 'A', 'restart');
  requireAllocation(entries.some(e => e.generation === 4 && e.operation.kind === 'forced-failure') &&
    entries.some(e => e.generation === 4 && e.operation.kind === 'normal-shutdown'));
  for (const o of obligations) {
    for (const requirement of o.requirements.filter(requiredNativeNegative)) {
      requireAllocation(o.operationIds.some(id => seen.get(id)!.origin === 'selected-negative' &&
        seen.get(id)!.operation.negativeCase === requirement));
    }
    requireAllocation(o.operationIds.some(id => seen.get(id)!.row === o.row ||
      (o.row === '03_owner_effect_settlement' && [allow.id, deny.id].includes(id))));
  }
  return immutableAllocation(structuredClone({ contract: NATIVE_ALLOCATION, starts: ROOT_PROCESS_SCHEDULE, generations, entries, obligations })) as NativeAllocationSelection;
}
/** Exact body selection uses the existing Product schema, including opaque preview
 * and generation references. It is data only; no permit is consumed here. */
export function decodeProductObservationBody(kind: string, value: unknown): ClosedOperationRule['body'] {
  if (kind === 'product-preview' && value && typeof value === 'object' && 'resultBinding' in value) {
    return decodeDependentPreviewBody(value);
  }
  if (kind === 'product-read' || kind === 'product-list' || kind === 'product-preview') {
    const parsed = kind === 'product-preview' ? parseHostedTeamApprovalPreviewRequest(value) : parseHostedTeamApprovalPageRequest(value);
    requireAllocation(parsed.ok);
    return parsed.value;
  }
  requireAllocation(value === null); return null;
}
export function matchesProductObservation(entry: NativeOperationAllocation, method: string, path: string, body: unknown,
  retained?: RetainedProductObservationResults): boolean {
  if (!['product-read', 'product-list', 'product-preview'].includes(entry.operation.kind) ||
    entry.operation.method !== method || entry.operation.path !== path) return false;
  try {
    const expected = entry.operation.body && 'resultBinding' in entry.operation.body
      ? resolveDependentPreviewData(entry, retained) : entry.operation.body;
    const actual = entry.operation.kind === 'product-preview'
      ? parseHostedTeamApprovalPreviewRequest(body) : parseHostedTeamApprovalPageRequest(body);
    return actual.ok && canonicalJson(actual.value) === canonicalJson(expected);
  }
  catch { return false; }
}
export function requiredNativeNegative(requirement: string): boolean {
  return /(?:_rejected|_routes_absent|:duplicate_suppressed|:gap_reconnected)$/u.test(requirement);
}
export function nativeAllocationSha256(selection: NativeAllocationSelection): string {
  return sha256(canonicalJson(decodeNativeAllocation(selection)));
}

// Exact legacy requirement names retained as obligations, never fabricated facts.
export const NATIVE_OBLIGATION_REQUIREMENTS: Readonly<Record<MatrixRow, readonly string[]>> = immutableAllocation({
  '01_pending_before_http': [
    'owner-wal:pending_fsynced',
    'supervisor:owner_restart_completed',
    'owner-wal:pending_restored_after_restart',
    'product-http:pending_observed',
    'product-http:approval_preview_observed',
    'product-sse:pending_event_observed',
  ],
  '02_browser_allow_deny': [
    'browser:allow_submitted',
    'browser:deny_submitted',
    'product-http:allow_accepted',
    'product-http:deny_accepted',
    'opencode:allow_conditional_request',
    'opencode:allow_effect',
    'opencode:allow_conditional_response',
    'opencode:deny_conditional_request',
    'opencode:deny_effect',
    'opencode:deny_conditional_response',
  ],
  '03_owner_effect_settlement': [
    'owner-wal:allow_terminal_fsynced',
    'owner-wal:deny_terminal_fsynced',
    'product-http:terminal_state_observed',
    'product-sse:terminal_events_observed',
    'opencode:effect_total_two',
  ],
  '04_auth_replay_rejections': [
    'product-http:missing_session_rejected',
    'product-http:invalid_session_rejected',
    'product-http:origin_rejected',
    'product-http:csrf_rejected',
    'product-http:stale_revision_rejected',
    'product-http:wrong_team_rejected',
    'product-http:wrong_run_rejected',
    'product-http:wrong_provider_rejected',
    'product-http:non_owner_browser_rejected',
    'product-http:duplicate_post_rejected',
    'product-http:nonce_replay_rejected',
    'owner-wal:owner_response_replay_rejected',
    'product-sse:duplicate_suppressed',
    'product-sse:gap_reconnected',
    'opencode:negative_effect_delta_zero',
  ],
  '05_restart_generation_fences': [
    'supervisor:restart_boundary_one',
    'supervisor:restart_boundary_two',
    'supervisor:restart_boundary_three',
    'owner-wal:stale_generations_rejected',
    'owner-wal:stale_sockets_rejected',
    'owner-wal:truth_reconstructed',
  ],
  '06_ambiguity_reconciliation': [
    'owner-wal:operator_required_fsynced',
    'owner-wal:automatic_retry_absent',
    'owner-wal:reconciliation_lease_fenced',
    'opencode:reconcile_delivered_no_effect',
    'opencode:reconcile_not_delivered_retry_effect',
    'owner-wal:reconcile_retry_terminal_fsynced',
    'opencode:effect_total_three',
    'owner-wal:reconcile_unknown_held',
    'product-http:reconcile_while_lease_open_rejected',
    'product-http:reconcile_identity_mismatch_rejected',
  ],
  '07_socket_capability_admission': [
    'product-http:wrong_lane_routes_absent',
    'product-http:wrong_socket_path_routes_absent',
    'product-http:wrong_socket_device_routes_absent',
    'product-http:wrong_socket_inode_routes_absent',
    'product-http:replaced_socket_routes_absent',
    'product-http:wrong_socket_uid_routes_absent',
    'product-http:wrong_socket_gid_routes_absent',
    'product-http:wrong_socket_mode_routes_absent',
    'product-http:dead_owner_routes_absent',
    'product-http:wrong_artifact_digest_routes_absent',
    'product-http:wrong_capability_digest_routes_absent',
    'product-http:legacy_generation_routes_absent',
    'product-http:provisioning_routes_absent',
    'product-http:restart_required_routes_absent',
    'product-http:missing_capability_routes_absent',
    'product-http:capability_downgrade_routes_absent',
    'owner-wal:new_activation_required',
  ],
  '08_cross_team_isolation': [
    'browser:cross_team_list_rejected',
    'browser:cross_team_preview_rejected',
    'browser:cross_team_decide_rejected',
    'product-http:team_b_item_observed',
    'product-http:team_b_preview_request_observed',
    'product-http:team_b_preview_result_observed',
    'product-http:cross_team_list_rejected',
    'product-http:cross_team_preview_rejected',
    'product-http:cross_team_read_rejected',
    'product-http:cross_team_decide_rejected',
    'product-http:cross_team_reconcile_rejected',
    'product-sse:cross_team_subscribe_rejected',
    'owner-wal:partitions_unchanged',
    'opencode:cross_team_effect_delta_zero',
  ],
  '09_forced_failure_shutdown': [
    'supervisor:forced_owner_failure_drained',
    'supervisor:forced_owner_failure_zero_survivors',
    'supervisor:forced_owner_failure_no_outside_effect',
    'supervisor:forced_opencode_failure_drained',
    'supervisor:forced_opencode_failure_zero_survivors',
    'supervisor:forced_opencode_failure_no_outside_effect',
  ],
  '10_normal_shutdown_cleanup': [
    'supervisor:normal_shutdown_drained',
    'supervisor:normal_shutdown_zero_survivors',
    'supervisor:normal_shutdown_marker_checked',
    'supervisor:normal_shutdown_no_outside_effect',
  ],
});
