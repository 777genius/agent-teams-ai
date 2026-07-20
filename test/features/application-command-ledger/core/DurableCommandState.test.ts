import {
  classifyAmbiguousEffect,
  COMMAND_IDEMPOTENCY_SCOPE,
  type CommandDescriptor,
  commitDurableCommand,
  createDurableCommandDescriptorIdentity,
  createInitialEffectPlan,
  DURABLE_COMMAND_STATES,
  DURABLE_EFFECT_STATES,
  type DurableCommandDescriptorIdentity,
  type DurableCommandState,
  DurableCommandStateTransitionError,
  type DurableEffectPlanItem,
  type DurableEffectState,
  EFFECT_RECOVERY_CLASSES,
  type EffectDescriptor,
  type EffectRecoveryClass,
  HMAC_SHA256_LD_V1,
  resolveAmbiguousDurableEffect,
  retryDurableEffectAfterObservedAbsent,
  transitionDurableCommandState,
  transitionDurableEffectState,
  type ValidatedDurableEffectEvidence,
} from '@features/application-command-ledger';
import { describe, expect, it } from 'vitest';

const VALID_COMMAND_TRANSITIONS = [
  ['prepared', 'running'],
  ['prepared', 'failed'],
  ['running', 'recovering'],
  ['recovering', 'failed'],
  ['recovering', 'operator_required'],
] as const satisfies readonly (readonly [DurableCommandState, DurableCommandState])[];

const VALID_EFFECT_TRANSITIONS = [
  ['not_started', 'attempting'],
  ['attempting', 'observed_succeeded'],
  ['attempting', 'observed_absent'],
  ['attempting', 'ambiguous'],
  ['observed_succeeded', 'compensating'],
  ['compensating', 'compensated'],
  ['compensating', 'ambiguous'],
] as const satisfies readonly (readonly [DurableEffectState, DurableEffectState])[];

describe('durable command states', () => {
  it('freezes exactly the admitted command states', () => {
    expect(DURABLE_COMMAND_STATES).toEqual([
      'prepared',
      'running',
      'committed',
      'recovering',
      'failed',
      'operator_required',
    ]);
    expect(Object.isFrozen(DURABLE_COMMAND_STATES)).toBe(true);
  });

  it.each(VALID_COMMAND_TRANSITIONS)('admits %s -> %s', (current, next) => {
    expect(transitionDurableCommandState(current, next)).toBe(next);
  });

  it('requires prepared commands to enter running before committed', () => {
    expect(() => transitionDurableCommandState('prepared', 'committed')).toThrowError(
      expect.objectContaining<Partial<DurableCommandStateTransitionError>>({
        code: 'invalid_command_transition',
        details: { current: 'prepared', next: 'committed' },
      })
    );
  });

  it('removes every unconditional committed edge from the generic transition API', () => {
    expect(() => transitionDurableCommandState('running', 'committed')).toThrowError(
      expect.objectContaining<Partial<DurableCommandStateTransitionError>>({
        code: 'invalid_command_transition',
      })
    );
    expect(() => transitionDurableCommandState('recovering', 'committed')).toThrowError(
      expect.objectContaining<Partial<DurableCommandStateTransitionError>>({
        code: 'invalid_command_transition',
      })
    );
  });

  it('fails closed for every self, backward, terminal, or otherwise undeclared transition', () => {
    const admitted = new Set(
      VALID_COMMAND_TRANSITIONS.map(([current, next]) => `${current}:${next}`)
    );
    for (const current of DURABLE_COMMAND_STATES) {
      for (const next of DURABLE_COMMAND_STATES) {
        if (admitted.has(`${current}:${next}`)) continue;
        expect(() => transitionDurableCommandState(current, next)).toThrowError(
          expect.objectContaining<Partial<DurableCommandStateTransitionError>>({
            code: 'invalid_command_transition',
            details: { current, next },
          })
        );
      }
    }
  });

  it('fails closed for unknown command states at runtime', () => {
    expect(() =>
      transitionDurableCommandState('queued' as DurableCommandState, 'running')
    ).toThrowError(
      expect.objectContaining<Partial<DurableCommandStateTransitionError>>({
        code: 'invalid_command_transition',
      })
    );
  });
});

