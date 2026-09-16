import {
  COMMAND_IDEMPOTENCY_SCOPE,
  type CommandDescriptor,
  type CommandFingerprintRecord,
  EFFECT_RECOVERY_CLASSES,
  type EffectDescriptor,
  HMAC_SHA256_LD_V1,
} from '../../contracts';

export type CommandDescriptorRegistryErrorCode =
  | 'invalid_descriptor_registry'
  | 'unknown_command_descriptor';

export class CommandDescriptorRegistryError extends Error {
  constructor(
    readonly code: CommandDescriptorRegistryErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = 'CommandDescriptorRegistryError';
  }
}

export interface CommandDescriptorLookup<TCommandKind extends string = string> {
  readonly commandKind: TCommandKind;
  readonly descriptorId: string;
  readonly descriptorVersion: number;
  readonly inputSchemaVersion: number;
  readonly fingerprintVersion: typeof HMAC_SHA256_LD_V1;
  readonly effectPlanVersion: number;
}

const DESCRIPTOR_KEYS = [
  'descriptorId',
  'descriptorVersion',
  'commandKind',
  'inputSchemaVersion',
  'fingerprintVersion',
  'effectPlanVersion',
  'idempotencyScope',
  'retentionClass',
  'normalizedIntentProjection',
  'effects',
] as const;

const EFFECT_KEYS = [
  'effectId',
  'effectVersion',
  'recoveryClass',
  'evidenceSchemaVersion',
] as const;

export class CommandDescriptorRegistry {
  readonly #descriptors: readonly CommandDescriptor[];
  readonly #byVersion: ReadonlyMap<string, CommandDescriptor>;

  constructor(descriptors: readonly CommandDescriptor[]) {
    assertNonEmptyDescriptorArray(descriptors);
    assertDenseArray(descriptors, 'descriptor registry');

    const frozenDescriptors: CommandDescriptor[] = [];
    const byVersion = new Map<string, CommandDescriptor>();
    for (const candidate of descriptors) {
      const descriptor = validateAndFreezeDescriptor(candidate);
      const key = descriptorKey(descriptor);
      if (byVersion.has(key)) {
        throw invalidRegistry('Command descriptor versions must be unique', {
          descriptorId: descriptor.descriptorId,
          descriptorVersion: descriptor.descriptorVersion,
          commandKind: descriptor.commandKind,
          inputSchemaVersion: descriptor.inputSchemaVersion,
          fingerprintVersion: descriptor.fingerprintVersion,
          effectPlanVersion: descriptor.effectPlanVersion,
        });
      }
      byVersion.set(key, descriptor);
      frozenDescriptors.push(descriptor);
    }

    this.#descriptors = Object.freeze(frozenDescriptors);
    this.#byVersion = byVersion;
    Object.freeze(this);
  }

  list(): readonly CommandDescriptor[] {
    return this.#descriptors;
  }

  resolve<TInput = unknown, TCommandKind extends string = string>(
    lookup: CommandDescriptorLookup<TCommandKind>
  ): CommandDescriptor<TInput, TCommandKind> {
    validateLookup(lookup);
    const descriptor = this.#byVersion.get(descriptorKey(lookup));
    if (!descriptor) {
      throw new CommandDescriptorRegistryError(
        'unknown_command_descriptor',
        'No exact command descriptor version is registered',
        {
          commandKind: lookup.commandKind,
          descriptorId: lookup.descriptorId,
          descriptorVersion: lookup.descriptorVersion,
          inputSchemaVersion: lookup.inputSchemaVersion,
          fingerprintVersion: lookup.fingerprintVersion,
          effectPlanVersion: lookup.effectPlanVersion,
        }
      );
    }
    return descriptor as CommandDescriptor<TInput, TCommandKind>;
  }

  resolveFingerprintRecord<TInput = unknown, TCommandKind extends string = string>(
    commandKind: TCommandKind,
    record: CommandFingerprintRecord
  ): CommandDescriptor<TInput, TCommandKind> {
    validateFingerprintRecordLookup(record);
    return this.resolve({
      commandKind,
      descriptorId: record.descriptorId,
      descriptorVersion: record.descriptorVersion,
      inputSchemaVersion: record.schemaVersion,
      fingerprintVersion: record.fingerprintVersion,
      effectPlanVersion: record.effectPlanVersion,
    });
  }
}

