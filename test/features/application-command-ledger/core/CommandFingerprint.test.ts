import {
  buildCommandFingerprintPreimage,
  buildCommandFingerprintRecord,
  COMMAND_IDEMPOTENCY_SCOPE,
  type CommandClaimRecord,
  type CommandDescriptor,
  CommandFingerprintContractError,
  type CommandFingerprintRecord,
  createCommandClaimScope,
  encodeCommandFingerprintPreimage,
  encodeLengthDelimitedValue,
  HMAC_SHA256_LD_V1,
  type NormalizedCommandIntent,
  prepareCommandFingerprint,
  resolveCommandClaim,
  selectCommandFingerprintKeyVersion,
} from '@features/application-command-ledger';
import { describe, expect, it } from 'vitest';

describe('hmac-sha256-ld-v1 fingerprint contract', () => {
  it('matches the immutable Phase 0 length-delimited preimage oracle', () => {
    const preimage = buildCommandFingerprintPreimage(makeDescriptor(), {
      teamId: 'team_雪',
      taskId: 'task_é',
      expectedTeamRevision: 9007199254740991,
      taskIntentDigest: 'sha256:cccc',
    });

    expect(encodeCommandFingerprintPreimage(preimage)).toBe(
      'o:7:17:s:12:descriptorId16:s:11:task.create22:s:17:descriptorVersion5:i:1:115:s:10:effectPlan159:a:1:151:o:4:12:s:8:effectId17:s:12:persist-task18:s:13:effectVersion5:i:1:126:s:21:evidenceSchemaVersion5:i:1:118:s:13:recoveryClass24:s:19:transactional_local22:s:17:effectPlanVersion5:i:1:123:s:18:fingerprintVersion22:s:17:hmac-sha256-ld-v110:s:6:intent154:o:4:25:s:20:expectedTeamRevision21:i:16:900719925474099110:s:6:taskId11:s:7:task_é21:s:16:taskIntentDigest16:s:11:sha256:cccc10:s:6:teamId12:s:8:team_雪18:s:13:schemaVersion5:i:1:1'
    );
  });

  it('is independent of object key order while preserving array order and Unicode bytes', () => {
    const first = {
      label: '雪é',
      attachments: ['sha256:one', 'sha256:two'],
      nested: { beta: 2, alpha: 1 },
    };
    const reordered = {
      nested: { alpha: 1, beta: 2 },
      attachments: ['sha256:one', 'sha256:two'],
      label: '雪é',
    };

    expect(encodeLengthDelimitedValue(first)).toBe(encodeLengthDelimitedValue(reordered));
    expect(encodeLengthDelimitedValue({ value: ['one', 'two'] })).not.toBe(
      encodeLengthDelimitedValue({ value: ['two', 'one'] })
    );
    expect(encodeLengthDelimitedValue('雪é')).toBe('s:5:雪é');
    expect(encodeLengthDelimitedValue('😀')).toBe('s:4:😀');
    expect(encodeLengthDelimitedValue('é')).not.toBe(encodeLengthDelimitedValue('e\u0301'));
  });

  it('distinguishes omitted, explicit default, and null normalized intent', () => {
    const omitted = encodeLengthDelimitedValue({ teamId: 'team-1' });
    const materializedDefault = encodeLengthDelimitedValue({ teamId: 'team-1', effort: 'medium' });
    const explicitNull = encodeLengthDelimitedValue({ teamId: 'team-1', effort: null });

    expect(new Set([omitted, materializedDefault, explicitNull]).size).toBe(3);
  });

  it('uses a deterministic locale-independent encoding for finite fractional numbers and -0', () => {
    expect(encodeLengthDelimitedValue(1.5)).toBe('d:3:1.5');
    expect(encodeLengthDelimitedValue(0.000001)).toBe('d:8:0.000001');
    expect(encodeLengthDelimitedValue(5e-324)).toBe('d:6:5e-324');
    expect(encodeLengthDelimitedValue(-0)).toBe('d:2:-0');
    expect(encodeLengthDelimitedValue(-0)).not.toBe(encodeLengthDelimitedValue(0));
  });

  it('retains an own __proto__ intent field without mutating the frozen projection', () => {
    const intent = Object.create(null) as Record<string, string>;
    intent.__proto__ = 'literal-intent-value';
    const preimage = buildCommandFingerprintPreimage(
      makeDescriptor(),
      intent as NormalizedCommandIntent
    );

    expect(Object.hasOwn(preimage.intent, '__proto__')).toBe(true);
    expect(preimage.intent.__proto__).toBe('literal-intent-value');
    expect(Object.getPrototypeOf(preimage.intent)).toBeNull();
  });

  it('lets an explicit projection materialize defaults before identity is encoded', () => {
    interface LaunchInput {
      teamId: string;
      effort?: 'medium';
      note?: string | null;
    }
    const descriptor = makeDescriptor<LaunchInput>({
      descriptorId: 'team.launch',
      commandKind: 'team.launch',
      normalizedIntentProjection: (input) => ({
        teamId: input.teamId,
        effort: input.effort ?? 'medium',
        ...(Object.hasOwn(input, 'note') ? { note: input.note as string | null } : {}),
      }),
    });

    const omittedDefault = prepareCommandFingerprint(descriptor, { teamId: 'team-1' });
    const explicitDefault = prepareCommandFingerprint(descriptor, {
      teamId: 'team-1',
      effort: 'medium',
    });
    const explicitNull = prepareCommandFingerprint(descriptor, { teamId: 'team-1', note: null });

    expect(omittedDefault.encodedPreimage).toBe(explicitDefault.encodedPreimage);
    expect(explicitNull.encodedPreimage).not.toBe(omittedDefault.encodedPreimage);
    expect(Object.isFrozen(omittedDefault.preimage.intent)).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['bigint', BigInt(1)],
    ['function', () => true],
    ['symbol', Symbol('intent')],
    ['unpaired high surrogate', '\ud800'],
    ['unpaired low surrogate', '\udc00'],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['unsafe positive integer', Number.MAX_SAFE_INTEGER + 1],
    ['unsafe negative integer', Number.MIN_SAFE_INTEGER - 1],
    ['date', new Date('2026-07-19T00:00:00.000Z')],
    ['map', new Map([['key', 'value']])],
  ])('rejects unsupported %s values', (_label, value) => {
    expect(() => encodeLengthDelimitedValue(value)).toThrowError(
      expect.objectContaining<Partial<CommandFingerprintContractError>>({
        code: 'invalid_fingerprint_input',
      })
    );
  });

  it('rejects undefined members, sparse arrays, extra array properties, symbols, and cycles', () => {
    expect(() => encodeLengthDelimitedValue({ value: undefined })).toThrowError(/Unsupported/);
    expect(() => encodeLengthDelimitedValue([1, undefined])).toThrowError(/Unsupported/);

    const sparse = new Array(2);
    sparse[1] = 'present';
    expect(() => encodeLengthDelimitedValue(sparse)).toThrowError(/holes/);

    const extended = ['value'] as string[] & { label?: string };
    extended.label = 'unexpected';
    expect(() => encodeLengthDelimitedValue(extended)).toThrowError(/extra properties/);

    const symbolObject = { value: 'safe', [Symbol('hidden')]: 'unsafe' };
    expect(() => encodeLengthDelimitedValue(symbolObject)).toThrowError(/symbol keys/);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => encodeLengthDelimitedValue(cyclic)).toThrowError(/cyclic/);
  });

  it('rejects accessor and non-enumerable properties without invoking them', () => {
    let getterCalls = 0;
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'unsafe';
      },
    });
    expect(() => encodeLengthDelimitedValue(accessor)).toThrowError(/enumerable data properties/);
    expect(getterCalls).toBe(0);

    const accessorArray = ['safe'];
    Object.defineProperty(accessorArray, '0', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'unsafe';
      },
    });
    expect(() => encodeLengthDelimitedValue(accessorArray)).toThrowError(/enumerable data items/);
    expect(getterCalls).toBe(0);

    const hidden = { visible: true };
    Object.defineProperty(hidden, 'hidden', { enumerable: false, value: 'unsafe' });
    expect(() => encodeLengthDelimitedValue(hidden)).toThrowError(/enumerable data properties/);
  });

  it('wraps projection failures and rejects non-object or invalid projections', () => {
    const failure = new Error('projection failed');
    const throwing = makeDescriptor({
      normalizedIntentProjection: () => {
        throw failure;
      },
    });
    expect(() => prepareCommandFingerprint(throwing, {})).toThrowError(
      expect.objectContaining<Partial<CommandFingerprintContractError>>({
        code: 'intent_projection_failed',
        cause: failure,
      })
    );

    const arrayProjection = makeDescriptor({
      normalizedIntentProjection: () => [] as unknown as NormalizedCommandIntent,
    });
    expect(() => prepareCommandFingerprint(arrayProjection, {})).toThrowError(/plain data object/);

    const undefinedProjection = makeDescriptor({
      normalizedIntentProjection: () =>
        ({ value: undefined }) as unknown as NormalizedCommandIntent,
    });
    expect(() => prepareCommandFingerprint(undefinedProjection, {})).toThrowError(/Unsupported/);
  });

  it('builds the exact safe persisted fingerprint record without retaining intent', () => {
    const preimage = buildCommandFingerprintPreimage(makeDescriptor(), { taskId: 'task-1' });
    const record = buildCommandFingerprintRecord(
      preimage,
      'command-key-v1',
      '0123456789abcdef'.repeat(4)
    );

    expect(record).toEqual({
      descriptorId: 'task.create',
      descriptorVersion: 1,
      schemaVersion: 1,
      fingerprintVersion: HMAC_SHA256_LD_V1,
      effectPlanVersion: 1,
      keyVersion: 'command-key-v1',
      digest: '0123456789abcdef'.repeat(4),
    });
    expect(Object.keys(record)).toEqual([
      'descriptorId',
      'descriptorVersion',
      'schemaVersion',
      'fingerprintVersion',
      'effectPlanVersion',
      'keyVersion',
      'digest',
    ]);
    expect(Object.isFrozen(record)).toBe(true);
  });

  it.each(['', 'ABCDEF'.repeat(10) + 'ABCD', 'a'.repeat(63), 'a'.repeat(65), 'z'.repeat(64)])(
    'rejects an invalid persisted digest: %s',
    (digest) => {
      const preimage = buildCommandFingerprintPreimage(makeDescriptor(), { taskId: 'task-1' });
      expect(() => buildCommandFingerprintRecord(preimage, 'command-key-v1', digest)).toThrowError(
        expect.objectContaining<Partial<CommandFingerprintContractError>>({
          code: 'invalid_fingerprint_record',
        })
      );
    }
  );

  it('binds ordered effect ids, versions, recovery classes, and evidence versions to intent', () => {
    const input = { taskId: 'task-1' };
    const baselineEffect = makeDescriptor().effects[0];
    const baseline = prepareCommandFingerprint(makeDescriptor(), input).encodedPreimage;
    const changes: CommandDescriptor[] = [
      makeDescriptor({ effects: [{ ...baselineEffect, effectId: 'persist-task-v2' }] }),
      makeDescriptor({ effects: [{ ...baselineEffect, effectVersion: 2 }] }),
      makeDescriptor({ effects: [{ ...baselineEffect, recoveryClass: 'non_reconcilable' }] }),
      makeDescriptor({ effects: [{ ...baselineEffect, evidenceSchemaVersion: 2 }] }),
      makeDescriptor({
        effects: [
          { ...baselineEffect, effectId: 'first' },
          { ...baselineEffect, effectId: 'second' },
        ],
      }),
      makeDescriptor({
        effects: [
          { ...baselineEffect, effectId: 'second' },
          { ...baselineEffect, effectId: 'first' },
        ],
      }),
    ];

    for (const descriptor of changes) {
      expect(prepareCommandFingerprint(descriptor, input).encodedPreimage).not.toBe(baseline);
    }
    expect(prepareCommandFingerprint(changes[4], input).encodedPreimage).not.toBe(
      prepareCommandFingerprint(changes[5], input).encodedPreimage
    );
  });
});

