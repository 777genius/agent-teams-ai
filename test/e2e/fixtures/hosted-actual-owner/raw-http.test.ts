import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  P3C_LANE,
  sha256,
  type RawRecord,
} from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import {
  assembleEvidence,
  deriveEvidence,
  makeRawRecord,
  makeSemanticPayload,
  parseRawOrigin,
} from '../../../../scripts/e2e/hosted-actual-owner/evidence';
import { parseKernelBoundNativeCaptures } from '../../../../scripts/e2e/hosted-actual-owner/native-captures';
import {
  P1ScenarioEvidencePending,
  verifyOpenCodeHttpEvidence,
} from '../../../../scripts/e2e/hosted-actual-owner/native-http-join';
import { parseRawFiles } from '../../../../scripts/e2e/hosted-actual-owner/raw-file-evidence';
import {
  decodeHttpBase64,
  decodeHttpRecord,
  parseHttpCanonical,
  snapshotHttpContext,
} from '../../../../scripts/e2e/hosted-actual-owner/raw-http';
import {
  HTTP_LIMITS,
  HTTP_OBSERVATION_KIND,
  type LocatedHttpRawRecord,
} from '../../../../scripts/e2e/hosted-actual-owner/raw-http-types';
import {
  body,
  changeResponse,
  context,
  controllerNonce,
  fixture,
  hex,
  hosted,
  joint,
  ledger,
  nativeCapture,
  owner,
  peer,
  protocol,
  rawRecord,
  readOperation,
  recordData,
  reply,
  runId,
  starts,
  supervisorStart,
} from './raw-http.fixtures';

function parse(records: readonly RawRecord[]) {
  return parseRawOrigin(ledger(records), 'opencode', controllerNonce);
}

function replaceRequest(input: ReturnType<typeof fixture>, bytes: Buffer) {
  const request = recordData(input.records[0]!);
  if (request.observation.phase !== 'request-retained') throw new Error('fixture request');
  input.records[0] = rawRecord(
    { ...request, observation: { ...request.observation, body: body(bytes) } },
    1
  );
  changeResponse(input.records, { requestRecordId: input.records[0].recordId });
}