function assertNonEmptyDescriptorArray(descriptors: readonly CommandDescriptor[]): void {
  if (!Array.isArray(descriptors) || descriptors.length === 0) {
    throw invalidRegistry('Command descriptor registry must be a non-empty array');
  }
}

function validateFingerprintRecordLookup(record: CommandFingerprintRecord): void {
  assertExactDataObject(
    record,
    [
      'descriptorId',
      'descriptorVersion',
      'schemaVersion',
      'fingerprintVersion',
      'effectPlanVersion',
      'keyVersion',
      'digest',
    ],
    'command fingerprint record'
  );
  assertIdentifier('descriptorId', record.descriptorId);
  assertPositiveVersion('descriptorVersion', record.descriptorVersion);
  assertPositiveVersion('schemaVersion', record.schemaVersion);
  if (record.fingerprintVersion !== HMAC_SHA256_LD_V1) {
    throw invalidRegistry('Command fingerprint record has an unsupported fingerprint version', {
      fingerprintVersion: record.fingerprintVersion,
    });
  }
  assertPositiveVersion('effectPlanVersion', record.effectPlanVersion);
  assertIdentifier('keyVersion', record.keyVersion);
  if (!/^[a-f0-9]{64}$/.test(record.digest)) {
    throw invalidRegistry('Command fingerprint record has an invalid digest');
  }
}

export function createCommandDescriptorRegistry(
  descriptors: readonly CommandDescriptor[]
): CommandDescriptorRegistry {
  return new CommandDescriptorRegistry(descriptors);
}

function validateAndFreezeDescriptor(candidate: CommandDescriptor): CommandDescriptor {
  assertExactDataObject(candidate, DESCRIPTOR_KEYS, 'command descriptor');
  assertIdentifier('descriptorId', candidate.descriptorId);
  assertPositiveVersion('descriptorVersion', candidate.descriptorVersion);
  assertIdentifier('commandKind', candidate.commandKind);
  assertPositiveVersion('inputSchemaVersion', candidate.inputSchemaVersion);
  if (candidate.fingerprintVersion !== HMAC_SHA256_LD_V1) {
    throw invalidRegistry('Command descriptor has an unsupported fingerprint version', {
      descriptorId: candidate.descriptorId,
      fingerprintVersion: candidate.fingerprintVersion,
    });
  }
  if (candidate.idempotencyScope !== COMMAND_IDEMPOTENCY_SCOPE) {
    throw invalidRegistry('Command descriptor has an unsupported idempotency scope', {
      descriptorId: candidate.descriptorId,
      idempotencyScope: candidate.idempotencyScope,
    });
  }
  assertPositiveVersion('effectPlanVersion', candidate.effectPlanVersion);
  assertIdentifier('retentionClass', candidate.retentionClass);
  if (typeof candidate.normalizedIntentProjection !== 'function') {
    throw invalidRegistry('Command descriptor must define a normalized intent projection', {
      descriptorId: candidate.descriptorId,
    });
  }
  if (!Array.isArray(candidate.effects) || candidate.effects.length === 0) {
    throw invalidRegistry('Command descriptor must define an ordered non-empty effect plan', {
      descriptorId: candidate.descriptorId,
    });
  }
  assertDenseArray(candidate.effects, `effects for ${candidate.descriptorId}`);

  const effectIds = new Set<string>();
  const effects = candidate.effects.map((effect) => {
    const frozen = validateAndFreezeEffect(effect, candidate.descriptorId);
    if (effectIds.has(frozen.effectId)) {
      throw invalidRegistry('Effect identifiers must be unique within a command descriptor', {
        descriptorId: candidate.descriptorId,
        effectId: frozen.effectId,
      });
    }
    effectIds.add(frozen.effectId);
    return frozen;
  }) as [EffectDescriptor, ...EffectDescriptor[]];

  return Object.freeze({
    descriptorId: candidate.descriptorId,
    descriptorVersion: candidate.descriptorVersion,
    commandKind: candidate.commandKind,
    inputSchemaVersion: candidate.inputSchemaVersion,
    fingerprintVersion: candidate.fingerprintVersion,
    effectPlanVersion: candidate.effectPlanVersion,
    idempotencyScope: candidate.idempotencyScope,
    retentionClass: candidate.retentionClass,
    normalizedIntentProjection: candidate.normalizedIntentProjection,
    effects: Object.freeze(effects),
  });
}