describe('durable command claim identity', () => {
  const scope = createCommandClaimScope({
    deploymentId: 'deployment-1',
    stableActorId: 'operator-1',
    commandKind: 'task.create',
    idempotencyKey: 'idempotency-1',
  });

  it('uses exactly deployment, stable actor, command kind, and idempotency key', () => {
    expect(scope).toEqual({
      deploymentId: 'deployment-1',
      stableActorId: 'operator-1',
      commandKind: 'task.create',
      idempotencyKey: 'idempotency-1',
    });
    expect(Object.keys(scope)).toEqual([
      'deploymentId',
      'stableActorId',
      'commandKind',
      'idempotencyKey',
    ]);
    expect(Object.isFrozen(scope)).toBe(true);
  });

  it('creates one claim and converges an identical versioned digest with no effect', () => {
    const incoming = claimRecord(scope, fingerprint());

    expect(resolveCommandClaim(null, incoming)).toMatchObject({
      outcome: 'claimed',
      claimAction: 'create',
      effectAction: 'none',
    });
    const converged = resolveCommandClaim(incoming, claimRecord(scope, fingerprint()));
    expect(converged).toMatchObject({
      outcome: 'same_intent',
      claimAction: 'reuse',
      effectAction: 'none',
      record: incoming,
    });
  });

  it.each([
    ['descriptor', { descriptorId: 'task.create.v2' }],
    ['descriptor version', { descriptorVersion: 2 }],
    ['schema', { schemaVersion: 2 }],
    ['effect plan version', { effectPlanVersion: 2 }],
    ['key version', { keyVersion: 'command-key-v2' }],
    ['digest', { digest: 'b'.repeat(64) }],
  ])('returns typed idempotency_mismatch and zero effect for a changed %s', (_label, change) => {
    const existing = claimRecord(scope, fingerprint());
    const requested = claimRecord(scope, fingerprint(change));
    const resolution = resolveCommandClaim(existing, requested);

    expect(resolution).toMatchObject({
      outcome: 'idempotency_mismatch',
      claimAction: 'reject',
      effectAction: 'none',
      record: existing,
      mismatch: {
        code: 'idempotency_mismatch',
        existingFingerprint: existing.fingerprint,
        requestedFingerprint: requested.fingerprint,
      },
    });
  });

  it('reuses a retained key version across active-key rotation', () => {
    const existing = claimRecord(scope, fingerprint({ keyVersion: 'command-key-v1' }));

    expect(selectCommandFingerprintKeyVersion(null, 'command-key-v2')).toBe('command-key-v2');
    expect(
      resolveCommandClaim(
        existing,
        claimRecord(scope, fingerprint({ keyVersion: 'command-key-v2' }))
      )
    ).toMatchObject({ outcome: 'idempotency_mismatch', effectAction: 'none' });
    const comparisonKeyVersion = selectCommandFingerprintKeyVersion(existing, 'command-key-v2');
    expect(comparisonKeyVersion).toBe('command-key-v1');
    expect(
      resolveCommandClaim(
        existing,
        claimRecord(scope, fingerprint({ keyVersion: comparisonKeyVersion }))
      )
    ).toMatchObject({ outcome: 'same_intent', effectAction: 'none' });
  });

  it('fails closed when a caller compares records from different claim scopes', () => {
    const existing = claimRecord(scope, fingerprint());
    for (const changedScope of [
      { ...scope, deploymentId: 'deployment-2' },
      { ...scope, stableActorId: 'operator-2' },
      { ...scope, commandKind: 'task.update' },
      { ...scope, idempotencyKey: 'idempotency-2' },
    ]) {
      expect(() =>
        resolveCommandClaim(existing, claimRecord(changedScope, fingerprint()))
      ).toThrowError(
        expect.objectContaining<Partial<CommandFingerprintContractError>>({
          code: 'invalid_claim_scope',
        })
      );
    }
  });

  it.each([
    { deploymentId: '' },
    { stableActorId: ' ' },
    { commandKind: '' },
    { idempotencyKey: '' },
  ])('rejects malformed claim scope: %o', (change) => {
    expect(() => createCommandClaimScope({ ...scope, ...change })).toThrowError(
      expect.objectContaining<Partial<CommandFingerprintContractError>>({
        code: 'invalid_claim_scope',
      })
    );
  });
});