describe('P1 actual-source operation groups', () => {
  it.each(['capability', 'observe', 'overflow'] as const)(
    'joins the one-fact %s branch',
    (kind) => {
      const result = joint(fixture([readOperation(kind)]));
      expect(result.status).toBe('joined');
      expect(result.exchanges[0]!.facts).toHaveLength(1);
      expect(result.exchanges[0]!.terminal).toBe('uncertain');
    }
  );

  it.each([
    'applied',
    'bad-request',
    'conflict',
    'precondition-failed',
    'unavailable',
    'body-read-failed',
    'invalid-json',
    'invalid-schema',
  ] as const)('joins actual reply %s', (outcome) => {
    const result = joint(fixture([reply(outcome)]));
    expect(result.status).toBe('joined');
    const exchange = result.exchanges[0]!;
    expect(exchange.facts).toHaveLength(
      outcome === 'applied'
        ? 3
        : ['bad-request', 'conflict', 'precondition-failed'].includes(outcome)
          ? 2
          : 1
    );
    expect(exchange.terminal).toBe(
      outcome === 'applied'
        ? 'applied'
        : ['conflict', 'precondition-failed'].includes(outcome)
          ? 'condition-rejected'
          : 'uncertain'
    );
    if (outcome !== 'applied') {
      expect(exchange.facts[0]!.record.native.runtimeInstanceId).toBeNull();
      const typed = exchange.facts.find(({ record }) => record.recordType === 'hosted-reply');
      if (typed) expect(typed.record.native).not.toHaveProperty('responseSha256');
    }
  });

  it('preserves raw URL versus typed submitted IDs on the bad-request branch', () => {
    const result = joint(fixture([reply('bad-request')]));
    expect(result.exchanges[0]!.facts.map(({ record }) => record.native.requestId)).toEqual([
      'per_1',
      'per_other',
    ]);
    expect(result.status).toBe('joined');
  });

  it.each(['allow_once', 'reject'] as const)(
    'maps applied decision %s in the independent effect stream',
    (decision) => {
      const result = joint(fixture([reply('applied', 1, decision)]));
      const facts = result.exchanges[0]!.facts;
      expect(
        facts.find(({ record }) => record.stream === 'protectedEffectLedger')!.record.native
          .decision
      ).toBe(decision === 'allow_once' ? 'once' : 'reject');
      expect(new Set(facts.map(({ locator }) => canonicalJson(locator))).size).toBe(3);
      expect(facts.every(({ locator, record }) => locator.lineSha256 === record.lineSha256)).toBe(
        true
      );
    }
  );

  it('keeps identical bodies in distinct operations and permits reversed response arrival', () => {
    const input = fixture([readOperation('capability', 1), readOperation('capability', 2)]);
    const data = input.records.map(recordData);
    const request1 = rawRecord(data[0]!, 1);
    const request2 = rawRecord(data[2]!, 2);
    const response2 = data[3]!;
    const response1 = data[1]!;
    if (
      response1.observation.phase !== 'response-retained' ||
      response2.observation.phase !== 'response-retained'
    )
      throw new Error('fixture responses');
    input.records = [
      request1,
      request2,
      rawRecord(
        {
          ...response2,
          observation: { ...response2.observation, requestRecordId: request2.recordId },
        },
        3
      ),
      rawRecord(
        {
          ...response1,
          observation: { ...response1.observation, requestRecordId: request1.recordId },
        },
        4
      ),
    ];
    const result = joint(input);
    expect(result.status).toBe('joined');
    expect(result.exchanges.map(({ operationNonce }) => operationNonce)).toEqual([hex(1), hex(2)]);
    expect(new Set(result.exchanges.map(({ facts }) => facts[0]!.locator.lineSha256)).size).toBe(2);
  });

  it('does not compare the effect sequence against the timeline sequence', () => {
    const result = joint(
      fixture([readOperation('capability', 1), readOperation('observe', 2), reply('applied', 3)])
    );
    expect(result.status).toBe('joined');
    const facts = result.exchanges[2]!.facts;
    expect(
      facts.find(({ record }) => record.recordType === 'hosted-reply-raw')!.locator.sequence
    ).toBe(3);
    expect(
      facts.find(({ record }) => record.recordType === 'conditional-reply-effect')!.locator.sequence
    ).toBe(1);
  });
});

