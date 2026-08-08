import { describe, expect, expectTypeOf, it } from 'vitest';

import { createRuntimeInstanceContext } from '../../../src/features/runtime-instance-context/core/domain/RuntimeInstanceContext';

import type { RuntimeInstanceContext } from '../../../src/features/runtime-instance-context/contracts/runtime-instance-context';

const DEPLOYMENT_ID = 'deployment_primary';
const BOOT_ID = 'boot_current';

function root(kind: string, reference: unknown): Record<string, unknown> {
  return { kind, reference };
}

function validInput(): Record<string, unknown> {
  return {
    deploymentId: DEPLOYMENT_ID,
    bootId: BOOT_ID,
    claudeRoot: root('claude', 'root-ref:claude'),
    appDataRoot: root('app-data', 'root-ref:app-data'),
    workspaceRoots: [
      root('workspace', 'root-ref:workspace-one'),
      root('workspace', 'root-ref:workspace-two'),
    ],
    tempRoot: root('temp', 'root-ref:temp'),
    logsRoot: root('logs', 'root-ref:logs'),
  };
}

describe('RuntimeInstanceContext', () => {
  it('creates the exact immutable value boundary from canonical identities and opaque roots', () => {
    const context = createRuntimeInstanceContext(validInput());

    expectTypeOf(context).toEqualTypeOf<RuntimeInstanceContext>();
    expect(context).toEqual(validInput());
    expect(Reflect.ownKeys(context)).toEqual([
      'deploymentId',
      'bootId',
      'claudeRoot',
      'appDataRoot',
      'workspaceRoots',
      'tempRoot',
      'logsRoot',
    ]);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.claudeRoot)).toBe(true);
    expect(Object.isFrozen(context.appDataRoot)).toBe(true);
    expect(Object.isFrozen(context.workspaceRoots)).toBe(true);
    expect(context.workspaceRoots.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(context.tempRoot)).toBe(true);
    expect(Object.isFrozen(context.logsRoot)).toBe(true);

    expect(() => {
      (context as unknown as { deploymentId: string }).deploymentId = 'deployment_changed';
    }).toThrow(TypeError);
    expect(() => {
      (context.workspaceRoots as unknown as unknown[]).push(
        root('workspace', 'root-ref:workspace-three')
      );
    }).toThrow(TypeError);
  });

  it('copies input values so later source mutation cannot alter the context', () => {
    const input = validInput();
    const workspaceRoots = input.workspaceRoots as Record<string, unknown>[];
    const firstWorkspace = workspaceRoots[0];
    const context = createRuntimeInstanceContext(input);

    firstWorkspace.reference = 'root-ref:mutated';
    workspaceRoots.push(root('workspace', 'root-ref:added'));
    input.claudeRoot = root('claude', 'root-ref:replacement');

    expect(context.claudeRoot.reference).toBe('root-ref:claude');
    expect(context.workspaceRoots).toHaveLength(2);
    expect(context.workspaceRoots[0].reference).toBe('root-ref:workspace-one');
  });

  it('supports two isolated runtime contexts in one process without shared state', () => {
    const first = createRuntimeInstanceContext(validInput());
    const secondInput = validInput();
    secondInput.deploymentId = 'deployment_secondary';
    secondInput.bootId = 'boot_secondary';
    secondInput.claudeRoot = root('claude', 'root-ref:other-claude');
    const second = createRuntimeInstanceContext(secondInput);

    expect(first.deploymentId).toBe(DEPLOYMENT_ID);
    expect(first.claudeRoot.reference).toBe('root-ref:claude');
    expect(second.deploymentId).toBe('deployment_secondary');
    expect(second.claudeRoot.reference).toBe('root-ref:other-claude');
    expect(first).not.toBe(second);
    expect(first.workspaceRoots).not.toBe(second.workspaceRoots);
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { ...validInput(), deploymentId: undefined },
    { ...validInput(), deploymentId: BOOT_ID },
    { ...validInput(), bootId: DEPLOYMENT_ID },
    { ...validInput(), unknown: true },
  ])('rejects missing, unknown, or cross-kind context input %#', (value) => {
    expect(() => createRuntimeInstanceContext(value)).toThrow('runtime-instance-context-invalid');
  });

  it.each([
    { field: 'claudeRoot', value: root('app-data', 'root-ref:claude') },
    { field: 'appDataRoot', value: root('claude', 'root-ref:app-data') },
    { field: 'tempRoot', value: root('logs', 'root-ref:temp') },
    { field: 'logsRoot', value: root('temp', 'root-ref:logs') },
    { field: 'workspaceRoots', value: [root('logs', 'root-ref:workspace')] },
  ])('rejects a cross-kind $field reference', ({ field, value }) => {
    expect(() => createRuntimeInstanceContext({ ...validInput(), [field]: value })).toThrow(
      'runtime-instance-context-invalid'
    );
  });

  it.each([
    undefined,
    null,
    '',
    ' root-ref:leading-space',
    'root-ref:trailing-space ',
    'root-ref:control\u0000',
    1,
    true,
    ['root-ref:mutable-array'],
    { current: 'root-ref:mutable-object' },
    new String('root-ref:boxed-string'),
  ])('rejects a missing, malformed, or mutable root reference value %#', (reference) => {
    expect(() =>
      createRuntimeInstanceContext({
        ...validInput(),
        claudeRoot: root('claude', reference),
      })
    ).toThrow('runtime-instance-context-invalid');
  });

  it('rejects accessors, custom prototypes, sparse arrays, and unknown nested fields', () => {
    const accessorReference = { kind: 'claude' } as Record<string, unknown>;
    Object.defineProperty(accessorReference, 'reference', {
      enumerable: true,
      get: () => 'root-ref:accessor',
    });

    expect(() =>
      createRuntimeInstanceContext({ ...validInput(), claudeRoot: accessorReference })
    ).toThrow('runtime-instance-context-invalid');
    expect(() =>
      createRuntimeInstanceContext({
        ...validInput(),
        claudeRoot: Object.assign(Object.create({ inherited: true }), root('claude', 'root-ref:x')),
      })
    ).toThrow('runtime-instance-context-invalid');
    expect(() =>
      createRuntimeInstanceContext({
        ...validInput(),
        claudeRoot: { ...root('claude', 'root-ref:x'), extra: true },
      })
    ).toThrow('runtime-instance-context-invalid');

    const sparseRoots = new Array(1);
    expect(() =>
      createRuntimeInstanceContext({ ...validInput(), workspaceRoots: sparseRoots })
    ).toThrow('runtime-instance-context-invalid');

    class RootList extends Array<Record<string, unknown>> {}
    expect(() =>
      createRuntimeInstanceContext({
        ...validInput(),
        workspaceRoots: new RootList(root('workspace', 'root-ref:subclass')),
      })
    ).toThrow('runtime-instance-context-invalid');
  });
});
