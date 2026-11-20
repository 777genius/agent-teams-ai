import { describe, expect, it, vi } from 'vitest';

import { TeamPromptManagement } from '../../../src/features/team-prompt-management/main';

const body = {
  expectedContext: { appInstanceId: 'app', dataRootFingerprint: 'root', connectionGeneration: 1 },
  expectedRevision: 'rev',
  metadata: { description: 'changed from outside' },
};

function management(isProjectScoped: () => Promise<boolean>) {
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
  return { ports, management: new TeamPromptManagement(ports as never) };
}

describe('external (HTTP/MCP) team edits and project-scoped teams', () => {
  it('refuses an update of a per-project team or of a project copy and writes nothing', async () => {
    const m = management(async () => true);
    await expect(m.management.update('builders', body)).rejects.toMatchObject({
      code: 'PROJECT_TEAM_DESKTOP_ONLY',
    });
    expect(m.ports.getRuntimeState).not.toHaveBeenCalled();
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

  it('fails closed when it cannot tell what kind of team this is', async () => {
    const m = management(async () => {
      throw new Error('Team metadata is unreadable');
    });
    await expect(m.management.update('broken', body)).rejects.toMatchObject({
      code: 'TEAM_METADATA_UNREADABLE',
    });
    expect(m.ports.updateConfig).not.toHaveBeenCalled();
  });

  it('keeps ordinary teams on the existing admission path', async () => {
    const m = management(async () => false);
    await m.management.update('legacy', body).catch(() => undefined);
    expect(m.ports.getRuntimeState).toHaveBeenCalledWith('legacy');
  });
});
