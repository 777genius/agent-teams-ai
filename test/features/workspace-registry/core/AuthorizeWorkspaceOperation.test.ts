import { WORKSPACE_OPERATIONS } from '@features/workspace-registry/contracts/workspace-registration';
import {
  AuthorizeWorkspaceOperation,
  type WorkspaceMountBindingSource,
} from '@features/workspace-registry/core/application/AuthorizeWorkspaceOperation';
import {
  WorkspaceMountBinding,
  WorkspaceRegistration,
} from '@features/workspace-registry/core/domain/WorkspaceRegistration';
import { parseBootId, parseWorkspaceId } from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

const workspaceId = parseWorkspaceId('workspace_00000000000000000000000000000001');
const unknownWorkspaceId = parseWorkspaceId('workspace_00000000000000000000000000000002');
const bootId = parseBootId('boot_workspace_registry_current');

function binding(
  overrides: Partial<ConstructorParameters<typeof WorkspaceMountBinding>[0]> = {}
): WorkspaceMountBinding {
  return new WorkspaceMountBinding({
    registration: new WorkspaceRegistration({
      schemaVersion: 1,
      registrationKey: 'operator.workspace.one',
      workspaceId,
      displayName: 'Workspace One',
      registrationRevision: 1,
      declaredRootHash: '1'.repeat(64),
      enabled: true,
    }),
    bootId,
    mountGeneration: 3,
    previousMountGeneration: 2,
    declaredRootHash: '1'.repeat(64),
    observedAt: 100,
    health: 'healthy',
    allowedOperations: [WORKSPACE_OPERATIONS[0]],
    ...overrides,
  });
}

function useCase(
  current: WorkspaceMountBinding | undefined = binding()
): AuthorizeWorkspaceOperation {
  const source: WorkspaceMountBindingSource = {
    getRevalidatedBinding: (requestedWorkspaceId) =>
      requestedWorkspaceId === workspaceId ? current : undefined,
  };
  return new AuthorizeWorkspaceOperation(source);
}

describe('AuthorizeWorkspaceOperation', () => {
  it('returns an exact-operation, server-only intent with no raw path or generic filesystem accessor', () => {
    const intent = useCase().execute({
      workspaceId,
      bootId,
      mountGeneration: 3,
      operation: WORKSPACE_OPERATIONS[0],
    });

    expect(intent).toMatchObject({
      workspaceId,
      bootId,
      mountGeneration: 3,
      operation: WORKSPACE_OPERATIONS[0],
    });
    expect('path' in intent).toBe(false);
    expect('rootPath' in intent).toBe(false);
    expect('filesystem' in intent).toBe(false);
    expect(Object.keys(intent)).toEqual([]);
    expect(structuredClone(intent)).toEqual({});
    expect(() => JSON.stringify(intent)).toThrow(
      'workspace-operation-authorization-intent-not-serializable'
    );
  });

  it('rejects prior-boot and stale-generation requests', () => {
    const authorize = useCase();

    expect(() =>
      authorize.execute({
        workspaceId,
        bootId: parseBootId('boot_workspace_registry_prior'),
        mountGeneration: 3,
        operation: WORKSPACE_OPERATIONS[0],
      })
    ).toThrow('workspace-operation-prior-boot-rejected');
    expect(() =>
      authorize.execute({
        workspaceId,
        bootId,
        mountGeneration: 2,
        operation: WORKSPACE_OPERATIONS[0],
      })
    ).toThrow('workspace-operation-stale-generation-rejected');
  });

  it('rejects a different operation, an unhealthy binding, and an unknown workspace', () => {
    expect(() =>
      useCase().execute({
        workspaceId,
        bootId,
        mountGeneration: 3,
        operation: WORKSPACE_OPERATIONS[1],
      })
    ).toThrow('workspace-operation-not-authorized');
    expect(() =>
      useCase(binding({ health: 'unavailable' })).execute({
        workspaceId,
        bootId,
        mountGeneration: 3,
        operation: WORKSPACE_OPERATIONS[0],
      })
    ).toThrow('workspace-operation-not-authorized');
    expect(() =>
      useCase().execute({
        workspaceId: unknownWorkspaceId,
        bootId,
        mountGeneration: 3,
        operation: WORKSPACE_OPERATIONS[0],
      })
    ).toThrow('workspace-operation-binding-not-found');
  });

  it('rejects binding evidence for a different workspace than the requested identity', () => {
    const mismatchedBinding = binding({
      registration: new WorkspaceRegistration({
        schemaVersion: 1,
        registrationKey: 'operator.workspace.two',
        workspaceId: unknownWorkspaceId,
        displayName: 'Workspace Two',
        registrationRevision: 1,
        declaredRootHash: '1'.repeat(64),
        enabled: true,
      }),
    });

    expect(() =>
      useCase(mismatchedBinding).execute({
        workspaceId,
        bootId,
        mountGeneration: 3,
        operation: WORKSPACE_OPERATIONS[0],
      })
    ).toThrow('workspace-operation-binding-identity-mismatch');
  });
});
