import { afterEach, describe, expect, it } from 'vitest';

import {
  patchCreateTeamAdvancedSession,
  readCreateTeamAdvancedSession,
  restoreCreateTeamAdvancedDefaults,
  retireCreateTeamDraftGeneration,
} from '@renderer/services/createTeamDraftGeneration';

describe('create-only volatile Advanced CLI session', () => {
  afterEach(() => retireCreateTeamDraftGeneration());

  it('keeps edited arguments through editor remount and clears them on draft retirement', () => {
    restoreCreateTeamAdvancedDefaults(true, 'test-tree', '--max-turns 1');
    patchCreateTeamAdvancedSession({ customArgs: '--max-turns 5' });

    // A remounted editor reads the same renderer-only session, not the old name key.
    expect(readCreateTeamAdvancedSession()).toEqual({
      worktreeEnabled: true,
      worktreeName: 'test-tree',
      customArgs: '--max-turns 5',
      edited: true,
    });

    retireCreateTeamDraftGeneration();
    expect(readCreateTeamAdvancedSession()).toBeNull();
  });

  it('replaces untouched per-name defaults but never overwrites a manually edited field', () => {
    restoreCreateTeamAdvancedDefaults(false, '', 'from-suggested-name');
    restoreCreateTeamAdvancedDefaults(true, 'from-final-name', 'from-final-name');
    expect(readCreateTeamAdvancedSession()?.edited).toBe(false);
    patchCreateTeamAdvancedSession({ customArgs: 'user-override' });
    expect(readCreateTeamAdvancedSession()).toMatchObject({
      worktreeName: 'from-final-name',
      customArgs: 'user-override',
      edited: true,
    });
  });
});
