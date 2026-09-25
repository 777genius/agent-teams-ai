import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import { WorkspaceMountBinding, WorkspaceRegistration } from '@features/workspace-registry';
import { createProductTaskMutationAuthority } from '@main/composition/hosted/createProductTaskMutationAuthority';
import { createHostedTaskBoardMutationFileAuthority } from '@main/composition/hosted/hostedTaskBoardMutationFileAuthority';
import { ProductTaskMutationAuthority } from '@main/composition/hosted/productTaskMutationAuthority';
import { ensureProductTaskWriteLockDirectory } from '@main/utils/productTaskWriteAuthorityLock';
import { parseBootId, parseDeploymentId, parseWorkspaceId } from '@shared/contracts/hosted';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CreateProductTaskMutationAuthorityOptions } from '@main/composition/hosted/createProductTaskMutationAuthority';

vi.mock('@main/composition/hosted/hostedTaskBoardMutationFileAuthority', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@main/composition/hosted/hostedTaskBoardMutationFileAuthority')
    >();
  return {
    ...actual,
    createHostedTaskBoardMutationFileAuthority: vi.fn(
      actual.createHostedTaskBoardMutationFileAuthority
    ),
  };
});

const BOOT_ID = parseBootId(`boot_${'a'.repeat(32)}`);
const DEPLOYMENT_ID = parseDeploymentId(`deployment_${'b'.repeat(32)}`);
const OWNER = Object.freeze({
  ownerAuthority: 'owner-authority_test',
  ownerGeneration: 1,
  ownerSessionId: 'owner-session_test',
  socketIdentity: Object.freeze({ device: '1', inode: '1', uid: 1000, gid: 1000, mode: 0o600 }),
});
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function mountBinding(health: 'healthy' | 'read-only'): WorkspaceMountBinding {
  const registration = new WorkspaceRegistration({
    schemaVersion: 1,
    registrationKey: 'registration-product-task-mutation',
    workspaceId: parseWorkspaceId(`workspace_${'c'.repeat(32)}`),
    displayName: 'Product task mutation',
    registrationRevision: 1,
    declaredRootHash: 'd'.repeat(64),
    enabled: true,
  });
  return new WorkspaceMountBinding({
    registration,
    bootId: BOOT_ID,
    mountGeneration: 1,
    declaredRootHash: registration.declaredRootHash,
    observedAt: 1,
    health,
    allowedOperations: [],
  });
}

function options(
  overrides: Partial<CreateProductTaskMutationAuthorityOptions> = {}
): CreateProductTaskMutationAuthorityOptions {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'product-task-mutation-'));
  roots.push(root);
  return {
    runtimeInstance: createRuntimeInstanceContext({
      deploymentId: DEPLOYMENT_ID,
      bootId: BOOT_ID,
      claudeRoot: { kind: 'claude', reference: join(root, 'claude') },
      appDataRoot: { kind: 'app-data', reference: join(root, 'app-data') },
      workspaceRoots: [{ kind: 'workspace', reference: join(root, 'workspace') }],
      tempRoot: { kind: 'temp', reference: join(root, 'temp') },
      logsRoot: { kind: 'logs', reference: join(root, 'logs') },
    }),
    mountBinding: mountBinding('healthy'),
    teamIdentities: {
      listTeamIdentities: () => Promise.resolve([]),
      getTeamIdentity: () => Promise.resolve(null),
    },
    productAuthorityLockDirectory: ensureProductTaskWriteLockDirectory(root),
    expectedOwnerBinding: OWNER,
    currentOwnerBinding: () => OWNER,
    restoreGeneration: 1,
    taskWriteCurrent: { resolveCurrent: vi.fn(async () => null) },
    writerEpochAuthority: { lookupAuthority: vi.fn(() => Promise.resolve(null)) },
    externalWriterSupervisor: () => null,
    ...overrides,
  };
}

describe('Product task mutation authority composition', () => {
  it('composes the Product writer when every prerequisite is present', () => {
    const composed = options();
    const authority = createProductTaskMutationAuthority(composed);
    expect(authority).toBeInstanceOf(ProductTaskMutationAuthority);
    expect(typeof authority?.admitTaskMutation).toBe('function');
    expect(typeof authority?.bindGrantFence).toBe('function');
    // Without the writer epoch source a superseded writer's prepared WAL would block the board.
    expect(createHostedTaskBoardMutationFileAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ writerEpochAuthority: composed.writerEpochAuthority })
    );
  });

  it.each([
    ['a degraded mount', { mountBinding: mountBinding('read-only') }],
    ['no promotion storage', { taskWriteCurrent: null }],
    ['no writer epoch authority', { writerEpochAuthority: null }],
    ['no Product lock directory', { productAuthorityLockDirectory: undefined }],
    ['no launcher-signed Owner binding', { expectedOwnerBinding: null }],
  ] as const)('advertises no mutation capability with %s', (_case, overrides) => {
    expect(createProductTaskMutationAuthority(options(overrides))).toBeNull();
  });
});
