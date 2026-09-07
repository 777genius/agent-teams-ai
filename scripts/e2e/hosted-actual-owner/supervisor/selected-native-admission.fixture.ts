/** Test-source data only. No fixture is installed as root authority. */
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalJson, sha256 } from './canonical';
import { ROOT_PROCESS_SCHEDULE } from './launch-schedule';
import { decodeNativeAllocation, NATIVE_ALLOCATION, NATIVE_ROWS, NATIVE_OBLIGATION_REQUIREMENTS,
  OPERATION_RULES, decodeProductObservationBody, requiredNativeNegative, type ClosedOperationRule, type NativeOperationAllocation, type NativeGenerationSelection } from './selected-operation-allocation';
import { NATIVE_LAUNCH_ADMISSION, decodeNativeAdmissionStatement, type NativeLaunchRequest,
  nativeLaunchAdmissionSigningBytes, decodeNativeLaunchAdmission } from './selected-native-admission-contract';

export function allocationFixture() {
  const generations: NativeGenerationSelection[] = [1, 2, 3, 4].map(generation => ({
    generation: generation as 1 | 2 | 3 | 4, ownerSessionId: `owner-session_fixture-${generation}`,
    admissionDocumentSha256: sha256(`document-${generation}`), manifestSha256: sha256(`manifest-${generation}`),
    slots: (generation === 4 ? ['A', 'B'] as const : ['A'] as const).map(slot => ({ slot,
      teamId: `team_${(slot === 'A' ? '1' : '2').repeat(32)}`, teamRoot: `/sandbox/team-${slot}`,
      walLineage: `wal-${slot}`, routeId: `route-${slot}`, routeDigest: sha256(`route-${slot}`),
      activationEndpoint: `/sandbox/activation-${slot}-${generation}`, lifecycleEndpoint: `/sandbox/lifecycle-${slot}-${generation}` })),
    supplemental: { contract: 'agent-teams.native-supplemental-resources/v1', operationChannelFd: 10,
      teamBActivationFd: generation === 4 ? 12 : null, trustDirectoryFd: 19 },
  }));
  const entries: NativeOperationAllocation[] = [];
  function add(id: string, generation: 1 | 2 | 3 | 4, slot: 'A' | 'B', row: number,
    kind: ClosedOperationRule['kind'], requestId = id, dependencies: string[] = [], decision: ClosedOperationRule['decision'] = 'none') {
    const rule = OPERATION_RULES[kind], selected = generations[generation - 1].slots.find(s => s.slot === slot)!;
    entries.push({ id, generation, slot, row: NATIVE_ROWS[row - 1], routeId: selected.routeId, routeDigest: selected.routeDigest,
      origin: rule[2], operation: { kind, method: rule[0], path: rule[1], binding: { kind: 'exact', sessionId: `session-${slot}`, requestId },
        body: decodeProductObservationBody(kind, kind === 'product-preview' ? {
          schemaVersion: 1, teamId: selected.teamId, expectedRunId: `run_${'9'.repeat(32)}`,
          resultBinding: { kind: 'approval-page-item', operationId: `${slot}page`,
            subjectOperationId: slot === 'A' ? 'pending' : 'Bpending', field: 'pending-preview' },
        } : ['product-read', 'product-list'].includes(kind) ? {
          schemaVersion: 1, teamId: selected.teamId, expectedRunId: `run_${'9'.repeat(32)}`, cursor: null, limit: 20,
        } : null),
        decision, negativeCase: rule[2] === 'selected-negative' ? kind === 'negative-reply' ? 'incomplete-negative-response' :
          NATIVE_OBLIGATION_REQUIREMENTS[NATIVE_ROWS[row - 1]].find(requiredNativeNegative)! : null },
      maximumUses: 1, dependencies });
  }
  add('pending', 1, 'A', 1, 'pending-ingress');
  add('restart-2', 2, 'A', 5, 'restart');
  add('Nallow', 2, 'A', 2, 'conditional-reply', 'allow', [], 'allow_once');
  add('Ndeny', 2, 'A', 2, 'conditional-reply', 'deny', [], 'reject');
  add('auth-negative', 2, 'A', 4, 'request-negative');
  add('Rhold', 2, 'A', 6, 'hold-before-delivery', 'retry');
  add('restart-3', 3, 'A', 5, 'restart');
  add('Rnot-dispatched', 3, 'A', 6, 'reconcile-not-dispatched', 'retry', ['Rhold']);
  add('Rretry', 3, 'A', 6, 'retry-reply', 'retry', ['Rnot-dispatched'], 'allow_once');
  add('restart-4', 4, 'A', 5, 'restart');
  add('Rsettled', 4, 'A', 6, 'reconcile-retained-result', 'retry', ['Rretry']);
  add('Bpending', 4, 'B', 8, 'pending-ingress');
  add('capability-negative', 4, 'A', 7, 'admission-negative');
  add('U', 4, 'A', 6, 'negative-reply', 'unknown', ['Bpending'], 'reject');
  add('Uheld', 4, 'A', 6, 'reconcile-unknown', 'unknown', ['U']);
  add('forced-owner', 4, 'A', 9, 'forced-failure');
  add('forced-opencode', 4, 'A', 9, 'forced-failure');
  add('normal-shutdown', 4, 'A', 10, 'normal-shutdown');
  add('Apage', 1, 'A', 1, 'product-read', 'pending', ['pending']);
  add('Apreview', 1, 'A', 1, 'product-preview');
  add('Aterminal', 2, 'A', 3, 'product-read');
  add('Bpage', 4, 'B', 8, 'product-list', 'Bpending', ['Bpending']);
  add('Bpreview', 4, 'B', 8, 'product-preview');
  for (const slot of ['A', 'B'] as const) {
    const index = entries.findIndex(e => e.id === `${slot}preview`), entry = entries[index];
    const subjectOperationId = slot === 'A' ? 'pending' : 'Bpending';
    entries[index] = { ...entry, dependencies: [subjectOperationId, `${slot}page`], operation: { ...entry.operation,
      binding: { kind: 'operation-result', operationId: `${slot}page`, sessionId: `session-${slot}`,
        requestId: subjectOperationId, field: 'pending-item' },
      body: { schemaVersion: 1, teamId: generations[entry.generation - 1].slots.find(s => s.slot === slot)!.teamId,
        expectedRunId: `run_${'9'.repeat(32)}`, resultBinding: { kind: 'approval-page-item',
          operationId: `${slot}page`, subjectOperationId, field: 'pending-preview' } } } };
  }
  for (const [index, row] of NATIVE_ROWS.entries()) {
    for (const requirement of NATIVE_OBLIGATION_REQUIREMENTS[row].filter(requiredNativeNegative)) {
      if (entries.some(e => e.operation.negativeCase === requirement)) continue;
      const id = `negative-${entries.length}`;
      add(id, index === 3 ? 2 : 4, 'A', index + 1, index === 6 ? 'admission-negative' : 'request-negative');
      const last = entries.pop()!;
      entries.push({ ...last, operation: { ...last.operation, negativeCase: requirement } });
    }
  }
  return decodeNativeAllocation({ contract: NATIVE_ALLOCATION, starts: ROOT_PROCESS_SCHEDULE, generations, entries,
    obligations: NATIVE_ROWS.map(row => ({ row, requirements: NATIVE_OBLIGATION_REQUIREMENTS[row],
      operationIds: entries.filter(e => e.row === row || row === NATIVE_ROWS[2] && e.row === NATIVE_ROWS[1]).map(e => e.id) })) });
}
export function nativeContractFixture() {
  const launcher = generateKeyPairSync('ed25519'), activation = generateKeyPairSync('ed25519');
  const allocation = allocationFixture();
  const trust = { schemaVersion: 1 as const, purpose: 'agent-teams.p3c.controller-trust-anchor/v1' as const,
    authorityEpoch: 1, harnessReviewerPublicKeySha256: 'a'.repeat(64), runAuthorizationPublicKeySha256: 'b'.repeat(64), revokedSignerKeyIds: [] };
  const native = { allocation, controllerDescriptor: '{"fixture":"descriptor-parsing-is-a-separate-root-gate"}', controllerTrustAnchor: trust,
    activation: { publicKeySpkiDerBase64url: activation.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'), contractDigest: 'c'.repeat(64) } };
  const request: NativeLaunchRequest = { kind: 'native', generation: 1, ownerProcessStartToken: '1'.repeat(64),
    launch: { ownerProcessStartToken: '1'.repeat(64), bootstrapV2HeaderSha256: '2'.repeat(64), actual: 'fixture' }, sealed: { actual: 'sealed-fixture' } };
  const statement = decodeNativeAdmissionStatement({ format: NATIVE_LAUNCH_ADMISSION, ...native,
    launchSha256: sha256(canonicalJson(request.launch)), sealedSha256: sha256(canonicalJson(request.sealed)),
    ownerProcessStartToken: request.ownerProcessStartToken, allocationSha256: sha256(canonicalJson(allocation)),
    generation: allocation.generations[0], predecessorResults: [] });
  const admission = decodeNativeLaunchAdmission({ statement,
    signatureBase64url: sign(null, nativeLaunchAdmissionSigningBytes(statement), launcher.privateKey).toString('base64url') });
  return { native, launcher, request, statement, admission };
}
