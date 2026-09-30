import {
  type AmbiguousEffectDisposition,
  type CommandDescriptor,
  DURABLE_COMMAND_STATES,
  DURABLE_EFFECT_STATES,
  type DurableCommandDescriptorIdentity,
  type DurableCommandState,
  type DurableEffectPlanItem,
  type DurableEffectState,
  EFFECT_RECOVERY_CLASSES,
  type EffectDescriptor,
  type EffectRecoveryClass,
  HMAC_SHA256_LD_V1,
  type ValidatedDurableEffectEvidence,
} from '../../contracts';

export type DurableCommandStateTransitionErrorCode =
  | 'invalid_command_transition'
  | 'invalid_effect_plan'
  | 'invalid_effect_transition'
  | 'invalid_recovery_class';

export class DurableCommandStateTransitionError extends Error {
  constructor(
    readonly code: DurableCommandStateTransitionErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = 'DurableCommandStateTransitionError';
  }
}

const COMMAND_TRANSITIONS: Readonly<Record<DurableCommandState, readonly DurableCommandState[]>> = {
  prepared: ['running', 'failed'],
  running: ['recovering'],
  committed: [],
  recovering: ['failed', 'operator_required'],
  failed: [],
  operator_required: [],
};

const EFFECT_TRANSITIONS: Readonly<Record<DurableEffectState, readonly DurableEffectState[]>> = {
  not_started: ['attempting'],
  attempting: ['observed_succeeded', 'observed_absent', 'ambiguous'],
  observed_succeeded: ['compensating'],
  observed_absent: [],
  ambiguous: [],
  compensating: ['compensated', 'ambiguous'],
  compensated: [],
};

const EFFECT_DESCRIPTOR_KEYS = [
  'effectId',
  'effectVersion',
  'recoveryClass',
  'evidenceSchemaVersion',
] as const;

const COMMAND_DESCRIPTOR_IDENTITY_KEYS = [
  'descriptorId',
  'descriptorVersion',
  'commandKind',
  'inputSchemaVersion',
  'fingerprintVersion',
  'effectPlanVersion',
] as const;

const DURABLE_EFFECT_PLAN_ITEM_KEYS = [...EFFECT_DESCRIPTOR_KEYS, 'ordinal', 'state'] as const;

const VALIDATED_EFFECT_EVIDENCE_KEYS = [...EFFECT_DESCRIPTOR_KEYS, 'outcome'] as const;

const EVIDENCE_RESOLVABLE_RECOVERY_CLASSES = new Set<EffectRecoveryClass>([
  'transactional_local',
  'idempotent_by_operation_id',
  'reconcilable_by_unique_evidence',
  'compensatable',
]);

const ABSENT_RETRY_RECOVERY_CLASSES = new Set<EffectRecoveryClass>([
  'transactional_local',
  'idempotent_by_operation_id',
  'reconcilable_by_unique_evidence',
  'compensatable',
]);

export function transitionDurableCommandState(
  current: DurableCommandState,
  next: DurableCommandState
): DurableCommandState {
  assertCommandState(current, 'current');
  assertCommandState(next, 'next');
  if (!COMMAND_TRANSITIONS[current].includes(next)) {
    throw new DurableCommandStateTransitionError(
      'invalid_command_transition',
      'Durable command state transition is not allowed',
      { current, next }
    );
  }
  return next;
}

export function createDurableCommandDescriptorIdentity<TCommandKind extends string>(
  descriptor: Pick<
    CommandDescriptor<unknown, TCommandKind>,
    | 'descriptorId'
    | 'descriptorVersion'
    | 'commandKind'
    | 'inputSchemaVersion'
    | 'fingerprintVersion'
    | 'effectPlanVersion'
  >
): DurableCommandDescriptorIdentity<TCommandKind> {
  assertIdentifier(descriptor.descriptorId, 'descriptorId');
  assertPositiveVersion(descriptor.descriptorVersion, 'descriptorVersion');
  assertIdentifier(descriptor.commandKind, 'commandKind');
  assertPositiveVersion(descriptor.inputSchemaVersion, 'inputSchemaVersion');
  if (descriptor.fingerprintVersion !== HMAC_SHA256_LD_V1) {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_plan',
      'Durable command descriptor has an unsupported fingerprint version',
      { fingerprintVersion: descriptor.fingerprintVersion }
    );
  }
  assertPositiveVersion(descriptor.effectPlanVersion, 'effectPlanVersion');

  return Object.freeze({
    descriptorId: descriptor.descriptorId,
    descriptorVersion: descriptor.descriptorVersion,
    commandKind: descriptor.commandKind,
    inputSchemaVersion: descriptor.inputSchemaVersion,
    fingerprintVersion: descriptor.fingerprintVersion,
    effectPlanVersion: descriptor.effectPlanVersion,
  });
}

