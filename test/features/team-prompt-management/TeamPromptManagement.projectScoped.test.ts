import { describe, expect, it, vi } from 'vitest';

import { TeamManagementError } from '../../../src/features/team-prompt-management/core/managementPolicy';
import { TeamPromptManagement } from '../../../src/features/team-prompt-management/main';

import type { ProjectDefinitionKind } from '../../../src/features/team-prompt-management/main';

const context = { appInstanceId: 'app', dataRootFingerprint: 'root', connectionGeneration: 1 };
const body = {
  expectedContext: context,
  expectedRevision: 'rev',
  metadata: { description: 'changed from outside' },
};
const trashBody = { expectedContext: context, expectedRevision: 'rev' };

/**
 * `read` is the configuration read of the real class (it refuses missing and
 * malformed teams with specific codes); it is replaced by a small in-memory
 * team so the unit test does not depend on the machine's team directory, and
 * the meta store writes land in that team.
 */
function management(options: {
  classify?: () => Promise<ProjectDefinitionKind>;
  assertEditable?: () => Promise<void>;
  refreshCopies?: () => Promise<void>;
  read?: () => Promise<unknown>;
  runtimeState?: { isAlive: boolean; progress: { state: string } | null };
}) {
  const order: string[] = [];
  let meta: Record<string, unknown> = { description: 'old', displayName: 'Builders' };
  const snapshot = () => ({
    configurationRevision: 'rev',
    config: null,
    meta: { ...meta },
    members: [],
    membersMetadataPresent: false,
    savedRequest: null,
  });
  const ports = {
    run: vi.fn(async (_name: string, operation: () => Promise<unknown>) => {
      order.push('lock:enter');
      try {
        return await operation();
      } finally {
        order.push('lock:exit');
      }
    }),
    withExpectedContext: vi.fn(async (_expected: unknown, operation: () => Promise<unknown>) =>
      operation()
    ),
    getContext: vi.fn(),
    getRuntimeState: vi.fn(async () => options.runtimeState ?? { isAlive: false, progress: null }),
    projectDefinition: {
      classify: vi.fn(options.classify ?? (async () => 'native' as const)),
      assertEditable: vi.fn(async () => {
        order.push('assertEditable');
        await options.assertEditable?.();
      }),
      refreshCopies: vi.fn(async () => {
        order.push('refreshCopies');
        await options.refreshCopies?.();
      }),
    },
    getSavedRequest: vi.fn(async () => null),
    getTeamData: vi.fn(),
    createTeamConfig: vi.fn(),
    updateConfig: vi.fn(),
    replaceMembers: vi.fn(),
    deleteTeam: vi.fn(),
    emit: vi.fn(),
  };
  const instance = new TeamPromptManagement(ports as never);
  vi.spyOn(instance as never, 'read').mockImplementation((options.read ?? (async () => snapshot())) as never);
  const updateMeta = vi
    .spyOn((instance as unknown as { metaStore: { updateMeta: unknown } }).metaStore as never, 'updateMeta' as never)
    .mockImplementation((async (_name: string, update: (current: unknown) => Record<string, unknown>) => {
      order.push('write');
      meta = update(meta);
    }) as never);
  return { ports, management: instance, updateMeta, order };
}

