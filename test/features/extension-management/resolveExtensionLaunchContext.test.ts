import { describe, expect, it } from 'vitest';

import { resolveExtensionLaunchContext } from '../../../src/features/extension-management/main/infrastructure/resolveExtensionLaunchContext';

import type { TeamCreateRequest } from '../../../src/shared/types/team';

const saved: TeamCreateRequest = {
  teamName: 'saved',
  cwd: '/old-project',
  providerId: 'anthropic',
  members: [
    { name: 'inherited' },
    { name: 'native-member', providerId: 'codex', cwd: '/member-project' },
  ],
};

describe('effective launch extension context', () => {
  it('uses explicit provider and cwd overrides while retaining actual member selections', () => {
    expect(
      resolveExtensionLaunchContext(
        { teamName: 'saved', providerId: 'opencode', cwd: '/new-project' },
        saved
      )
    ).toEqual({
      providers: ['opencode', 'opencode', 'codex'],
      projectPaths: ['/new-project', '/member-project'],
    });
  });
  it('uses saved state for member restart commands without launch overrides', () => {
    expect(resolveExtensionLaunchContext({ teamName: 'saved' }, saved)).toEqual({
      providers: ['anthropic', 'anthropic', 'codex'],
      projectPaths: ['/old-project', '/member-project'],
    });
  });
  it('uses a new creation roster and stays conservative when the saved roster is unknown', () => {
    expect(
      resolveExtensionLaunchContext(
        { ...saved, cwd: '/created', providerId: 'codex', members: [] },
        null
      )
    ).toEqual({ providers: ['codex'], projectPaths: ['/created'] });
    expect(
      resolveExtensionLaunchContext(
        { teamName: 'unknown', providerId: 'opencode', cwd: '/explicit' },
        null
      )
    ).toEqual({ providers: [], projectPaths: ['/explicit'] });
  });
});
