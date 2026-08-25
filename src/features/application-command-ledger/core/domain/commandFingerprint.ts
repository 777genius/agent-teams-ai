import {
  type CommandClaimRecord,
  type CommandClaimResolution,
  type CommandClaimScope,
  type CommandDescriptor,
  type CommandFingerprintPreimage,
  type CommandFingerprintRecord,
  EFFECT_RECOVERY_CLASSES,
  type EffectDescriptor,
  HMAC_SHA256_LD_V1,
  type NormalizedCommandIntent,
  type NormalizedIntentValue,
} from '../../contracts';

export type CommandFingerprintContractErrorCode =
  | 'invalid_claim_scope'
  | 'invalid_fingerprint_input'
  | 'invalid_fingerprint_record'
  | 'intent_projection_failed'
  | 'unsupported_fingerprint_version';

export class CommandFingerprintContractError extends Error {
  constructor(
    readonly code: CommandFingerprintContractErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'CommandFingerprintContractError';
  }
}

export interface PreparedCommandFingerprint {
  readonly preimage: CommandFingerprintPreimage;
  readonly encodedPreimage: string;
}

export function prepareCommandFingerprint<TInput>(
  descriptor: CommandDescriptor<TInput>,
  input: TInput
): PreparedCommandFingerprint {
  assertFingerprintVersion(descriptor.fingerprintVersion);

  let intent: NormalizedCommandIntent;
  try {
    intent = descriptor.normalizedIntentProjection(input);
  } catch (error) {
    throw new CommandFingerprintContractError(
      'intent_projection_failed',
      'Command normalized intent projection failed',
      { descriptorId: descriptor.descriptorId },
      error
    );
  }

  const preimage = buildCommandFingerprintPreimage(descriptor, intent);
  return Object.freeze({
    preimage,
    encodedPreimage: encodeCommandFingerprintPreimage(preimage),
  });
}

export function buildCommandFingerprintPreimage(
  descriptor: Pick<
    CommandDescriptor,
    | 'descriptorId'
    | 'descriptorVersion'
    | 'inputSchemaVersion'
    | 'fingerprintVersion'
    | 'effectPlanVersion'
    | 'effects'
  >,
  intent: NormalizedCommandIntent
): CommandFingerprintPreimage {
  assertNonEmptyString('descriptorId', descriptor.descriptorId, 'invalid_fingerprint_input');
  assertPositiveVersion('descriptorVersion', descriptor.descriptorVersion);
  assertPositiveVersion('inputSchemaVersion', descriptor.inputSchemaVersion);
  assertFingerprintVersion(descriptor.fingerprintVersion);
  assertPositiveVersion('effectPlanVersion', descriptor.effectPlanVersion);
  const effectPlan = freezeEffectPlan(descriptor.effects);
  assertPlainIntentObject(intent);
  const frozenIntent = freezeNormalizedValue(
    intent,
    new WeakSet<object>()
  ) as NormalizedCommandIntent;
  encodeLengthDelimitedValue(frozenIntent);

  return Object.freeze({
    descriptorId: descriptor.descriptorId,
    descriptorVersion: descriptor.descriptorVersion,
    schemaVersion: descriptor.inputSchemaVersion,
    fingerprintVersion: descriptor.fingerprintVersion,
    effectPlanVersion: descriptor.effectPlanVersion,
    effectPlan,
    intent: frozenIntent,
  });
}

export function encodeCommandFingerprintPreimage(preimage: CommandFingerprintPreimage): string {
  assertExactDataObject(
    preimage,
    [
      'descriptorId',
      'descriptorVersion',
      'schemaVersion',
      'fingerprintVersion',
      'effectPlanVersion',
      'effectPlan',
      'intent',
    ],
    'fingerprint preimage',
    'invalid_fingerprint_input'
  );
  assertNonEmptyString('descriptorId', preimage.descriptorId, 'invalid_fingerprint_input');
  assertPositiveVersion('descriptorVersion', preimage.descriptorVersion);
  assertPositiveVersion('schemaVersion', preimage.schemaVersion);
  assertFingerprintVersion(preimage.fingerprintVersion);
  assertPositiveVersion('effectPlanVersion', preimage.effectPlanVersion);
  freezeEffectPlan(preimage.effectPlan);
  assertPlainIntentObject(preimage.intent);
  return encodeLengthDelimitedValue(preimage);
}

/**
 * Pure UTF-8 length-delimited encoding used by hmac-sha256-ld-v1.
 * Object keys are sorted by code unit; array order and string code points are retained.
 */
export function encodeLengthDelimitedValue(value: unknown): string {
  return encodeValue(value, new WeakSet<object>());
}

