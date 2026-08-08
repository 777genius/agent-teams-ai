import {
  MAX_WORKSPACE_ALLOWED_OPERATIONS,
  MAX_WORKSPACE_REGISTRATIONS,
  WORKSPACE_OPERATIONS,
} from '@features/workspace-registry/contracts/workspace-registration';
import {
  WorkspaceMountBinding,
  WorkspaceRegistration,
  WorkspaceRegistrationRegistry,
} from '@features/workspace-registry/core/domain/WorkspaceRegistration';
import { parseBootId, parseWorkspaceId, type WorkspaceId } from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

const WORKSPACE_ID = parseWorkspaceId('workspace_00000000000000000000000000000001');
const OTHER_WORKSPACE_ID = parseWorkspaceId('workspace_00000000000000000000000000000002');
const ROOT_HASH = '1'.repeat(64);
const OTHER_ROOT_HASH = '2'.repeat(64);

function registration(
  overrides: Partial<ConstructorParameters<typeof WorkspaceRegistration>[0]> = {}
): WorkspaceRegistration {
  return new WorkspaceRegistration({
    schemaVersion: 1,
    registrationKey: 'operator.workspace.one',
    workspaceId: WORKSPACE_ID,
    displayName: 'Workspace One',
    registrationRevision: 1,
    declaredRootHash: ROOT_HASH,
    enabled: true,
    ...overrides,
  });
}

describe('WorkspaceRegistration', () => {
  it('keeps registrationKey identity stable across restart and permits revisioned display changes', () => {
    const first = new WorkspaceRegistrationRegistry([registration()]);
    const restarted = new WorkspaceRegistrationRegistry(
      [registration({ displayName: 'Renamed Workspace', registrationRevision: 2 })],
      first
    );

    expect(restarted.getByRegistrationKey('operator.workspace.one')?.workspaceId).toBe(
      WORKSPACE_ID
    );
    expect(restarted.requireEnabled(WORKSPACE_ID).displayName).toBe('Renamed Workspace');
  });

  it.each([
    [
      'identity replacement',
      { workspaceId: OTHER_WORKSPACE_ID },
      'workspace-registration-identity-changed',
    ],
    [
      'declared root replacement',
      { declaredRootHash: OTHER_ROOT_HASH },
      'workspace-registration-root-changed',
    ],
    [
      'unrevisioned display mutation',
      { displayName: 'Changed without revision' },
      'workspace-registration-revision-not-advanced',
    ],
  ] as const)('rejects %s for a stable registration key', (_name, overrides, error) => {
    const first = new WorkspaceRegistrationRegistry([registration()]);

    expect(() => new WorkspaceRegistrationRegistry([registration(overrides)], first)).toThrow(
      error
    );
  });

  it('fails closed for disabled registrations', () => {
    const disabled = registration({ enabled: false, registrationRevision: 2 });
    const registry = new WorkspaceRegistrationRegistry([disabled]);

    expect(() => registry.requireEnabled(WORKSPACE_ID)).toThrow('workspace-registration-disabled');
  });

  it('requires an explicit disabled tombstone instead of silently removing a stable key', () => {
    const first = new WorkspaceRegistrationRegistry([registration()]);

    expect(() => new WorkspaceRegistrationRegistry([], first)).toThrow(
      'workspace-registration-removed-without-tombstone'
    );
  });

  it.each([
    [
      'duplicate registration keys',
      [
        registration(),
        registration({ workspaceId: OTHER_WORKSPACE_ID, declaredRootHash: OTHER_ROOT_HASH }),
      ],
      'workspace-registration-key-duplicate',
    ],
    [
      'ambiguous workspace identities',
      [
        registration(),
        registration({
          registrationKey: 'operator.workspace.two',
          declaredRootHash: OTHER_ROOT_HASH,
        }),
      ],
      'workspace-registration-identity-ambiguous',
    ],
    [
      'ambiguous declared roots',
      [
        registration(),
        registration({
          registrationKey: 'operator.workspace.two',
          workspaceId: OTHER_WORKSPACE_ID,
        }),
      ],
      'workspace-registration-root-ambiguous',
    ],
  ] as const)('rejects %s', (_name, registrations, error) => {
    expect(() => new WorkspaceRegistrationRegistry(registrations)).toThrow(error);
  });

  it('bounds and density-checks registration collections before domain iteration', () => {
    const oversized = new Array<WorkspaceRegistration>(MAX_WORKSPACE_REGISTRATIONS + 1);
    Object.defineProperty(oversized, 0, {
      get: () => {
        throw new Error('oversized-registration-iterated');
      },
    });
    const sparse = new Array<WorkspaceRegistration>(2);
    sparse[0] = registration();

    expect(() => new WorkspaceRegistrationRegistry(oversized)).toThrow(
      'workspace-registration-collection-limit-exceeded'
    );
    expect(() => new WorkspaceRegistrationRegistry(sparse)).toThrow(
      'workspace-registration-collection-sparse'
    );
  });
});