/**
 * The only immediate-command path to committed. It binds the persisted descriptor identity and
 * ordered effect plan to the exact descriptor and admits commit only after every effect succeeded.
 */
export function commitDurableCommand<TCommandKind extends string>(
  current: DurableCommandState,
  descriptor: Pick<
    CommandDescriptor<unknown, TCommandKind>,
    | 'descriptorId'
    | 'descriptorVersion'
    | 'commandKind'
    | 'inputSchemaVersion'
    | 'fingerprintVersion'
    | 'effectPlanVersion'
    | 'effects'
  >,
  persistedIdentity: DurableCommandDescriptorIdentity<TCommandKind>,
  persistedEffectPlan: readonly DurableEffectPlanItem[]
): 'committed' {
  assertCommandState(current, 'current');
  if (current !== 'running' && current !== 'recovering') {
    throw new DurableCommandStateTransitionError(
      'invalid_command_transition',
      'Only a running or recovering durable command may be committed',
      { current, next: 'committed' }
    );
  }

  const expectedIdentity = createDurableCommandDescriptorIdentity(descriptor);
  assertDurableCommandDescriptorIdentity(persistedIdentity);
  if (!sameCommandDescriptorIdentity(expectedIdentity, persistedIdentity)) {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_plan',
      'Persisted durable command descriptor identity does not match the exact descriptor',
      { expectedIdentity, persistedIdentity }
    );
  }

  const expectedPlan = createInitialEffectPlan(descriptor);
  assertEffectPlanArray(persistedEffectPlan);
  if (persistedEffectPlan.length !== expectedPlan.length) {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_plan',
      'Persisted durable command effect plan length does not match the exact descriptor',
      {
        descriptorId: descriptor.descriptorId,
        expectedLength: expectedPlan.length,
        actualLength: persistedEffectPlan.length,
      }
    );
  }

  for (let ordinal = 0; ordinal < expectedPlan.length; ordinal += 1) {
    const expected = expectedPlan[ordinal];
    const actual = persistedEffectPlan[ordinal];
    assertDurableEffectPlanItem(actual);
    if (!sameEffectPlanIdentity(expected, actual)) {
      throw new DurableCommandStateTransitionError(
        'invalid_effect_plan',
        'Persisted durable command effect does not match the exact ordered descriptor plan',
        {
          descriptorId: descriptor.descriptorId,
          ordinal,
          expectedEffectId: expected.effectId,
          actualEffectId: actual.effectId,
        }
      );
    }
    if (actual.state !== 'observed_succeeded') {
      throw new DurableCommandStateTransitionError(
        'invalid_command_transition',
        'Every declared durable effect must be observed_succeeded before command commit',
        {
          current,
          next: 'committed',
          effectId: actual.effectId,
          ordinal,
          effectState: actual.state,
        }
      );
    }
  }

  return 'committed';
}

export function transitionDurableEffectState(
  descriptor: EffectDescriptor,
  current: DurableEffectState,
  next: DurableEffectState
): DurableEffectState {
  assertEffectDescriptor(descriptor);
  assertEffectState(current, 'current');
  assertEffectState(next, 'next');
  if (!EFFECT_TRANSITIONS[current].includes(next)) {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_transition',
      'Durable effect state transition is not allowed',
      { effectId: descriptor.effectId, current, next }
    );
  }
  if (
    (current === 'observed_succeeded' || current === 'compensating') &&
    descriptor.recoveryClass !== 'compensatable'
  ) {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_transition',
      'Only compensatable effects may enter or complete compensation',
      { effectId: descriptor.effectId, recoveryClass: descriptor.recoveryClass, current, next }
    );
  }
  return next;
}

