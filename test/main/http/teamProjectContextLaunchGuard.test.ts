import { describe, expect, it, vi } from 'vitest';

import { rejectUnsupportedProjectContextHttpLaunch } from '../../../src/main/http/teamProjectContextLaunchGuard';

function meta(mode?: 'shared' | 'per_project') {
  return {
    getMeta: vi.fn(async () => mode
      ? { version: 1 as const, cwd: '', createdAt: 1, projectContextMode: mode }
      : null),
    metadataFileExists: vi.fn(async () => false),
  };
}

describe('HTTP project-context launch boundary', () => {
  it('preserves old shared HTTP launches', async () => {
    await expect(rejectUnsupportedProjectContextHttpLaunch('legacy', meta()))
      .resolves.toBe('legacy');
    await expect(rejectUnsupportedProjectContextHttpLaunch('explicit-shared', meta('shared')))
      .resolves.toBe('explicit-shared');
  });

  it('rejects project-scoped logical team launches before native spawn', async () => {
    await expect(rejectUnsupportedProjectContextHttpLaunch('builders', meta('per_project')))
      .rejects.toThrow('desktop project-context API');
  });

  it('rejects opaque internal team names and unreadable metadata', async () => {
    await expect(rejectUnsupportedProjectContextHttpLaunch(
      'ptc-abcdef0123456789abcdef01', meta()
    )).rejects.toThrow('cannot be launched directly');
    const unreadable = meta();
    unreadable.metadataFileExists.mockResolvedValue(true);
    await expect(rejectUnsupportedProjectContextHttpLaunch('builders', unreadable))
      .rejects.toThrow('unreadable');
  });
});
