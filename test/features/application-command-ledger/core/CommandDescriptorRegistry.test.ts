import {
  COMMAND_IDEMPOTENCY_SCOPE,
  type CommandDescriptor,
  CommandDescriptorRegistryError,
  createCommandDescriptorRegistry,
  EFFECT_RECOVERY_CLASSES,
  type EffectDescriptor,
  HMAC_SHA256_LD_V1,
} from '@features/application-command-ledger';
import { describe, expect, it } from 'vitest';

describe('CommandDescriptorRegistry', () => {
  it('resolves exact retained descriptor versions and preserves ordered effects', () => {
    const schemaOne = makeDescriptor();
    const schemaTwo = makeDescriptor({
      descriptorVersion: 2,
      inputSchemaVersion: 2,
      effectPlanVersion: 2,
      effects: [
        makeEffect({
          effectId: 'persist-task-v2',
          effectVersion: 2,
          recoveryClass: 'transactional_local',
          evidenceSchemaVersion: 2,
        }),
        makeEffect({
          effectId: 'notify-owner',
          recoveryClass: 'idempotent_by_operation_id',
        }),
      ],
    });
    const registry = createCommandDescriptorRegistry([schemaOne, schemaTwo]);

    const retained = registry.resolve({
      commandKind: 'task.create',
      descriptorId: 'task.create',
      descriptorVersion: 1,
      inputSchemaVersion: 1,
      fingerprintVersion: HMAC_SHA256_LD_V1,
      effectPlanVersion: 1,
    });
    const current = registry.resolve({
      commandKind: 'task.create',
      descriptorId: 'task.create',
      descriptorVersion: 2,
      inputSchemaVersion: 2,
      fingerprintVersion: HMAC_SHA256_LD_V1,
      effectPlanVersion: 2,
    });

    expect(retained.inputSchemaVersion).toBe(1);
    expect(current.effects.map((effect) => effect.effectId)).toEqual([
      'persist-task-v2',
      'notify-owner',
    ]);
    expect(registry.list()).toHaveLength(2);
    expect(Object.isFrozen(registry.list())).toBe(true);
    expect(Object.isFrozen(current)).toBe(true);
    expect(Object.isFrozen(current.effects)).toBe(true);
    expect(Object.isFrozen(current.effects[0])).toBe(true);
    expect('register' in registry).toBe(false);
  });

  it('resolves retained records only through an exact descriptor contract', () => {
    const registry = createCommandDescriptorRegistry([makeDescriptor()]);
    const descriptor = registry.resolveFingerprintRecord('task.create', {
      descriptorId: 'task.create',
      descriptorVersion: 1,
      schemaVersion: 1,
      fingerprintVersion: HMAC_SHA256_LD_V1,
      effectPlanVersion: 1,
      keyVersion: 'command-key-v1',
      digest: 'a'.repeat(64),
    });

    expect(descriptor.commandKind).toBe('task.create');
    expect(() =>
      registry.resolveFingerprintRecord('task.create', {
        descriptorId: 'task.create.old',
        descriptorVersion: 1,
        schemaVersion: 1,
        fingerprintVersion: HMAC_SHA256_LD_V1,
        effectPlanVersion: 1,
        keyVersion: 'command-key-v1',
        digest: 'a'.repeat(64),
      })
    ).toThrowError(
      expect.objectContaining<Partial<CommandDescriptorRegistryError>>({
        code: 'unknown_command_descriptor',
      })
    );

    for (const malformed of [
      {
        descriptorId: 'task.create',
        descriptorVersion: 1,
        schemaVersion: 1,
        fingerprintVersion: HMAC_SHA256_LD_V1,
        effectPlanVersion: 1,
        keyVersion: 'command-key-v1',
        digest: 'not-a-digest',
      },
      {
        descriptorId: 'task.create',
        descriptorVersion: 1,
        schemaVersion: 1,
        fingerprintVersion: HMAC_SHA256_LD_V1,
        effectPlanVersion: 1,
        keyVersion: 'command-key-v1',
        digest: 'a'.repeat(64),
        unknown: true,
      },
    ]) {
      expect(() =>
        registry.resolveFingerprintRecord(
          'task.create',
          malformed as unknown as Parameters<typeof registry.resolveFingerprintRecord>[1]
        )
      ).toThrowError(
        expect.objectContaining<Partial<CommandDescriptorRegistryError>>({
          code: 'invalid_descriptor_registry',
        })
      );
    }
  });

  it('fails closed for an empty registry, unknown versions, and duplicate versions', () => {
    expect(() => createCommandDescriptorRegistry([])).toThrowError(
      expect.objectContaining<Partial<CommandDescriptorRegistryError>>({
        code: 'invalid_descriptor_registry',
      })
    );

    const registry = createCommandDescriptorRegistry([makeDescriptor()]);
    expect(() =>
      registry.resolve({
        commandKind: 'task.create',
        descriptorId: 'task.create',
        descriptorVersion: 2,
        inputSchemaVersion: 2,
        fingerprintVersion: HMAC_SHA256_LD_V1,
        effectPlanVersion: 2,
      })
    ).toThrowError(
      expect.objectContaining<Partial<CommandDescriptorRegistryError>>({
        code: 'unknown_command_descriptor',
      })
    );

    expect(() =>
      createCommandDescriptorRegistry([makeDescriptor(), makeDescriptor()])
    ).toThrowError(
      expect.objectContaining<Partial<CommandDescriptorRegistryError>>({
        code: 'invalid_descriptor_registry',
      })
    );
  });

  it.each([
    ['blank descriptor id', { descriptorId: ' ' }],
    ['zero descriptor version', { descriptorVersion: 0 }],
    ['blank command kind', { commandKind: '' }],
    ['zero schema version', { inputSchemaVersion: 0 }],
    ['unsafe schema version', { inputSchemaVersion: Number.MAX_SAFE_INTEGER + 1 }],
    ['zero effect plan version', { effectPlanVersion: 0 }],
    ['blank retention class', { retentionClass: '' }],
    ['wrong scope', { idempotencyScope: 'session+key' }],
    ['unsupported fingerprint', { fingerprintVersion: 'hmac-sha256-ld-v2' }],
    ['missing projection', { normalizedIntentProjection: null }],
    ['empty effect plan', { effects: [] }],
  ])('rejects an invalid descriptor: %s', (_label, overrides) => {
    const descriptor = {
      ...makeDescriptor(),
      ...overrides,
    } as unknown as CommandDescriptor;

    expect(() => createCommandDescriptorRegistry([descriptor])).toThrowError(
      expect.objectContaining<Partial<CommandDescriptorRegistryError>>({
        code: 'invalid_descriptor_registry',
      })
    );
  });

  it('rejects non-plain, accessor-backed, sparse, and unknown descriptor data', () => {
    class DescriptorContainer {
      descriptorId = 'task.create';
      descriptorVersion = 1;
      commandKind = 'task.create';
      inputSchemaVersion = 1;
      fingerprintVersion = HMAC_SHA256_LD_V1;
      effectPlanVersion = 1;
      idempotencyScope = COMMAND_IDEMPOTENCY_SCOPE;
      retentionClass = 'operator-command';
      normalizedIntentProjection = (): { teamId: string } => ({ teamId: 'team-1' });
      effects = [makeEffect()] as [EffectDescriptor];
    }

    expect(() =>
      createCommandDescriptorRegistry([new DescriptorContainer() as CommandDescriptor])
    ).toThrowError(/plain data object/);

    const accessor = makeDescriptor() as CommandDescriptor & { extra?: string };
    Object.defineProperty(accessor, 'descriptorId', {
      enumerable: true,
      get: () => 'task.create',
    });
    expect(() => createCommandDescriptorRegistry([accessor])).toThrowError(
      /enumerable data properties/
    );

    let effectGetterCalls = 0;
    const accessorEffects = [makeEffect()];
    Object.defineProperty(accessorEffects, '0', {
      enumerable: true,
      get: () => {
        effectGetterCalls += 1;
        return makeEffect();
      },
    });
    expect(() =>
      createCommandDescriptorRegistry([
        makeDescriptor({ effects: accessorEffects as [EffectDescriptor] }),
      ])
    ).toThrowError(/enumerable data items/);
    expect(effectGetterCalls).toBe(0);

    const unknown = { ...makeDescriptor(), extra: true } as unknown as CommandDescriptor;
    expect(() => createCommandDescriptorRegistry([unknown])).toThrowError(/unknown fields/);

    const sparseEffects = new Array<EffectDescriptor>(1) as unknown as [EffectDescriptor];
    expect(() =>
      createCommandDescriptorRegistry([makeDescriptor({ effects: sparseEffects })])
    ).toThrowError(/dense/);

    class EffectArray extends Array<EffectDescriptor> {}
    const subclassedEffects = new EffectArray(makeEffect()) as unknown as [EffectDescriptor];
    expect(() =>
      createCommandDescriptorRegistry([makeDescriptor({ effects: subclassedEffects })])
    ).toThrowError(/standard array prototype/);
  });

  it('rejects duplicate, malformed, and unsupported effect descriptors', () => {
    const duplicate = makeDescriptor({ effects: [makeEffect(), makeEffect()] });
    expect(() => createCommandDescriptorRegistry([duplicate])).toThrowError(/must be unique/);

    for (const effect of [
      makeEffect({ effectId: '' }),
      makeEffect({ effectVersion: 0 }),
      makeEffect({ evidenceSchemaVersion: Number.NaN }),
      makeEffect({ recoveryClass: 'unknown' as EffectDescriptor['recoveryClass'] }),
    ]) {
      expect(() =>
        createCommandDescriptorRegistry([makeDescriptor({ effects: [effect] })])
      ).toThrowError(
        expect.objectContaining<Partial<CommandDescriptorRegistryError>>({
          code: 'invalid_descriptor_registry',
        })
      );
    }
  });

  it('admits every frozen recovery class without adding another class', () => {
    const descriptor = makeDescriptor({
      effects: EFFECT_RECOVERY_CLASSES.map((recoveryClass, index) =>
        makeEffect({ effectId: `effect-${index}`, recoveryClass })
      ) as [EffectDescriptor, ...EffectDescriptor[]],
    });
    const registry = createCommandDescriptorRegistry([descriptor]);

    expect(registry.list()[0].effects.map((effect) => effect.recoveryClass)).toEqual(
      EFFECT_RECOVERY_CLASSES
    );
  });

  it('requires a new retained identity when the ordered effect contract changes', () => {
    const original = makeDescriptor();
    const changedWithoutVersion = makeDescriptor({
      effects: [makeEffect({ recoveryClass: 'non_reconcilable' })],
    });
    expect(() => createCommandDescriptorRegistry([original, changedWithoutVersion])).toThrowError(
      /versions must be unique/
    );

    const changedWithRetainedIdentity = makeDescriptor({
      descriptorVersion: 2,
      effectPlanVersion: 2,
      effects: [
        makeEffect({ effectVersion: 2, recoveryClass: 'non_reconcilable' }),
        makeEffect({ effectId: 'append-audit-event' }),
      ],
    });
    const registry = createCommandDescriptorRegistry([original, changedWithRetainedIdentity]);
    expect(
      registry.resolve({
        commandKind: 'task.create',
        descriptorId: 'task.create',
        descriptorVersion: 2,
        inputSchemaVersion: 1,
        fingerprintVersion: HMAC_SHA256_LD_V1,
        effectPlanVersion: 2,
      }).effects
    ).toEqual(changedWithRetainedIdentity.effects);
  });
});

function makeDescriptor(overrides: Partial<CommandDescriptor> = {}): CommandDescriptor {
  return {
    descriptorId: 'task.create',
    descriptorVersion: 1,
    commandKind: 'task.create',
    inputSchemaVersion: 1,
    fingerprintVersion: HMAC_SHA256_LD_V1,
    effectPlanVersion: 1,
    idempotencyScope: COMMAND_IDEMPOTENCY_SCOPE,
    retentionClass: 'operator-command',
    normalizedIntentProjection: (input) => input as { readonly teamId: string },
    effects: [makeEffect()],
    ...overrides,
  };
}

function makeEffect(overrides: Partial<EffectDescriptor> = {}): EffectDescriptor {
  return {
    effectId: 'persist-task',
    effectVersion: 1,
    recoveryClass: 'transactional_local',
    evidenceSchemaVersion: 1,
    ...overrides,
  };
}
