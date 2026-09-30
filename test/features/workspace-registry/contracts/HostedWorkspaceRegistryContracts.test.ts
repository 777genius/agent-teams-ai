import {
  HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
  parseHostedWorkspaceRegistryListRequest,
  parseHostedWorkspaceRegistryListResponse,
  parseHostedWorkspaceRegistrySelectRequest,
  parseHostedWorkspaceRegistrySelectResponse,
} from '@features/workspace-registry/contracts';
import { describe, expect, it } from 'vitest';

const WORKSPACE_ID = `workspace_${'a'.repeat(32)}`;

function workspace() {
  return {
    workspaceId: WORKSPACE_ID,
    label: 'Workspace 1',
    registrationRevision: 2,
    mount: {
      bootId: 'boot_workspace_contract',
      mountGeneration: 3,
      observedAt: 123,
      health: 'healthy',
      capabilities: ['git.status.read', 'git.branch.read'],
    },
  };
}

describe('hosted workspace registry contracts', () => {
  it('accepts and freezes bounded list and selection DTOs', () => {
    const listRequest = parseHostedWorkspaceRegistryListRequest({
      schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
    });
    const selectRequest = parseHostedWorkspaceRegistrySelectRequest({
      schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
      workspaceId: WORKSPACE_ID,
    });
    const list = parseHostedWorkspaceRegistryListResponse({
      schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
      kind: 'workspace-list',
      workspaces: [workspace()],
    });
    const selection = parseHostedWorkspaceRegistrySelectResponse({
      schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
      kind: 'workspace-selection',
      workspace: workspace(),
    });

    expect(selectRequest.workspaceId).toBe(WORKSPACE_ID);
    expect(list.workspaces[0]?.mount.capabilities).toEqual(['git.status.read', 'git.branch.read']);
    expect(selection.workspace.workspaceId).toBe(WORKSPACE_ID);
    for (const value of [
      listRequest,
      selectRequest,
      list,
      list.workspaces,
      list.workspaces[0],
      list.workspaces[0]?.mount,
      list.workspaces[0]?.mount.capabilities,
      selection,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it.each([null, {}, { schemaVersion: 2 }, { schemaVersion: 1, extra: '/private/root' }])(
    'rejects malformed list requests: %j',
    (value) => {
      expect(() => parseHostedWorkspaceRegistryListRequest(value)).toThrow(TypeError);
    }
  );

  it('rejects malformed, sparse, duplicate-capability, and private response fields', () => {
    const sparse = [workspace(), workspace()];
    delete sparse[0];

    for (const value of [
      {
        schemaVersion: 1,
        kind: 'workspace-list',
        workspaces: sparse,
      },
      {
        schemaVersion: 1,
        kind: 'workspace-list',
        workspaces: [
          {
            ...workspace(),
            mount: {
              ...workspace().mount,
              capabilities: ['git.status.read', 'git.status.read'],
            },
          },
        ],
      },
      {
        schemaVersion: 1,
        kind: 'workspace-selection',
        workspace: { ...workspace(), declaredRootHash: 'private' },
      },
      {
        schemaVersion: 1,
        kind: 'workspace-selection',
        workspace: {
          ...workspace(),
          mount: { ...workspace().mount, root: '/srv/private/workspace' },
        },
      },
      {
        schemaVersion: 1,
        kind: 'workspace-selection',
        workspace: { ...workspace(), label: '/srv/private/workspace' },
      },
      {
        schemaVersion: 1,
        kind: 'workspace-selection',
        workspace: { ...workspace(), label: 'Workspace 257' },
      },
      {
        schemaVersion: 1,
        kind: 'workspace-selection',
        workspace: {
          ...workspace(),
          mount: { ...workspace().mount, health: 'unavailable', capabilities: ['git.status.read'] },
        },
      },
      {
        schemaVersion: 1,
        kind: 'workspace-selection',
        workspace: {
          ...workspace(),
          mount: {
            ...workspace().mount,
            health: 'read-only',
            capabilities: ['git.repository.initialize'],
          },
        },
      },
      {
        schemaVersion: 1,
        kind: 'workspace-selection',
        workspace: {
          ...workspace(),
          mount: {
            ...workspace().mount,
            capabilities: ['git.branch.read', 'git.status.read'],
          },
        },
      },
    ]) {
      const parser =
        (value as { kind?: string }).kind === 'workspace-list'
          ? parseHostedWorkspaceRegistryListResponse
          : parseHostedWorkspaceRegistrySelectResponse;
      expect(() => parser(value as never)).toThrow(TypeError);
    }
  });
});