export function buildCommandFingerprintRecord(
  preimage: CommandFingerprintPreimage,
  keyVersion: string,
  digest: string
): CommandFingerprintRecord {
  encodeCommandFingerprintPreimage(preimage);
  assertNonEmptyString('keyVersion', keyVersion, 'invalid_fingerprint_record');
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new CommandFingerprintContractError(
      'invalid_fingerprint_record',
      'Command fingerprint digest must be 64 lowercase hexadecimal characters',
      { field: 'digest' }
    );
  }
  return Object.freeze({
    descriptorId: preimage.descriptorId,
    descriptorVersion: preimage.descriptorVersion,
    schemaVersion: preimage.schemaVersion,
    fingerprintVersion: preimage.fingerprintVersion,
    effectPlanVersion: preimage.effectPlanVersion,
    keyVersion,
    digest,
  });
}

export function createCommandClaimScope<TCommandKind extends string>(
  input: CommandClaimScope<TCommandKind>
): CommandClaimScope<TCommandKind> {
  assertExactDataObject(
    input,
    ['deploymentId', 'stableActorId', 'commandKind', 'idempotencyKey'],
    'command claim scope',
    'invalid_claim_scope'
  );
  for (const [field, value] of Object.entries(input)) {
    assertNonEmptyString(field, value, 'invalid_claim_scope');
  }
  return Object.freeze({ ...input });
}

/**
 * A new claim uses the active key. A retry uses the key version retained by its existing claim so
 * key rotation alone cannot manufacture an idempotency mismatch. Key lookup and HMAC stay outside
 * this pure contract.
 */
export function selectCommandFingerprintKeyVersion(
  existing: CommandClaimRecord | null,
  activeKeyVersion: string
): string {
  assertNonEmptyString('activeKeyVersion', activeKeyVersion, 'invalid_fingerprint_record');
  return existing ? validateClaimRecord(existing).fingerprint.keyVersion : activeKeyVersion;
}

export function resolveCommandClaim<TCommandKind extends string>(
  existing: CommandClaimRecord<TCommandKind> | null,
  incoming: CommandClaimRecord<TCommandKind>
): CommandClaimResolution<TCommandKind> {
  const incomingRecord = validateClaimRecord(incoming);
  if (!existing) {
    return Object.freeze({
      outcome: 'claimed',
      claimAction: 'create',
      effectAction: 'none',
      record: incomingRecord,
    });
  }

  const existingRecord = validateClaimRecord(existing);
  if (!sameClaimScope(existingRecord.scope, incomingRecord.scope)) {
    throw new CommandFingerprintContractError(
      'invalid_claim_scope',
      'Claim resolution requires the exact deployment, actor, command kind, and key scope'
    );
  }

  if (sameVersionedDigest(existingRecord.fingerprint, incomingRecord.fingerprint)) {
    return Object.freeze({
      outcome: 'same_intent',
      claimAction: 'reuse',
      effectAction: 'none',
      record: existingRecord,
    });
  }

  return Object.freeze({
    outcome: 'idempotency_mismatch',
    claimAction: 'reject',
    effectAction: 'none',
    record: existingRecord,
    mismatch: Object.freeze({
      code: 'idempotency_mismatch',
      existingFingerprint: existingRecord.fingerprint,
      requestedFingerprint: incomingRecord.fingerprint,
    }),
  });
}

function encodeValue(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) return 'n:0:';
  if (typeof value === 'boolean') return value ? 'b:1:1' : 'b:1:0';
  if (typeof value === 'string') {
    assertWellFormedUnicode(value);
    return `s:${utf8ByteLength(value)}:${value}`;
  }
  if (typeof value === 'number') {
    const encoded = encodeCanonicalNumber(value);
    const tag = Number.isInteger(value) && !Object.is(value, -0) ? 'i' : 'd';
    return `${tag}:${utf8ByteLength(encoded)}:${encoded}`;
  }
  if (Array.isArray(value)) {
    assertStrictArray(value);
    return withAncestor(value, ancestors, () => {
      const items = value.map((item) => frame(encodeValue(item, ancestors))).join('');
      return `a:${value.length}:${items}`;
    });
  }
  if (typeof value === 'object') {
    assertPlainDataObject(value);
    return withAncestor(value, ancestors, () => {
      const entries = Object.entries(value).sort(([left], [right]) => compareCodeUnit(left, right));
      const items = entries
        .map(
          ([key, item]) =>
            `${frame(encodeValue(key, ancestors))}${frame(encodeValue(item, ancestors))}`
        )
        .join('');
      return `o:${entries.length}:${items}`;
    });
  }
  throw invalidFingerprintInput(`Unsupported fingerprint value: ${typeof value}`);
}

