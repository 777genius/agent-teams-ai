import { describe, expect, it } from 'vitest';

import {
  projectPublicProvisioningProgress,
  rememberProjectRunIdentity,
} from '../../../src/main/ipc/teams/teamProjectContextProgressIdentity';

import type { TeamProvisioningProgress } from '../../../src/shared/types/team';

function progress(runId: string, teamName: string): TeamProvisioningProgress {
  return {
    teamName, runId, state: 'failed', message: 'Startup failed',
    startedAt: '2026-11-18T00:00:00Z',
    updatedAt: '2026-11-18T00:00:01Z',
  };
}

describe('project run status polling identity', () => {
  it('maps only the exact known runtime run and physical team to the logical name', () => {
    rememberProjectRunIdentity('project-run-1', 'builders', 'ptc-project-a');
    expect(projectPublicProvisioningProgress(progress('project-run-1', 'ptc-project-a')).teamName)
      .toBe('builders');
    expect(projectPublicProvisioningProgress(progress('project-run-2', 'ptc-project-a')).teamName)
      .toBe('ptc-project-a');
    expect(projectPublicProvisioningProgress(progress('project-run-1', 'unrelated')).teamName)
      .toBe('unrelated');
  });

  it('preserves existing shared run status unchanged', () => {
    expect(projectPublicProvisioningProgress(progress('legacy-run', 'legacy-team')).teamName)
      .toBe('legacy-team');
  });
});