describe('external (HTTP/MCP) edits of teams with separate history per project', () => {
  it('writes the definition of a per-project team only after the stopped gate, then refreshes the copies', async () => {
    const m = management({ classify: async () => 'logical' });
    const result = await m.management.update('builders', body);
    expect(result).toMatchObject({ teamName: 'builders', changed: true });
    // The gate, the write and the projection all happen inside the one operation lock.
    expect(m.order).toEqual([
      'lock:enter',
      'assertEditable',
      'write',
      'refreshCopies',
      'lock:exit',
    ]);
    expect(m.ports.run).toHaveBeenCalledWith('builders', expect.any(Function));
  });

  it('writes nothing and refreshes nothing while a project of the team is running', async () => {
    const m = management({
      classify: async () => 'logical',
      assertEditable: async () => {
        throw new TeamManagementError('TEAM_ACTIVE', 'This team is running in a project');
      },
    });
    await expect(m.management.update('builders', body)).rejects.toMatchObject({
      code: 'TEAM_ACTIVE',
    });
    expect(m.updateMeta).not.toHaveBeenCalled();
    expect(m.ports.replaceMembers).not.toHaveBeenCalled();
    expect(m.ports.projectDefinition.refreshCopies).not.toHaveBeenCalled();
  });

  it('refuses a project copy with its own code, before the gate and before any write', async () => {
    const m = management({ classify: async () => 'alias' });
    await expect(m.management.update('ptc-builders-a', body)).rejects.toMatchObject({
      code: 'PROJECT_COPY_NOT_EDITABLE',
    });
    expect(m.ports.projectDefinition.assertEditable).not.toHaveBeenCalled();
    expect(m.updateMeta).not.toHaveBeenCalled();
  });

  it('refuses a project copy with its own code even while the copy runs or launches', async () => {
    for (const runtimeState of [
      { isAlive: true, progress: null },
      { isAlive: false, progress: { state: 'spawning' } },
    ]) {
      const m = management({ classify: async () => 'alias', runtimeState });
      await expect(m.management.update('ptc-builders-a', body)).rejects.toMatchObject({
        code: 'PROJECT_COPY_NOT_EDITABLE',
      });
      expect(m.updateMeta).not.toHaveBeenCalled();
    }
  });

  it('still asks to stop a running or launching ordinary or per-project team', async () => {
    const running = management({
      classify: async () => 'native',
      runtimeState: { isAlive: true, progress: null },
    });
    await expect(running.management.update('legacy', body)).rejects.toMatchObject({
      code: 'TEAM_ACTIVE',
    });
    const launching = management({
      classify: async () => 'logical',
      runtimeState: { isAlive: false, progress: { state: 'spawning' } },
    });
    await expect(launching.management.update('builders', body)).rejects.toMatchObject({
      code: 'TEAM_PROVISIONING',
    });
    expect(launching.ports.projectDefinition.assertEditable).not.toHaveBeenCalled();
  });

  it('rejects an existing team whose kind cannot be determined, before any write (update and trash)', async () => {
    const m = management({
      classify: async () => {
        throw new Error('Team metadata is unreadable');
      },
    });
    await expect(m.management.update('broken', body)).rejects.toMatchObject({
      code: 'TEAM_METADATA_UNREADABLE',
    });
    await expect(m.management.trash('broken', trashBody)).rejects.toMatchObject({
      code: 'TEAM_METADATA_UNREADABLE',
    });
    expect(m.ports.projectDefinition.assertEditable).not.toHaveBeenCalled();
    expect(m.updateMeta).not.toHaveBeenCalled();
    expect(m.ports.replaceMembers).not.toHaveBeenCalled();
    expect(m.ports.deleteTeam).not.toHaveBeenCalled();
  });

  it('keeps trashing a per-project team in the app, and refuses to trash a project copy', async () => {
    const logical = management({ classify: async () => 'logical' });
    await expect(logical.management.trash('builders', trashBody)).rejects.toMatchObject({
      code: 'PROJECT_TEAM_DESKTOP_ONLY',
    });
    expect(logical.ports.deleteTeam).not.toHaveBeenCalled();
    expect(logical.ports.projectDefinition.assertEditable).not.toHaveBeenCalled();
    const alias = management({ classify: async () => 'alias' });
    await expect(alias.management.trash('ptc-builders-a', trashBody)).rejects.toMatchObject({
      code: 'PROJECT_COPY_NOT_EDITABLE',
    });
    expect(alias.ports.deleteTeam).not.toHaveBeenCalled();
  });

  it('a failed refresh of the copies does not undo or fail the saved edit', async () => {
    const m = management({
      classify: async () => 'logical',
      refreshCopies: async () => {
        throw new Error('copy is busy');
      },
    });
    await expect(m.management.update('builders', body)).resolves.toMatchObject({ changed: true });
    expect(m.order).toEqual([
      'lock:enter',
      'assertEditable',
      'write',
      'refreshCopies',
      'lock:exit',
    ]);
  });

  it('does not refresh the copies when the edit changed nothing', async () => {
    const m = management({ classify: async () => 'logical' });
    await m.management.update('builders', {
      ...body,
      metadata: { description: 'old' },
    });
    expect(m.updateMeta).not.toHaveBeenCalled();
    expect(m.ports.projectDefinition.refreshCopies).not.toHaveBeenCalled();
  });

  it('a team that does not exist is refused by the configuration read with its own code', async () => {
    const m = management({
      read: async () => {
        throw new TeamManagementError('TEAM_UNSUPPORTED', 'No supported saved team configuration');
      },
    });
    await expect(m.management.update('missing', body)).rejects.toMatchObject({
      code: 'TEAM_UNSUPPORTED',
    });
    expect(m.ports.projectDefinition.classify).not.toHaveBeenCalled();
  });

  it('keeps ordinary teams on the existing admission path, without the per-project gate', async () => {
    const m = management({ classify: async () => 'native' });
    await expect(
      m.management.update('legacy', { ...body, expectedRevision: 'stale' })
    ).rejects.toMatchObject({ code: 'TEAM_REVISION_MISMATCH' });
    await expect(m.management.update('legacy', body)).resolves.toMatchObject({ changed: true });
    expect(m.ports.projectDefinition.assertEditable).not.toHaveBeenCalled();
    expect(m.ports.projectDefinition.refreshCopies).not.toHaveBeenCalled();
  });
});