export function resolveAmbiguousDurableEffect(
  descriptor: EffectDescriptor,
  current: DurableEffectState,
  evidence: ValidatedDurableEffectEvidence
): 'observed_succeeded' | 'observed_absent' {
  assertEffectDescriptor(descriptor);
  assertEffectState(current, 'current');
  assertValidatedEffectEvidence(evidence);
  if (current !== 'ambiguous') {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_transition',
      'Evidence resolution requires an ambiguous durable effect',
      { effectId: descriptor.effectId, current, next: evidence.outcome }
    );
  }
  if (!sameEffectDescriptorIdentity(descriptor, evidence)) {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_transition',
      'Validated evidence does not match the exact durable effect descriptor',
      {
        effectId: descriptor.effectId,
        evidenceEffectId: evidence.effectId,
        current,
        next: evidence.outcome,
      }
    );
  }
  if (!EVIDENCE_RESOLVABLE_RECOVERY_CLASSES.has(descriptor.recoveryClass)) {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_transition',
      'This recovery class cannot resolve ambiguity automatically',
      {
        effectId: descriptor.effectId,
        recoveryClass: descriptor.recoveryClass,
        current,
        next: evidence.outcome,
      }
    );
  }
  return evidence.outcome;
}

export function retryDurableEffectAfterObservedAbsent(
  descriptor: EffectDescriptor,
  current: DurableEffectState
): 'attempting' {
  assertEffectDescriptor(descriptor);
  assertEffectState(current, 'current');
  if (current !== 'observed_absent') {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_transition',
      'A durable effect retry requires proven observed_absent evidence',
      { effectId: descriptor.effectId, current, next: 'attempting' }
    );
  }
  if (!ABSENT_RETRY_RECOVERY_CLASSES.has(descriptor.recoveryClass)) {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_transition',
      'This recovery class cannot retry automatically after an attempted boundary crossing',
      {
        effectId: descriptor.effectId,
        recoveryClass: descriptor.recoveryClass,
        current,
        next: 'attempting',
      }
    );
  }
  return 'attempting';
}

export function createInitialEffectPlan(
  descriptor: Pick<CommandDescriptor, 'descriptorId' | 'effects'>
): readonly DurableEffectPlanItem[] {
  if (!Array.isArray(descriptor.effects) || descriptor.effects.length === 0) {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_plan',
      'Durable command effect plan must be ordered and non-empty',
      { descriptorId: descriptor.descriptorId }
    );
  }
  assertEffectArray(descriptor.effects);
  const seen = new Set<string>();
  const plan = descriptor.effects.map((effect, ordinal) => {
    assertEffectDescriptor(effect);
    if (seen.has(effect.effectId)) {
      throw new DurableCommandStateTransitionError(
        'invalid_effect_plan',
        'Durable command effect identifiers must be unique',
        { descriptorId: descriptor.descriptorId, effectId: effect.effectId }
      );
    }
    seen.add(effect.effectId);
    return Object.freeze({ ...effect, ordinal, state: 'not_started' as const });
  });
  return Object.freeze(plan);
}

export function classifyAmbiguousEffect(
  recoveryClass: EffectRecoveryClass
): AmbiguousEffectDisposition {
  assertRecoveryClass(recoveryClass);
  return recoveryClass === 'non_reconcilable'
    ? Object.freeze({ commandState: 'operator_required', automaticAction: 'none' })
    : Object.freeze({
        commandState: 'recovering',
        automaticAction: 'require_declared_evidence',
      });
}

function assertCommandState(value: string, field: string): asserts value is DurableCommandState {
  if (!DURABLE_COMMAND_STATES.includes(value as DurableCommandState)) {
    throw new DurableCommandStateTransitionError(
      'invalid_command_transition',
      `Unknown durable command ${field} state`,
      { field, value }
    );
  }
}

function assertEffectState(value: string, field: string): asserts value is DurableEffectState {
  if (!DURABLE_EFFECT_STATES.includes(value as DurableEffectState)) {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_transition',
      `Unknown durable effect ${field} state`,
      { field, value }
    );
  }
}

function assertRecoveryClass(value: string): asserts value is EffectRecoveryClass {
  if (!EFFECT_RECOVERY_CLASSES.includes(value as EffectRecoveryClass)) {
    throw new DurableCommandStateTransitionError(
      'invalid_recovery_class',
      'Unknown durable effect recovery class',
      { recoveryClass: value }
    );
  }
}

function assertEffectDescriptor(effect: EffectDescriptor): void {
  assertExactEffectDataObject(effect);
  assertEffectDescriptorFields(effect);
}

function assertEffectDescriptorFields(effect: EffectDescriptor): void {
  if (typeof effect.effectId !== 'string' || effect.effectId.trim().length === 0) {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_plan',
      'Durable effect identifier must be a non-empty string'
    );
  }
  if (!Number.isSafeInteger(effect.effectVersion) || effect.effectVersion <= 0) {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_plan',
      'Durable effect version must be a positive safe integer',
      { effectId: effect.effectId }
    );
  }
  if (!Number.isSafeInteger(effect.evidenceSchemaVersion) || effect.evidenceSchemaVersion <= 0) {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_plan',
      'Durable effect evidence schema version must be a positive safe integer',
      { effectId: effect.effectId }
    );
  }
  assertRecoveryClass(effect.recoveryClass);
}