describe('P1 refuses missing, orphaned and reused native facts', () => {
  it.each([
    'missing-effect',
    'duplicate-effect',
    'orphan',
    'mismatch-effect',
    'typed-before-raw',
  ] as const)('leaves %s incomplete', (change) => {
    const operation = reply('applied');
    if (change === 'missing-effect') operation.effects = [];
    if (change === 'duplicate-effect') operation.effects.push(operation.effects[0]!);
    if (change === 'orphan') operation.timeline.push(readOperation('capability', 9).timeline[0]!);
    if (change === 'typed-before-raw') operation.timeline.reverse();
    if (change === 'mismatch-effect')
      operation.effects[0] = {
        ...operation.effects[0]!,
        native: {
          sessionId: 'ses_1',
          requestId: 'per_1',
          decision: 'once',
          outcome: 'mismatch',
          permissionDigest: null,
          runtimeInstanceId: null,
          configGeneration: null,
          sessionIncarnation: null,
          requestIncarnation: null,
        },
      };
    const result = joint(fixture([operation]));
    expect(result.status).toBe('incomplete');
    expect(result.unmatchedNativeFacts.length).toBeGreaterThan(0);
    // A complete applied receipt is terminal even if its native correlation is incomplete.
    expect(result.exchanges[0]!.terminal).toBe('applied');
  });

  it('consumes a group once, including an identical-body nonce replay', () => {
    const input = fixture([readOperation('capability', 1), readOperation('capability', 2)]);
    changeResponse(
      input.records,
      {
        peerOperationNonce: hex(1),
        responseHeaders: [['x-agent-teams-hosted-operation-nonce', hex(1)]],
      },
      3
    );
    const result = joint(input);
    expect(result.status).toBe('incomplete');
    expect(result.exchanges[1]!.problem).toContain('operation_reused');
    expect(result.unmatchedNativeFacts).toHaveLength(1);
  });

  it('does not repair an unknown nonce by matching a body hash', () => {
    const input = fixture([readOperation('capability')]);
    changeResponse(input.records, {
      peerOperationNonce: hex(999),
      responseHeaders: [['x-agent-teams-hosted-operation-nonce', hex(999)]],
    });
    expect(joint(input).exchanges[0]!.problem).toContain('native_operation_missing');
  });

  it.each(['producer', 'activation', 'shard'] as const)(
    'rejects substituted %s identity',
    (change) => {
      const input = fixture();
      if (change === 'producer') {
        Object.assign(input.outcome, {
          starts: input.outcome.starts.map((value) =>
            value.role === 'opencode' ? { ...value, executableSha256: hex(998) } : value
          ),
        });
      } else if (change === 'activation') {
        input.admissions[0] = {
          ...input.admissions[0]!,
          context: {
            ...context,
            activation: { ...context.activation, stackManifestSha256: hex(997) },
          },
        };
      } else {
        input.admissions[0] = {
          ...input.admissions[0]!,
          timeline: { captureSha256: hex(996), shardIndex: 0 },
        };
      }
      expect(() => joint(input)).toThrow(/binding|admitted_producer|admitted_shard/u);
    }
  );

  it('rejects replacing an admitted shard by equal semantic rows with a new physical hash', () => {
    const input = fixture();
    const replacement = nativeCapture(
      'openCodeTimelinePath',
      reply('applied').timeline,
      'replacement'
    );
    input.captures.openCodeTimelinePath = [replacement.bytes];
    Object.assign(input.outcome.captureFiles.openCodeTimelinePath, { shards: [replacement.shard] });
    expect(() => joint(input)).toThrow('admitted_shard');
  });

  it('rejects an emission nonce replay shared across capture families', () => {
    const input = fixture();
    const replacement = nativeCapture('negativeResultsPath', [], 'conditionalPostLedgerPath');
    input.captures.negativeResultsPath = [replacement.bytes];
    Object.assign(input.outcome.captureFiles.negativeResultsPath, { shards: [replacement.shard] });
    expect(() => joint(input)).toThrow('p3c_runtime_capture_binding:negativeResultsPath:0');
  });

  it('rejects an omitted HTTP record and a substituted producer descriptor', () => {
    const input = fixture();
    const native = parseKernelBoundNativeCaptures(input);
    expect(() =>
      verifyOpenCodeHttpEvidence({
        records: parse(input.records).slice(0, 1) as LocatedHttpRawRecord[],
        ledger: input.raw.opencode,
        shards: [...native.shards.openCodeTimelinePath, ...native.shards.protectedEffectLedgerPath],
        admissions: input.admissions,
        outcome: input.outcome,
      })
    ).toThrow('raw_selection_incomplete');
    Object.assign(input.outcome.captureFiles.openCodeTimelinePath.shards[0]!, {
      captureInode: '99999',
    });
    expect(() => joint(input)).toThrow('descriptor_binding');
  });

  it('binds parsed HTTP observations to the exact physical raw line', () => {
    const input = fixture();
    const native = parseKernelBoundNativeCaptures(input);
    const records = [...parse(input.records)] as LocatedHttpRawRecord[];
    records[0] = { ...records[0]!, lineSha256: hex(999) };
    expect(() =>
      verifyOpenCodeHttpEvidence({
        records,
        ledger: input.raw.opencode,
        shards: [...native.shards.openCodeTimelinePath, ...native.shards.protectedEffectLedgerPath],
        admissions: input.admissions,
        outcome: input.outcome,
      })
    ).toThrow('raw_fact_locator');
  });
});

