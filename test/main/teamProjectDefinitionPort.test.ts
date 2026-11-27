import { describe, expect, it, vi } from 'vitest';

import { TeamProjectContextLaunchConflictError } from '../../src/features/team-project-context/main';

const editor = {
  classify: vi.fn(),
  assertEditable: vi.fn(),
};

vi.mock('../../src/main/ipc/teams/teamProjectDefinitionEdit', () => ({
  buildEditor: () => editor,
  refreshProjectCopies: vi.fn(async () => undefined),
}));

import { createTeamProjectDefinitionPort } from '../../src/main/teamProjectDefinitionPort';

const port = createTeamProjectDefinitionPort({} as never);

describe('createTeamProjectDefinitionPort', () => {
  it.each([
    ['launching', 'TEAM_PROVISIONING'],
    ['unreconciled', 'TEAM_PROJECT_CONTEXT_UNRECONCILED'],
    ['running', 'TEAM_ACTIVE'],
  ] as const)('answers a %s project with %s', async (reason, code) => {
    editor.assertEditable.mockRejectedValueOnce(
      new TeamProjectContextLaunchConflictError(`a project is ${reason}`, reason)
    );
    await expect(port.assertEditable('builders')).rejects.toMatchObject({
      code,
      message: expect.stringContaining(`a project is ${reason}`),
    });
  });

  it('treats a conflict without a stated reason as a running project', async () => {
    editor.assertEditable.mockRejectedValueOnce(new TeamProjectContextLaunchConflictError('busy'));
    await expect(port.assertEditable('builders')).rejects.toMatchObject({ code: 'TEAM_ACTIVE' });
  });

  it('lets any other gate failure propagate so nothing is written when the state is unknown', async () => {
    const unreadable = new Error('context index unreadable');
    editor.assertEditable.mockRejectedValueOnce(unreadable);
    await expect(port.assertEditable('builders')).rejects.toBe(unreadable);
  });

  it('resolves when every project is stopped', async () => {
    editor.assertEditable.mockResolvedValueOnce(undefined);
    await expect(port.assertEditable('builders')).resolves.toBeUndefined();
  });
});
