import { describe, expect, it, vi } from 'vitest';

import { TeamManagementError } from '../../../src/features/team-prompt-management/core/managementPolicy';
import { TeamPromptManagement } from '../../../src/features/team-prompt-management/main';

const body = {
  expectedContext: { appInstanceId: 'app', dataRootFingerprint: 'root', connectionGeneration: 1 },
  expectedRevision: 'rev',
  metadata: { description: 'changed from outside' },
};

const snapshot = {
  configurationRevision: 'rev',
  config: null,
  meta: {},
  members: [],
  membersMetadataPresent: false,
  savedRequest: null,
};

/**
 * `read` is the configuration read of the real class (it refuses missing and
 * malformed teams with specific codes); it is stubbed here so the unit test
 * does not depend on the machine's team directory.
 */
function management(
  isProjectScoped: () => Promise<boolean>,
  read: () => Promise<unknown> = async () => snapshot
) {
  const ports = {
    run: vi.fn(async (_name: string, operation: () => Promise<unknown>) => operation()),
    withExpectedContext: vi.fn(async (_expected: unknown, operation: () => Promise<unknown>) => operation()),
    getContext: vi.fn(),
    getRuntimeState: vi.fn(async () => ({ isAlive: false, progress: null })),
    isProjectScoped: vi.fn(isProjectScoped),
    getSavedRequest: vi.fn(async () => null),
    getTeamData: vi.fn(),
    createTeamConfig: vi.fn(),
    updateConfig: vi.fn(),
    replaceMembers: vi.fn(),
    deleteTeam: vi.fn(),
    emit: vi.fn(),
  };
  const instance = new TeamPromptManagement(ports as never);
  vi.spyOn(instance as never, 'read').mockImplementation(read as never);
  return { ports, management: instance };
}

describe('external (HTTP/MCP) team edits and project-scoped teams', () => {
  it('refuses an update of a per-project team or of a project copy and writes nothing', async () => {
    const m = management(async () => true);
    await expect(m.management.update('builders', body)).rejects.toMatchObject({
      code: 'PROJECT_TEAM_DESKTOP_ONLY',
    });
    expect(m.ports.updateConfig).not.toHaveBeenCalled();
    expect(m.ports.replaceMembers).not.toHaveBeenCalled();
  });

  it('refuses trash for the same teams', async () => {
    const m = management(async () => true);
    await expect(
      m.management.trash('builders', {
        expectedContext: body.expectedContext,
        expectedRevision: body.expectedRevision,
      })
    ).rejects.toMatchObject({ code: 'PROJECT_TEAM_DESKTOP_ONLY' });
    expect(m.ports.deleteTeam).not.toHaveBeenCalled();
  });

  it('rejects an existing team whose kind cannot be determined, before any write (update and trash)', async () => {
    const m = management(async () => {
      throw new Error('Team metadata is unreadable');
    });
    await expect(m.management.update('broken', body)).rejects.toMatchObject({
      code: 'TEAM_METADATA_UNREADABLE',
    });
    await expect(
      m.management.trash('broken', {
        expectedContext: body.expectedContext,
        expectedRevision: body.expectedRevision,
      })
    ).rejects.toMatchObject({ code: 'TEAM_METADATA_UNREADABLE' });
    expect(m.ports.updateConfig).not.toHaveBeenCalled();
    expect(m.ports.replaceMembers).not.toHaveBeenCalled();
    expect(m.ports.deleteTeam).not.toHaveBeenCalled();
  });

  it('a team that does not exist is refused by the configuration read with its own code', async () => {
    const m = management(
      async () => false,
      async () => {
        throw new TeamManagementError('TEAM_UNSUPPORTED', 'No supported saved team configuration');
      }
    );
    await expect(m.management.update('missing', body)).rejects.toMatchObject({
      code: 'TEAM_UNSUPPORTED',
    });
    expect(m.ports.isProjectScoped).not.toHaveBeenCalled();
  });

  it('keeps ordinary teams on the existing admission path', async () => {
    const m = management(async () => false);
    await expect(
      m.management.update('legacy', { ...body, expectedRevision: 'stale' })
    ).rejects.toMatchObject({ code: 'TEAM_REVISION_MISMATCH' });
  });
});
