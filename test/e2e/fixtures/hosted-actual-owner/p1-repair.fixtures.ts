import { canonicalJson, P3C_LANE, sha256 } from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import { makeRawRecord, makeSemanticPayload } from '../../../../scripts/e2e/hosted-actual-owner/evidence';
import { snapshotP1LaunchSelection } from '../../../../scripts/e2e/hosted-actual-owner/p1-admission';

import { context, hex, peer, rawRecord, recordData, retainChanges } from './raw-http.fixtures';

import type { RawRecord, RuntimeCaptureName } from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import type { SupervisorPlan } from '../../../../scripts/e2e/hosted-actual-owner/processes';
import type { HostedHttpContext } from '../../../../scripts/e2e/hosted-actual-owner/raw-http-types';
import type { HttpFixture } from './raw-http.fixtures';

// Pure source-characterization data. No launch, publication or kernel observation is performed.
export function selectionFixture(input: HttpFixture) {
  const processes = [...input.outcome.starts, input.outcome.supervisorStart];
  const plan = {
    controllerNonce: input.controllerNonce,
    runId: input.runId,
    expectedExecutableDevice: Object.fromEntries(processes.map((p) => [p.role, p.executableDevice])),
    expectedExecutableInode: Object.fromEntries(processes.map((p) => [p.role, p.executableInode])),
    expectedExecutableSha256: Object.fromEntries(processes.map((p) => [p.role, p.executableSha256])),
    expectedProducerArtifactSha256: {},
    expectedProducerModuleSha256: {},
  } as unknown as SupervisorPlan;
  for (const capture of Object.values(input.outcome.captureFiles)) {
    const shard = capture.shards[0]!;
    Object.assign(plan.expectedProducerArtifactSha256, { [shard.producerRole]: shard.producerArtifactSha256 });
    Object.assign(plan.expectedProducerModuleSha256, { [shard.producerRole]: shard.producerModuleSha256 });
  }
  return { plan, selection: snapshotP1LaunchSelection(plan) };
}

export function rewriteNative(
  input: HttpFixture,
  name: RuntimeCaptureName,
  change: (record: Record<string, unknown>, index: number) => void
): void {
  let previousRecordSha256: string | null = null;
  const lines = input.captures[name][0]!.toString('utf8').trimEnd().split('\n');
  const bytes = Buffer.from(lines.map((line, index) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    change(record, index);
    record.previousRecordSha256 = previousRecordSha256;
    const next = `${canonicalJson(record)}\n`;
    previousRecordSha256 = sha256(next);
    return next;
  }).join(''));
  input.captures[name] = [bytes];
  Object.assign(input.outcome.captureFiles[name].shards[0]!, { size: bytes.length, sha256: sha256(bytes) });
  if (name === 'openCodeTimelinePath' || name === 'protectedEffectLedgerPath') {
    input.correlations[0] = {
      ...input.correlations[0]!,
      [name === 'openCodeTimelinePath' ? 'timeline' : 'effects']: {
        captureSha256: sha256(bytes), shardIndex: 0,
      },
    };
  }
}

export function rewriteContext(input: HttpFixture, next: HostedHttpContext): void {
  const ids = new Map<string, string>();
  input.records = input.records.map((record, index) => {
    const data = recordData(record);
    let observation = data.observation;
    if (observation.phase === 'response-retained') {
      observation = { ...observation, requestRecordId: ids.get(observation.requestRecordId)! };
    } else if (observation.phase === 'exchange-failed' && observation.requestRecordId !== null) {
      observation = { ...observation, requestRecordId: ids.get(observation.requestRecordId)! };
    }
    const rewritten = rawRecord({
      ...data,
      context: next,
      observation,
    }, index + 1);
    ids.set(record.recordId, rewritten.recordId);
    return rewritten;
  });
  input.correlations[0] = { ...input.correlations[0]!, context: next };
  retainChanges(input);
}

export function legacyOpenCodeRecord(): RawRecord {
  const identity = {
    lane: P3C_LANE,
    controllerNonce: context.activation.controllerNonce,
    harnessRunId: context.activation.runId,
    authenticatedActorTeamId: `team_${'1'.repeat(32)}`,
    targetTeamId: `team_${'1'.repeat(32)}`,
    targetTeamRunId: `run_${'2'.repeat(32)}`,
    approvalId: `approval_${'3'.repeat(32)}`,
    generationId: 'generation_fixture',
    idempotencyKey: 'request_1',
    previewRef: 'approval_preview_fixture',
    decision: 'allow' as const,
  };
  const fields = { schemaVersion: 1, approvalId: identity.approvalId,
    generation: identity.generationId, decision: identity.decision, providerEffectId: null };
  return makeRawRecord({
    controllerNonce: identity.controllerNonce,
    origin: 'opencode', row: context.row, sequence: 1, monotonicNs: '11',
    processStartToken: peer.startToken, event: 'allow_conditional_request',
    correlation: hex(700), effectCount: 0,
    payload: makeSemanticPayload({
      origin: 'opencode', row: context.row, event: 'allow_conditional_request', identity,
      observedRequestBody: Buffer.from(canonicalJson({ ...fields, kind: 'conditional-decision-request' })),
      observedResponseBody: Buffer.from(canonicalJson({ ...fields, kind: 'conditional-decision-result', outcome: 'observed' })),
    }),
  });
}