describe('guarded durable command commit', () => {
  it.each(['running', 'recovering'] as const)(
    'commits a %s command only when its exact ordered plan is fully observed_succeeded',
    (current) => {
      const descriptor = makeDescriptor([
        makeEffect({ effectId: 'write-config', recoveryClass: 'transactional_local' }),
        makeEffect({
          effectId: 'notify-provider',
          recoveryClass: 'idempotent_by_operation_id',
        }),
      ]);
      const identity = createDurableCommandDescriptorIdentity(descriptor);
      const plan = withEffectStates(createInitialEffectPlan(descriptor), [
        'observed_succeeded',
        'observed_succeeded',
      ]);

      expect(commitDurableCommand(current, descriptor, identity, plan)).toBe('committed');
      expect(Object.isFrozen(identity)).toBe(true);
    }
  );

  it.each([
    'not_started',
    'attempting',
    'observed_absent',
    'ambiguous',
    'compensating',
    'compensated',
  ] as const)('fails closed when one declared effect remains %s', (blockedState) => {
    const descriptor = makeDescriptor([
      makeEffect({ effectId: 'first' }),
      makeEffect({ effectId: 'second' }),
    ]);
    const plan = withEffectStates(createInitialEffectPlan(descriptor), [
      'observed_succeeded',
      blockedState,
    ]);

    expect(() =>
      commitDurableCommand(
        'running',
        descriptor,
        createDurableCommandDescriptorIdentity(descriptor),
        plan
      )
    ).toThrowError(
      expect.objectContaining<Partial<DurableCommandStateTransitionError>>({
        code: 'invalid_command_transition',
        details: expect.objectContaining({
          effectId: 'second',
          ordinal: 1,
          effectState: blockedState,
        }),
      })
    );
  });

  it.each(['prepared', 'committed', 'failed', 'operator_required'] as const)(
    'never commits from command state %s',
    (current) => {
      const descriptor = makeDescriptor([makeEffect()]);
      const plan = withEffectStates(createInitialEffectPlan(descriptor), ['observed_succeeded']);

      expect(() =>
        commitDurableCommand(
          current,
          descriptor,
          createDurableCommandDescriptorIdentity(descriptor),
          plan
        )
      ).toThrowError(
        expect.objectContaining<Partial<DurableCommandStateTransitionError>>({
          code: 'invalid_command_transition',
          details: { current, next: 'committed' },
        })
      );
    }
  );

  it('rejects a duplicate, missing, extra, reordered, or otherwise changed persisted effect', () => {
    const descriptor = makeDescriptor([
      makeEffect({ effectId: 'first' }),
      makeEffect({
        effectId: 'second',
        effectVersion: 2,
        recoveryClass: 'reconcilable_by_unique_evidence',
        evidenceSchemaVersion: 3,
      }),
    ]);
    const identity = createDurableCommandDescriptorIdentity(descriptor);
    const exactPlan = withEffectStates(createInitialEffectPlan(descriptor), [
      'observed_succeeded',
      'observed_succeeded',
    ]);
    const changedPlans: readonly (readonly DurableEffectPlanItem[])[] = [
      [exactPlan[0], { ...exactPlan[0], ordinal: 1 }],
      [exactPlan[0]],
      [...exactPlan, { ...exactPlan[1], ordinal: 2, effectId: 'extra' }],
      [exactPlan[1], exactPlan[0]],
      [exactPlan[0], { ...exactPlan[1], effectId: 'changed' }],
      [exactPlan[0], { ...exactPlan[1], effectVersion: 3 }],
      [exactPlan[0], { ...exactPlan[1], recoveryClass: 'compensatable' }],
      [exactPlan[0], { ...exactPlan[1], evidenceSchemaVersion: 4 }],
      [exactPlan[0], { ...exactPlan[1], ordinal: 0 }],
    ];

    for (const plan of changedPlans) {
      expect(() => commitDurableCommand('running', descriptor, identity, plan)).toThrowError(
        expect.objectContaining<Partial<DurableCommandStateTransitionError>>({
          code: 'invalid_effect_plan',
        })
      );
    }
  });

  it.each([
    ['descriptorId', 'team.update.v2'],
    ['descriptorVersion', 2],
    ['commandKind', 'team.delete'],
    ['inputSchemaVersion', 2],
    ['fingerprintVersion', 'hmac-sha256-ld-v2'],
    ['effectPlanVersion', 2],
  ] as const)('rejects a mismatched persisted %s identity', (field, value) => {
    const descriptor = makeDescriptor([makeEffect()]);
    const identity = {
      ...createDurableCommandDescriptorIdentity(descriptor),
      [field]: value,
    } as DurableCommandDescriptorIdentity;
    const plan = withEffectStates(createInitialEffectPlan(descriptor), ['observed_succeeded']);

    expect(() => commitDurableCommand('running', descriptor, identity, plan)).toThrowError(
      expect.objectContaining<Partial<DurableCommandStateTransitionError>>({
        code: 'invalid_effect_plan',
      })
    );
  });
});