describe('HTTP uncertainty and immutable admission', () => {
  it.each(['missing', 'duplicate', 'comma', 'padded', 'upper'] as const)(
    'retains %s nonce metadata without joining',
    (kind) => {
      const input = fixture();
      const values =
        kind === 'missing'
          ? []
          : kind === 'duplicate'
            ? [hex(1), hex(1)]
            : kind === 'comma'
              ? [`${hex(1)}, ${hex(2)}`]
              : kind === 'padded'
                ? [` ${hex(1)}`]
                : ['A'.repeat(64)];
      changeResponse(input.records, {
        responseHeaders: values.map((value) => ['X-Agent-Teams-Hosted-Operation-Nonce', value]),
        peerOperationNonce: null,
        nonceStatus: kind === 'missing' ? 'missing' : 'invalid',
      });
      const result = joint(input);
      expect(result.status).toBe('incomplete');
      expect(result.exchanges[0]!.facts).toHaveLength(0);
      expect(result.exchanges[0]!.terminal).toBe('applied');
      expect(result.exchanges[0]).not.toHaveProperty('retryAuthority');
    }
  );

  it.each(['incomplete', 'invalid-utf8', 'missing-response', 'encoded'] as const)(
    'retains %s as uncertainty',
    (kind) => {
      const input = fixture();
      if (kind === 'missing-response') input.records.pop();
      else
        changeResponse(
          input.records,
          kind === 'incomplete'
            ? { complete: false }
            : kind === 'invalid-utf8'
              ? { body: body(Buffer.from([0xff])) }
              : {
                  responseHeaders: [
                    ['content-encoding', 'gzip'],
                    ['x-agent-teams-hosted-operation-nonce', hex(1)],
                  ],
                }
        );
      const result = joint(input);
      expect(result.status).toBe('incomplete');
      expect(result.exchanges[0]!.terminal).toBe('uncertain');
      expect(result.exchanges[0]!.facts).toHaveLength(0);
      expect(result.unmatchedNativeFacts).toHaveLength(3);
    }
  );

  it.each([Buffer.from([0xff]), Buffer.from('{"schemaVersion":2,"schemaVersion":2}')])(
    'retains malformed request bytes and joins only their actual invalid-json failure',
    (bytes) => {
      const operation = reply('invalid-json');
      operation.requestBytes = bytes;
      operation.timeline[0] = {
        ...operation.timeline[0]!,
        native: {
          ...operation.timeline[0]!.native,
          requestBodySha256: sha256(bytes),
        },
      };
      const result = joint(fixture([operation]));
      expect(result.status).toBe('joined');
      expect(result.exchanges[0]!.terminal).toBe('uncertain');
    }
  );

  it('freezes request context before delayed response encoding and rejects resampling', () => {
    const mutable = structuredClone(context);
    const admitted = snapshotHttpContext(mutable);
    Object.assign(mutable.activation, { ownerSessionId: 'changed' });
    Object.assign(mutable.recorder, { ownerSessionId: 'changed' });
    expect(admitted.activation.ownerSessionId).toBe('owner_session_1');
    expect(Object.isFrozen(admitted.recorder)).toBe(true);
    const input = fixture();
    const response = recordData(input.records[1]!);
    input.records[1] = rawRecord(
      { ...response, context: { ...context, row: '03_owner_effect_settlement' } },
      2
    );
    input.admissions.push({
      ...input.admissions[0]!,
      context: recordData(input.records[1]!).context,
    });
    expect(() => joint(input)).toThrow('exchange_snapshot');
  });

  it('rejects an Owner recorder relabeled with the OpenCode start or wrong generation', () => {
    for (const recorder of [
      {
        ...context.recorder,
        processStartToken: peer.startToken,
        pid: peer.pid,
        startTicks: peer.startTime,
      },
      { ...context.recorder, ownerGeneration: 2 },
    ]) {
      const input = fixture();
      input.admissions[0] = {
        ...input.admissions[0]!,
        context: {
          ...context,
          recorder,
          activation: { ...context.activation, ownerGeneration: recorder.ownerGeneration },
        },
      };
      expect(() => joint(input)).toThrow('recorder_start');
    }
  });

  it('requires the response socket tuple and refuses expectation-shaped substitutions', () => {
    const input = fixture();
    changeResponse(input.records, {
      connectedPeer: {
        localAddress: '127.0.0.1',
        localPort: 45000,
        remoteAddress: '127.0.0.1',
        remotePort: 4097,
      },
    });
    expect(() => joint(input)).toThrow('connected_endpoint');
    const data = recordData(input.records[1]!);
    Object.assign(data.observation, { connectedPeer: context.expectedPeer });
    expect(() => parse([input.records[0]!, rawRecord(data, 2)])).toThrow();
  });

  it('retains a bound and unbound failure without inventing an HTTP response', () => {
    const input = fixture();
    const request = recordData(input.records[0]!);
    input.records = [
      input.records[0]!,
      rawRecord(
        {
          ...request,
          observation: {
            phase: 'exchange-failed',
            ownerExchangeNonce: request.observation.ownerExchangeNonce,
            requestRecordId: input.records[0]!.recordId,
            failure: { phase: 'end-attempted', code: 'ECONNRESET' },
          },
        },
        2
      ),
      rawRecord(
        {
          ...request,
          observation: {
            phase: 'exchange-failed',
            ownerExchangeNonce: null,
            requestRecordId: null,
            failure: { phase: 'before-end', code: 'unavailable' },
          },
        },
        3
      ),
    ];
    const result = joint(input);
    expect(result.unboundFailureRecordIds).toHaveLength(1);
    expect(result.exchanges[0]!.responseRecordId).toBeNull();
    expect(result.exchanges[0]!.terminal).toBe('uncertain');
    expect(result.exchanges[0]!.failureRecordIds).toHaveLength(1);
  });
});