function makeDescriptor<TInput = unknown>(
  overrides: Partial<CommandDescriptor<TInput>> = {}
): CommandDescriptor<TInput> {
  return {
    descriptorId: 'task.create',
    descriptorVersion: 1,
    commandKind: 'task.create',
    inputSchemaVersion: 1,
    fingerprintVersion: HMAC_SHA256_LD_V1,
    effectPlanVersion: 1,
    idempotencyScope: COMMAND_IDEMPOTENCY_SCOPE,
    retentionClass: 'operator-command',
    normalizedIntentProjection: (input) => input as NormalizedCommandIntent,
    effects: [
      {
        effectId: 'persist-task',
        effectVersion: 1,
        recoveryClass: 'transactional_local',
        evidenceSchemaVersion: 1,
      },
    ],
    ...overrides,
  };
}

function fingerprint(overrides: Partial<CommandFingerprintRecord> = {}): CommandFingerprintRecord {
  return {
    descriptorId: 'task.create',
    descriptorVersion: 1,
    schemaVersion: 1,
    fingerprintVersion: HMAC_SHA256_LD_V1,
    effectPlanVersion: 1,
    keyVersion: 'command-key-v1',
    digest: 'a'.repeat(64),
    ...overrides,
  };
}

function claimRecord<TCommandKind extends string>(
  claimScope: CommandClaimRecord<TCommandKind>['scope'],
  commandFingerprint: CommandFingerprintRecord
): CommandClaimRecord<TCommandKind> {
  return { scope: claimScope, fingerprint: commandFingerprint };
}