function encodeCanonicalNumber(value: number): string {
  assertSupportedNumber(value);
  // Number#toString is the locale-independent ECMAScript shortest round-trip representation.
  return Object.is(value, -0) ? '-0' : String(value);
}

function assertWellFormedUnicode(value: string): void {
  let index = 0;
  while (index < value.length) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw invalidFingerprintInput('Fingerprint strings must contain well-formed Unicode');
      }
      index += 2;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw invalidFingerprintInput('Fingerprint strings must contain well-formed Unicode');
    } else {
      index += 1;
    }
  }
}

function assertSupportedNumber(value: number): void {
  if (!Number.isFinite(value)) {
    throw invalidFingerprintInput('Fingerprint numbers must be finite');
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw invalidFingerprintInput('Fingerprint integers must be safe integers');
  }
}

function freezeEffectPlan(effects: readonly EffectDescriptor[]): readonly EffectDescriptor[] {
  if (!Array.isArray(effects) || effects.length === 0) {
    throw invalidFingerprintInput('Fingerprint effect plan must be an ordered non-empty array');
  }
  assertStrictArray(effects);
  const seen = new Set<string>();
  const frozen = effects.map((effect) => {
    assertExactDataObject(
      effect,
      ['effectId', 'effectVersion', 'recoveryClass', 'evidenceSchemaVersion'],
      'fingerprint effect descriptor',
      'invalid_fingerprint_input'
    );
    assertNonEmptyString('effectId', effect.effectId, 'invalid_fingerprint_input');
    assertPositiveVersion('effectVersion', effect.effectVersion);
    assertPositiveVersion('evidenceSchemaVersion', effect.evidenceSchemaVersion);
    const recoveryClass = effect.recoveryClass as EffectDescriptor['recoveryClass'];
    if (!EFFECT_RECOVERY_CLASSES.includes(recoveryClass)) {
      throw invalidFingerprintInput('Fingerprint effect descriptor has an invalid recovery class');
    }
    if (seen.has(effect.effectId)) {
      throw invalidFingerprintInput('Fingerprint effect identifiers must be unique');
    }
    seen.add(effect.effectId);
    return Object.freeze({
      effectId: effect.effectId,
      effectVersion: effect.effectVersion,
      recoveryClass,
      evidenceSchemaVersion: effect.evidenceSchemaVersion,
    });
  });
  return Object.freeze(frozen);
}

// eslint-disable-next-line sonarjs/function-return-type -- Recursive values intentionally return different union members.
function freezeNormalizedValue(value: unknown, ancestors: WeakSet<object>): NormalizedIntentValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    assertSupportedNumber(value);
    return value;
  }
  if (Array.isArray(value)) {
    assertStrictArray(value);
    return withAncestor(value, ancestors, () =>
      Object.freeze(value.map((item) => freezeNormalizedValue(item, ancestors)))
    );
  }
  if (typeof value !== 'object') {
    throw invalidFingerprintInput(`Unsupported fingerprint value: ${typeof value}`);
  }

  assertPlainDataObject(value);
  return withAncestor(value, ancestors, () => {
    const copy = Object.create(null) as Record<string, NormalizedIntentValue>;
    for (const key of Object.keys(value).sort(compareCodeUnit)) {
      copy[key] = freezeNormalizedValue(value[key], ancestors);
    }
    return Object.freeze(copy);
  });
}

function withAncestor<T>(value: object, ancestors: WeakSet<object>, encode: () => T): T {
  if (ancestors.has(value)) {
    throw invalidFingerprintInput('Fingerprint values must not be cyclic');
  }
  ancestors.add(value);
  try {
    return encode();
  } finally {
    ancestors.delete(value);
  }
}

function assertPlainIntentObject(value: unknown): asserts value is NormalizedCommandIntent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidFingerprintInput('Normalized command intent must be a plain data object');
  }
  assertPlainDataObject(value);
}

function assertPlainDataObject(value: object): asserts value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidFingerprintInput('Fingerprint values must contain only plain data objects');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw invalidFingerprintInput('Fingerprint values must not contain symbol keys');
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw invalidFingerprintInput(
        'Fingerprint values must contain only enumerable data properties'
      );
    }
  }
}