describe('durable effect states and recovery classes', () => {
  it('freezes exactly the admitted recovery classes and effect states', () => {
    expect(EFFECT_RECOVERY_CLASSES).toEqual([
      'transactional_local',
      'idempotent_by_operation_id',
      'reconcilable_by_unique_evidence',
      'compensatable',
      'non_reconcilable',
    ]);
    expect(DURABLE_EFFECT_STATES).toEqual([
      'not_started',
      'attempting',
      'observed_succeeded',
      'observed_absent',
      'ambiguous',
      'compensating',
      'compensated',
    ]);
    expect(Object.isFrozen(EFFECT_RECOVERY_CLASSES)).toBe(true);
    expect(Object.isFrozen(DURABLE_EFFECT_STATES)).toBe(true);
  });

  it.each(VALID_EFFECT_TRANSITIONS)(
    'admits %s -> %s for a compensatable effect',
    (current, next) => {
      expect(transitionDurableEffectState(makeEffect(), current, next)).toBe(next);
    }
  );

  it('admits the forward observation transitions for every recovery class', () => {
    for (const recoveryClass of EFFECT_RECOVERY_CLASSES) {
      const effect = makeEffect({ recoveryClass });
      expect(transitionDurableEffectState(effect, 'not_started', 'attempting')).toBe('attempting');
      for (const observed of ['observed_succeeded', 'observed_absent', 'ambiguous'] as const) {
        expect(transitionDurableEffectState(effect, 'attempting', observed)).toBe(observed);
      }
    }
  });

  it('fails closed for undeclared effect transitions', () => {
    const admitted = new Set(
      VALID_EFFECT_TRANSITIONS.map(([current, next]) => `${current}:${next}`)
    );
    const compensatable = makeEffect();
    for (const current of DURABLE_EFFECT_STATES) {
      for (const next of DURABLE_EFFECT_STATES) {
        if (admitted.has(`${current}:${next}`)) continue;
        expect(() => transitionDurableEffectState(compensatable, current, next)).toThrowError(
          expect.objectContaining<Partial<DurableCommandStateTransitionError>>({
            code: 'invalid_effect_transition',
          })
        );
      }
    }
  });

  it('permits compensation states only for compensatable effects', () => {
    for (const recoveryClass of EFFECT_RECOVERY_CLASSES.filter(
      (candidate) => candidate !== 'compensatable'
    )) {
      const effect = makeEffect({ recoveryClass });
      expect(() =>
        transitionDurableEffectState(effect, 'observed_succeeded', 'compensating')
      ).toThrowError(/Only compensatable/);
      expect(() =>
        transitionDurableEffectState(effect, 'compensating', 'compensated')
      ).toThrowError(/Only compensatable/);
    }
  });

  it('resolves validated ambiguity under the exact descriptor for every reconcilable class', () => {
    for (const recoveryClass of EFFECT_RECOVERY_CLASSES) {
      const effect = makeEffect({ recoveryClass });
      for (const outcome of ['observed_succeeded', 'observed_absent'] as const) {
        const evidence = makeEvidence(effect, outcome);
        if (recoveryClass === 'non_reconcilable') {
          expect(() => resolveAmbiguousDurableEffect(effect, 'ambiguous', evidence)).toThrowError(
            expect.objectContaining<Partial<DurableCommandStateTransitionError>>({
              code: 'invalid_effect_transition',
            })
          );
        } else {
          expect(resolveAmbiguousDurableEffect(effect, 'ambiguous', evidence)).toBe(outcome);
        }
      }
    }
  });

  it('retries proven absence only for the explicit recovery-class matrix', () => {
    for (const recoveryClass of EFFECT_RECOVERY_CLASSES) {
      const effect = makeEffect({ recoveryClass });
      if (recoveryClass === 'non_reconcilable') {
        expect(() => retryDurableEffectAfterObservedAbsent(effect, 'observed_absent')).toThrowError(
          expect.objectContaining<Partial<DurableCommandStateTransitionError>>({
            code: 'invalid_effect_transition',
          })
        );
      } else {
        expect(retryDurableEffectAfterObservedAbsent(effect, 'observed_absent')).toBe('attempting');
      }
    }
  });

  it('does not let the generic state transition API bypass evidence or absent-retry guards', () => {
    for (const recoveryClass of EFFECT_RECOVERY_CLASSES) {
      const effect = makeEffect({ recoveryClass });
      expect(() =>
        transitionDurableEffectState(effect, 'ambiguous', 'observed_succeeded')
      ).toThrowError(/not allowed/);
      expect(() =>
        transitionDurableEffectState(effect, 'ambiguous', 'observed_absent')
      ).toThrowError(/not allowed/);
      expect(() =>
        transitionDurableEffectState(effect, 'observed_absent', 'attempting')
      ).toThrowError(/not allowed/);
    }
  });

  it('rejects stale, changed, or malformed evidence and non-ambiguous resolution', () => {
    const effect = makeEffect({ recoveryClass: 'reconcilable_by_unique_evidence' });
    for (const evidence of [
      makeEvidence({ ...effect, effectId: 'other-effect' }, 'observed_succeeded'),
      makeEvidence({ ...effect, effectVersion: 2 }, 'observed_succeeded'),
      makeEvidence(
        { ...effect, recoveryClass: 'idempotent_by_operation_id' },
        'observed_succeeded'
      ),
      makeEvidence({ ...effect, evidenceSchemaVersion: 2 }, 'observed_succeeded'),
    ]) {
      expect(() => resolveAmbiguousDurableEffect(effect, 'ambiguous', evidence)).toThrowError(
        /does not match/
      );
    }
    expect(() =>
      resolveAmbiguousDurableEffect(
        effect,
        'attempting',
        makeEvidence(effect, 'observed_succeeded')
      )
    ).toThrowError(/requires an ambiguous/);
    expect(() => retryDurableEffectAfterObservedAbsent(effect, 'ambiguous')).toThrowError(
      /requires proven/
    );
  });

  it('creates a frozen ordered initial effect plan with persisted versions', () => {
    const descriptor = makeDescriptor([
      makeEffect({
        effectId: 'write-config',
        effectVersion: 2,
        recoveryClass: 'reconcilable_by_unique_evidence',
        evidenceSchemaVersion: 3,
      }),
      makeEffect({
        effectId: 'notify-provider',
        effectVersion: 4,
        recoveryClass: 'idempotent_by_operation_id',
        evidenceSchemaVersion: 5,
      }),
    ]);

    const plan = createInitialEffectPlan(descriptor);

    expect(plan).toEqual([
      {
        ordinal: 0,
        effectId: 'write-config',
        effectVersion: 2,
        recoveryClass: 'reconcilable_by_unique_evidence',
        evidenceSchemaVersion: 3,
        state: 'not_started',
      },
      {
        ordinal: 1,
        effectId: 'notify-provider',
        effectVersion: 4,
        recoveryClass: 'idempotent_by_operation_id',
        evidenceSchemaVersion: 5,
        state: 'not_started',
      },
    ]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan.every(Object.isFrozen)).toBe(true);
  });

  it('rejects empty, duplicate, unsupported, and unversioned effect plans', () => {
    expect(() => createInitialEffectPlan(makeDescriptor([]))).toThrowError(
      expect.objectContaining<Partial<DurableCommandStateTransitionError>>({
        code: 'invalid_effect_plan',
      })
    );
    expect(() =>
      createInitialEffectPlan(makeDescriptor([makeEffect(), makeEffect()]))
    ).toThrowError(/must be unique/);
    expect(() =>
      createInitialEffectPlan(makeDescriptor([makeEffect({ effectVersion: 0 })]))
    ).toThrowError(/positive safe integer/);
    expect(() =>
      createInitialEffectPlan(
        makeDescriptor([makeEffect({ recoveryClass: 'unknown' as EffectRecoveryClass })])
      )
    ).toThrowError(
      expect.objectContaining<Partial<DurableCommandStateTransitionError>>({
        code: 'invalid_recovery_class',
      })
    );

    const sparse = new Array<EffectDescriptor>(1);
    expect(() => createInitialEffectPlan(makeDescriptor(sparse))).toThrowError(/data items/);

    let effectGetterCalls = 0;
    const accessorEffects = [makeEffect()];
    Object.defineProperty(accessorEffects, '0', {
      enumerable: true,
      get: () => {
        effectGetterCalls += 1;
        return makeEffect();
      },
    });
    expect(() => createInitialEffectPlan(makeDescriptor(accessorEffects))).toThrowError(
      /data items/
    );
    expect(effectGetterCalls).toBe(0);

    expect(() =>
      createInitialEffectPlan(
        makeDescriptor([{ ...makeEffect(), unknown: true } as unknown as EffectDescriptor])
      )
    ).toThrowError(/unknown/);
  });

  it('routes ambiguous non-reconcilable effects only to operator_required', () => {
    expect(classifyAmbiguousEffect('non_reconcilable')).toEqual({
      commandState: 'operator_required',
      automaticAction: 'none',
    });
    for (const recoveryClass of EFFECT_RECOVERY_CLASSES.filter(
      (candidate) => candidate !== 'non_reconcilable'
    )) {
      expect(classifyAmbiguousEffect(recoveryClass)).toEqual({
        commandState: 'recovering',
        automaticAction: 'require_declared_evidence',
      });
    }
  });
});