describe('discriminated raw framing and bounds', () => {
  it('retains an actual 1 MiB observe body through all three base64 layers', () => {
    const operation = readOperation('observe');
    const rawPermission = {
      id: 'per_1',
      sessionID: 'ses_1',
      permission: 'read',
      patterns: [],
      metadata: { padding: '' },
      always: [],
    };
    const permission = {
      requestId: 'per_1',
      sessionId: 'ses_1',
      sessionIncarnation: `session_incarnation_${'3'.repeat(32)}`,
      requestIncarnation: `request_incarnation_${'4'.repeat(32)}`,
      permissionDigest: sha256(canonicalJson(rawPermission)),
      rawPermission,
    };
    const response = {
      schemaVersion: 2,
      protocol,
      ...hosted,
      sessionId: 'ses_1',
      permissions: [permission],
    };
    rawPermission.metadata.padding = 'x'.repeat(
      HTTP_LIMITS.body - Buffer.byteLength(JSON.stringify(response))
    );
    permission.permissionDigest = sha256(canonicalJson(rawPermission));
    operation.responseBytes = Buffer.from(JSON.stringify(response));
    operation.timeline[0] = {
      ...operation.timeline[0]!,
      native: {
        ...operation.timeline[0]!.native,
        permissionCount: 1,
        responseSha256: sha256(operation.responseBytes),
      },
    };
    const input = fixture([operation]);
    expect(operation.responseBytes.length).toBe(HTTP_LIMITS.body);
    expect(Buffer.from(input.records[1]!.payloadBase64, 'base64').length).toBeGreaterThan(
      1024 * 1024
    );
    expect(Buffer.byteLength(canonicalJson(input.records[1]!)) + 1).toBeGreaterThan(
      2 * 1024 * 1024
    );
    expect(joint(input).status).toBe('joined');
    changeResponse(input.records, { body: body(Buffer.alloc(HTTP_LIMITS.body + 1)) });
    expect(() => parse(input.records)).toThrow('body_base64');
  });

  it('rejects metadata, payload, structural, line and ledger overflow including the retained prefix', () => {
    const input = fixture();
    changeResponse(input.records, {
      responseHeaders: [
        ['content-encoding', 'x'.repeat(HTTP_LIMITS.metadata)],
        ['x-agent-teams-hosted-operation-nonce', hex(1)],
      ],
    });
    expect(() => parse(input.records)).toThrow('metadata_limit');
    expect(() =>
      decodeHttpBase64(
        Buffer.alloc(HTTP_LIMITS.payload + 1).toString('base64'),
        HTTP_LIMITS.payload,
        'payload'
      )
    ).toThrow();
    expect(() =>
      decodeHttpRecord({
        kind: HTTP_OBSERVATION_KIND,
        recordSha256: hex(1),
        recordBase64: Buffer.alloc(HTTP_LIMITS.record + 1).toString('base64'),
      })
    ).toThrow('record_base64');
    const line = Buffer.alloc(HTTP_LIMITS.line + 1, 0x20);
    line[line.length - 1] = 0x0a;
    expect(() => parseRawOrigin(line, 'opencode', controllerNonce)).toThrow('origin_line');
    const prefixAndSuffix = Buffer.alloc(HTTP_LIMITS.ledger + 1);
    prefixAndSuffix[prefixAndSuffix.length - 1] = 0x0a;
    expect(() => parseRawOrigin(prefixAndSuffix, 'opencode', controllerNonce)).toThrow(
      'origin_frame'
    );
  });

  it.each([
    '{"a":1,"a":1}',
    '{"nested":{"a":1,"a":1}}',
    '{"a":1.0}',
    '{"a":-0}',
    '\ufeff{}',
    '{"a":"\\ud800"}',
  ])('rejects noncanonical structural JSON %s', (text) =>
    expect(() => parseHttpCanonical(Buffer.from(text), 'test')).toThrow()
  );

  it('rejects UTF8, base64 aliases, unknown payload keys and a recomputed body digest mismatch', () => {
    expect(() => parseHttpCanonical(Buffer.from([0xff]), 'test')).toThrow();
    for (const value of [' YQ==', 'YQ', 'YR==', 'YQ-_'])
      expect(() => decodeHttpBase64(value, 32, 'test')).toThrow();
    const input = fixture();
    const data = recordData(input.records[1]!);
    Object.assign(data.observation, { body: { ...body(Buffer.alloc(0)), sha256: hex(1) } });
    expect(() => parse([input.records[0]!, rawRecord(data, 2)])).toThrow('body_digest');
    expect(() => parse([{ ...input.records[0]!, payloadSha256: hex(999) }])).toThrow(
      'payload_digest'
    );
    expect(() => parse([{ ...input.records[0]!, recordId: hex(999) }])).toThrow('record_identity');
    const payload = JSON.parse(
      Buffer.from(input.records[0]!.payloadBase64, 'base64').toString('utf8')
    );
    expect(() => decodeHttpRecord({ ...payload, preview: 'fictional' })).toThrow();
  });

  it('checks method/path, phase/outer binding, unknown headers and exact conditional request fields', () => {
    const input = fixture();
    const data = recordData(input.records[0]!);
    Object.assign(data.observation, { path: '/v1/conditional-decisions' });
    expect(() => parse([rawRecord(data, 1)])).toThrow('request_route');
    const original = input.records[0]!;
    const payload = JSON.parse(Buffer.from(original.payloadBase64, 'base64').toString('utf8'));
    expect(() =>
      parse([makeRawRecord({ ...original, payload, event: 'hosted_http_response_retained' })])
    ).toThrow('outer_binding');
    changeResponse(input.records, { responseHeaders: [['set-cookie', 'redacted']] });
    expect(() => parse(input.records)).toThrow('header');
    const invalid = fixture();
    const submitted = JSON.parse(reply('applied').requestBytes.toString());
    submitted.extra = 'not-in-ten-field-contract';
    replaceRequest(invalid, Buffer.from(JSON.stringify(submitted)));
    expect(joint(invalid).status).toBe('incomplete');
  });
});