function assertStrictArray(value: readonly unknown[]): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw invalidFingerprintInput('Fingerprint arrays must use the standard array prototype');
  }
  const expectedNames = new Set([
    'length',
    ...Array.from({ length: value.length }, (_, index) => String(index)),
  ]);
  if (
    Object.getOwnPropertyNames(value).some((name) => !expectedNames.has(name)) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw invalidFingerprintInput('Fingerprint arrays must not contain holes or extra properties');
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) {
      throw invalidFingerprintInput(
        'Fingerprint arrays must not contain holes or extra properties'
      );
    }
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw invalidFingerprintInput('Fingerprint arrays must contain only enumerable data items');
    }
  }
}

function validateClaimRecord<TCommandKind extends string>(
  value: CommandClaimRecord<TCommandKind>
): CommandClaimRecord<TCommandKind> {
  assertExactDataObject(
    value,
    ['scope', 'fingerprint'],
    'command claim record',
    'invalid_fingerprint_record'
  );
  const scope = createCommandClaimScope(value.scope);
  validateFingerprintRecord(value.fingerprint);
  return Object.freeze({ scope, fingerprint: Object.freeze({ ...value.fingerprint }) });
}

function validateFingerprintRecord(value: CommandFingerprintRecord): void {
  assertExactDataObject(
    value,
    [
      'descriptorId',
      'descriptorVersion',
      'schemaVersion',
      'fingerprintVersion',
      'effectPlanVersion',
      'keyVersion',
      'digest',
    ],
    'fingerprint record',
    'invalid_fingerprint_record'
  );
  assertNonEmptyString('descriptorId', value.descriptorId, 'invalid_fingerprint_record');
  assertPositiveVersion('descriptorVersion', value.descriptorVersion, 'invalid_fingerprint_record');
  assertPositiveVersion('schemaVersion', value.schemaVersion, 'invalid_fingerprint_record');
  assertFingerprintVersion(value.fingerprintVersion);
  assertPositiveVersion('effectPlanVersion', value.effectPlanVersion, 'invalid_fingerprint_record');
  assertNonEmptyString('keyVersion', value.keyVersion, 'invalid_fingerprint_record');
  if (!/^[a-f0-9]{64}$/.test(value.digest)) {
    throw new CommandFingerprintContractError(
      'invalid_fingerprint_record',
      'Command fingerprint digest must be 64 lowercase hexadecimal characters',
      { field: 'digest' }
    );
  }
}

function assertExactDataObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
  code: CommandFingerprintContractErrorCode
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CommandFingerprintContractError(code, `${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CommandFingerprintContractError(code, `${label} must be a plain data object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new CommandFingerprintContractError(code, `${label} must not contain symbol keys`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Object.keys(descriptors).sort(compareCodeUnit);
  const sortedExpected = [...expectedKeys].sort(compareCodeUnit);
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new CommandFingerprintContractError(code, `${label} has missing or unknown fields`);
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new CommandFingerprintContractError(
        code,
        `${label} must contain only enumerable data properties`
      );
    }
  }
}

function assertFingerprintVersion(value: unknown): asserts value is typeof HMAC_SHA256_LD_V1 {
  if (value !== HMAC_SHA256_LD_V1) {
    throw new CommandFingerprintContractError(
      'unsupported_fingerprint_version',
      'Unsupported command fingerprint version',
      { fingerprintVersion: value }
    );
  }
}

function assertPositiveVersion(
  field: string,
  value: unknown,
  code: CommandFingerprintContractErrorCode = 'invalid_fingerprint_input'
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new CommandFingerprintContractError(code, `${field} must be a positive safe integer`, {
      field,
    });
  }
}

function assertNonEmptyString(
  field: string,
  value: unknown,
  code: CommandFingerprintContractErrorCode
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new CommandFingerprintContractError(code, `${field} must be a non-empty string`, {
      field,
    });
  }
}

function sameClaimScope(left: CommandClaimScope, right: CommandClaimScope): boolean {
  return (
    left.deploymentId === right.deploymentId &&
    left.stableActorId === right.stableActorId &&
    left.commandKind === right.commandKind &&
    left.idempotencyKey === right.idempotencyKey
  );
}

function sameVersionedDigest(
  left: CommandFingerprintRecord,
  right: CommandFingerprintRecord
): boolean {
  return (
    left.descriptorId === right.descriptorId &&
    left.descriptorVersion === right.descriptorVersion &&
    left.schemaVersion === right.schemaVersion &&
    left.fingerprintVersion === right.fingerprintVersion &&
    left.effectPlanVersion === right.effectPlanVersion &&
    left.keyVersion === right.keyVersion &&
    left.digest === right.digest
  );
}

function frame(value: string): string {
  return `${utf8ByteLength(value)}:${value}`;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidFingerprintInput(message: string): CommandFingerprintContractError {
  return new CommandFingerprintContractError('invalid_fingerprint_input', message);
}