function assertDurableCommandDescriptorIdentity(identity: DurableCommandDescriptorIdentity): void {
  assertExactDataObject(
    identity,
    COMMAND_DESCRIPTOR_IDENTITY_KEYS,
    'Durable command descriptor identity'
  );
  createDurableCommandDescriptorIdentity(identity);
}

function assertDurableEffectPlanItem(item: DurableEffectPlanItem): void {
  assertExactDataObject(item, DURABLE_EFFECT_PLAN_ITEM_KEYS, 'Durable effect plan item');
  assertEffectDescriptorFields(item);
  if (!Number.isSafeInteger(item.ordinal) || item.ordinal < 0) {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_plan',
      'Durable effect plan ordinal must be a non-negative safe integer',
      { effectId: item.effectId, ordinal: item.ordinal }
    );
  }
  assertEffectState(item.state, 'persisted');
}

function assertValidatedEffectEvidence(evidence: ValidatedDurableEffectEvidence): void {
  assertExactDataObject(
    evidence,
    VALIDATED_EFFECT_EVIDENCE_KEYS,
    'Validated durable effect evidence'
  );
  assertEffectDescriptorFields(evidence);
  if (evidence.outcome !== 'observed_succeeded' && evidence.outcome !== 'observed_absent') {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_transition',
      'Validated durable effect evidence has an unsupported outcome',
      { effectId: evidence.effectId, outcome: evidence.outcome }
    );
  }
}

function assertEffectArray(effects: readonly EffectDescriptor[]): void {
  assertDenseDataArray(effects, 'Durable command effects');
}

function assertEffectPlanArray(effects: readonly DurableEffectPlanItem[]): void {
  assertDenseDataArray(effects, 'Persisted durable command effect plan');
}

function assertDenseDataArray(value: readonly unknown[], label: string): void {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_plan',
      `${label} must use the standard array prototype`
    );
  }
  const expectedNames = new Set([
    'length',
    ...Array.from({ length: value.length }, (_, index) => String(index)),
  ]);
  if (
    Object.getOwnPropertyNames(value).some((name) => !expectedNames.has(name)) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_plan',
      `${label} must be dense and contain no extra properties`
    );
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new DurableCommandStateTransitionError(
        'invalid_effect_plan',
        `${label} must contain only enumerable data items`
      );
    }
  }
}

function assertExactEffectDataObject(value: unknown): asserts value is EffectDescriptor {
  assertExactDataObject(value, EFFECT_DESCRIPTOR_KEYS, 'Durable effect descriptor');
}

function assertExactDataObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_plan',
      `${label} must be a plain data object`
    );
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_plan',
      `${label} must be a plain data object`
    );
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_plan',
      `${label} must not contain symbol keys`
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort(compareCodeUnit);
  const sortedExpectedKeys = [...expectedKeys].sort(compareCodeUnit);
  if (
    keys.length !== sortedExpectedKeys.length ||
    keys.some((key, index) => key !== sortedExpectedKeys[index]) ||
    Object.values(descriptors).some(
      (descriptor) => !descriptor.enumerable || !('value' in descriptor)
    )
  ) {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_plan',
      `${label} has missing, unknown, or accessor fields`
    );
  }
}

function sameCommandDescriptorIdentity(
  left: DurableCommandDescriptorIdentity,
  right: DurableCommandDescriptorIdentity
): boolean {
  return COMMAND_DESCRIPTOR_IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

function sameEffectPlanIdentity(
  expected: DurableEffectPlanItem,
  actual: DurableEffectPlanItem
): boolean {
  return expected.ordinal === actual.ordinal && sameEffectDescriptorIdentity(expected, actual);
}

function sameEffectDescriptorIdentity(left: EffectDescriptor, right: EffectDescriptor): boolean {
  return EFFECT_DESCRIPTOR_KEYS.every((key) => left[key] === right[key]);
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_plan',
      `Durable command ${field} must be a non-empty string`,
      { field }
    );
  }
}

function assertPositiveVersion(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new DurableCommandStateTransitionError(
      'invalid_effect_plan',
      `Durable command ${field} must be a positive safe integer`,
      { field }
    );
  }
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