describe('P1 assembly and legacy preservation', () => {
  it('parses every native family before HTTP derivation and exposes typed P1 facts at the P2-B gate', () => {
    const input = fixture();
    let failure: unknown;
    try {
      assembleEvidence({ ...input, httpAdmissions: input.admissions });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(P1ScenarioEvidencePending);
    expect((failure as P1ScenarioEvidencePending).p1.status).toBe('joined');
    expect((failure as P1ScenarioEvidencePending).missing).toContain(
      'owner-wal-disk-custody-and-verified-native-corpus'
    );
    expect(() => deriveEvidence(input.raw, controllerNonce, input.outcome)).toThrow();
    expect(() => assembleEvidence(input)).toThrow('admission_missing');
    // The final capture family fails even though the earlier P1 operation is otherwise complete.
    input.captures.protectedEffectLedgerPath = [Buffer.from('broken')];
    expect(() => assembleEvidence({ ...input, httpAdmissions: input.admissions })).toThrow(
      'capture_disagreement'
    );
  });

  it('requires Owner FD8 recorder identities while retaining the old OpenCode writer branch', () => {
    const input = fixture();
    expect(
      parseRawFiles(input.outcome.rawFiles, starts, supervisorStart).opencode.producerStartTokens
    ).toEqual([owner.startToken]);
    const legacy = structuredClone(input.outcome.rawFiles);
    Object.assign(legacy.opencode, {
      producerStartTokens: [peer.startToken],
      producerPidfdInodes: [peer.pidfdInode],
    });
    expect(parseRawFiles(legacy, starts, supervisorStart).opencode.producerStartTokens).toEqual([
      peer.startToken,
    ]);
    Object.assign(input.outcome.rawFiles.opencode, {
      producerStartTokens: [peer.startToken],
      producerPidfdInodes: [peer.pidfdInode],
    });
    expect(() => joint(input)).toThrow('recorder_writer');
  });

  it('keeps a legacy browser observation in its own union branch and rejects widened legacy envelopes', () => {
    const identity = {
      lane: P3C_LANE,
      controllerNonce,
      harnessRunId: runId,
      authenticatedActorTeamId: `team_${'1'.repeat(32)}`,
      targetTeamId: `team_${'1'.repeat(32)}`,
      targetTeamRunId: `run_${'2'.repeat(32)}`,
      approvalId: `approval_${'3'.repeat(32)}`,
      generationId: 'generation_fixture',
      idempotencyKey: 'request_1',
      previewRef: 'approval_preview_fixture',
      decision: 'allow' as const,
    };
    const payload = makeSemanticPayload({
      origin: 'browser',
      row: context.row,
      event: 'allow_submitted',
      identity,
    });
    const record = makeRawRecord({
      controllerNonce,
      origin: 'browser',
      row: context.row,
      sequence: 1,
      monotonicNs: '20',
      processStartToken: starts.find(({ role }) => role === 'browser')!.startToken,
      event: 'allow_submitted',
      correlation: hex(2),
      effectCount: 0,
      payload,
    });
    expect(parseRawOrigin(ledger([record]), 'browser', controllerNonce)[0]!.kind).toBe('legacy');
    const large = {
      ...payload,
      recordBase64: Buffer.alloc(1024 * 1024 + 1, 0x61).toString('base64'),
    };
    expect(() =>
      parseRawOrigin(
        ledger([makeRawRecord({ ...record, payload: large })]),
        'browser',
        controllerNonce
      )
    ).toThrow();
  });
});