describe('WorkspaceMountBinding', () => {
  function binding(
    overrides: {
      workspaceId?: WorkspaceId;
      mountGeneration?: number;
      previousMountGeneration?: number;
      declaredRootHash?: string;
      enabled?: boolean;
      health?: 'healthy' | 'read-only' | 'unavailable';
      allowedOperations?: readonly (typeof WORKSPACE_OPERATIONS)[number][];
    } = {}
  ): WorkspaceMountBinding {
    return new WorkspaceMountBinding({
      registration: registration({
        workspaceId: overrides.workspaceId ?? WORKSPACE_ID,
        enabled: overrides.enabled ?? true,
      }),
      bootId: parseBootId('boot_workspace_registry_current'),
      mountGeneration: overrides.mountGeneration ?? 8,
      previousMountGeneration:
        'previousMountGeneration' in overrides ? overrides.previousMountGeneration : 7,
      declaredRootHash: overrides.declaredRootHash ?? ROOT_HASH,
      observedAt: 100,
      health: overrides.health ?? 'healthy',
      allowedOperations: overrides.allowedOperations ?? [WORKSPACE_OPERATIONS[0]],
    });
  }

  it('binds one boot and advances the prior mount generation', () => {
    const current = binding();

    expect(current.bootId).toBe('boot_workspace_registry_current');
    expect(current.mountGeneration).toBe(8);
    expect(current.allows(WORKSPACE_OPERATIONS[0])).toBe(true);
    expect(current.allows(WORKSPACE_OPERATIONS[1])).toBe(false);
  });

  it('rejects stale or skipped generations and a changed declared root', () => {
    expect(() => binding({ mountGeneration: 7 })).toThrow(
      'workspace-mount-generation-not-advanced'
    );
    expect(() => binding({ mountGeneration: 9 })).toThrow(
      'workspace-mount-generation-not-advanced'
    );
    expect(() => binding({ declaredRootHash: OTHER_ROOT_HASH })).toThrow(
      'workspace-mount-declared-root-mismatch'
    );
  });

  it('requires generation one when no prior binding evidence exists', () => {
    expect(() => binding({ previousMountGeneration: undefined, mountGeneration: 2 })).toThrow(
      'workspace-mount-initial-generation-invalid'
    );
    expect(
      binding({ previousMountGeneration: undefined, mountGeneration: 1 }).mountGeneration
    ).toBe(1);
  });

  it('rejects disabled bindings and mutation authorization on a read-only mount', () => {
    expect(() => binding({ enabled: false })).toThrow('workspace-registration-disabled');
    expect(() =>
      binding({ health: 'read-only', allowedOperations: [WORKSPACE_OPERATIONS[1]] })
    ).toThrow('workspace-mount-read-only-operation-invalid');
  });

  it('bounds, density-checks, and validates operation collections before use', () => {
    const oversized = new Array(MAX_WORKSPACE_ALLOWED_OPERATIONS + 1);
    Object.defineProperty(oversized, 0, {
      get: () => {
        throw new Error('oversized-operation-iterated');
      },
    });
    const sparse = new Array<(typeof WORKSPACE_OPERATIONS)[number]>(2);
    sparse[0] = WORKSPACE_OPERATIONS[0];

    expect(() => binding({ allowedOperations: oversized })).toThrow(
      'workspace-allowed-operations-limit-exceeded'
    );
    expect(() => binding({ allowedOperations: sparse })).toThrow(
      'workspace-allowed-operations-sparse'
    );
    expect(() =>
      binding({ allowedOperations: [WORKSPACE_OPERATIONS[0], WORKSPACE_OPERATIONS[0]] })
    ).toThrow('workspace-allowed-operation-duplicate');
    expect(() => binding({ allowedOperations: [null] as never })).toThrow(
      'workspace-operation-unsupported'
    );
  });
});