function makeEffect(overrides: Partial<EffectDescriptor> = {}): EffectDescriptor {
  return {
    effectId: 'external-effect',
    effectVersion: 1,
    recoveryClass: 'compensatable',
    evidenceSchemaVersion: 1,
    ...overrides,
  };
}

function makeEvidence(
  effect: EffectDescriptor,
  outcome: ValidatedDurableEffectEvidence['outcome']
): ValidatedDurableEffectEvidence {
  return { ...effect, outcome };
}

function withEffectStates(
  plan: readonly DurableEffectPlanItem[],
  states: readonly DurableEffectState[]
): readonly DurableEffectPlanItem[] {
  if (states.length !== plan.length) {
    throw new Error('Test fixture effect states must match the complete plan');
  }
  return plan.map((effect, ordinal) => {
    const state = states.at(ordinal);
    if (!state) throw new Error('Test fixture effect state is missing');
    return { ...effect, state };
  });
}

function makeDescriptor(effects: EffectDescriptor[]): CommandDescriptor {
  return {
    descriptorId: 'team.update',
    descriptorVersion: 1,
    commandKind: 'team.update',
    inputSchemaVersion: 1,
    fingerprintVersion: HMAC_SHA256_LD_V1,
    effectPlanVersion: 1,
    idempotencyScope: COMMAND_IDEMPOTENCY_SCOPE,
    retentionClass: 'operator-command',
    normalizedIntentProjection: (input) => input as Record<string, never>,
    effects: effects as [EffectDescriptor, ...EffectDescriptor[]],
  };
}