function validateAndFreezeEffect(
  candidate: EffectDescriptor,
  descriptorId: string
): EffectDescriptor {
  assertExactDataObject(candidate, EFFECT_KEYS, `effect descriptor for ${descriptorId}`);
  assertIdentifier('effectId', candidate.effectId);
  assertPositiveVersion('effectVersion', candidate.effectVersion);
  assertPositiveVersion('evidenceSchemaVersion', candidate.evidenceSchemaVersion);
  if (!EFFECT_RECOVERY_CLASSES.includes(candidate.recoveryClass)) {
    throw invalidRegistry('Effect descriptor has an unsupported recovery class', {
      descriptorId,
      effectId: candidate.effectId,
      recoveryClass: candidate.recoveryClass,
    });
  }
  return Object.freeze({ ...candidate });
}

function validateLookup(lookup: CommandDescriptorLookup): void {
  assertExactDataObject(
    lookup,
    [
      'commandKind',
      'descriptorId',
      'descriptorVersion',
      'inputSchemaVersion',
      'fingerprintVersion',
      'effectPlanVersion',
    ],
    'command descriptor lookup'
  );
  assertIdentifier('commandKind', lookup.commandKind);
  assertIdentifier('descriptorId', lookup.descriptorId);
  assertPositiveVersion('descriptorVersion', lookup.descriptorVersion);
  assertPositiveVersion('inputSchemaVersion', lookup.inputSchemaVersion);
  if (lookup.fingerprintVersion !== HMAC_SHA256_LD_V1) {
    throw invalidRegistry('Command descriptor lookup has an unsupported fingerprint version', {
      fingerprintVersion: lookup.fingerprintVersion,
    });
  }
  assertPositiveVersion('effectPlanVersion', lookup.effectPlanVersion);
}

function descriptorKey(input: {
  commandKind: string;
  descriptorId: string;
  descriptorVersion: number;
  inputSchemaVersion: number;
  fingerprintVersion: string;
  effectPlanVersion: number;
}): string {
  return [
    input.commandKind,
    input.descriptorId,
    input.descriptorVersion,
    input.inputSchemaVersion,
    input.fingerprintVersion,
    input.effectPlanVersion,
  ].join('\0');
}

function assertIdentifier(field: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw invalidRegistry(`Command descriptor ${field} must be a non-empty string`, { field });
  }
}

function assertPositiveVersion(field: string, value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw invalidRegistry(`Command descriptor ${field} must be a positive safe integer`, { field });
  }
}

function assertDenseArray(value: readonly unknown[], label: string): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw invalidRegistry(`${label} must use the standard array prototype`);
  }
  const ownNames = Object.getOwnPropertyNames(value);
  const expected = new Set([
    'length',
    ...Array.from({ length: value.length }, (_, index) => String(index)),
  ]);
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      throw invalidRegistry(`${label} must be dense and contain no extra properties`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw invalidRegistry(`${label} must contain only enumerable data items`);
    }
  }
  if (
    ownNames.some((name) => !expected.has(name)) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw invalidRegistry(`${label} must be dense and contain no extra properties`);
  }
}

function assertExactDataObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidRegistry(`${label} must be a plain data object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidRegistry(`${label} must be a plain data object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw invalidRegistry(`${label} must not contain symbol keys`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actualKeys = Object.keys(descriptors).sort(compareCodeUnit);
  const sortedExpected = [...expectedKeys].sort(compareCodeUnit);
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw invalidRegistry(`${label} has missing or unknown fields`, {
      expectedKeys: sortedExpected,
      actualKeys,
    });
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw invalidRegistry(`${label} must contain only enumerable data properties`);
    }
  }
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidRegistry(
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): CommandDescriptorRegistryError {
  return new CommandDescriptorRegistryError('invalid_descriptor_registry', message, details);
}
