// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { projectRosterConfiguration } from '../../../src/features/agent-backend/main/adapters/output/projectRoster';
import { rosterSavedSettings } from '../../../src/features/agent-backend/main/adapters/rosterValues';
import { projectHostSavedTeamRequest } from '../../../src/features/agent-backend/renderer/projectHostSavedTeamRequest';
import { savedProjectPath } from '../../../src/features/agent-backend/renderer/readHostRosterConfiguration';

describe('saved definitions without a selected project', () => {
  it('preserves authored options through Main and form projection without inventing a project association', () => {
    const settings = {
      cwd: '',
      projectContextMode: 'per_project' as const,
      providerId: 'anthropic' as const,
      model: 'TEST-model',
      skipPermissions: false,
      limitContext: true,
      prompt: 'TEST authored prompt',
      extraCliArgs: '--TEST-option',
    };
    expect(rosterSavedSettings(settings, true)).toEqual(settings);
    const configuration = projectRosterConfiguration({
      revision: 'a'.repeat(64),
      savedSettings: settings,
      members: [
        { memberId: 'TEST-lead', name: 'team-lead', role: 'lead', settings: {} },
        { memberId: 'TEST-worker', name: 'reviewer', role: 'member', settings: { role: 'Reviewer' } },
      ],
      removedMembers: [],
    });
    expect(configuration.savedSettings).toEqual(settings);
    expect(projectHostSavedTeamRequest('host:TEST-team', configuration)).toEqual({
      ...settings,
      teamName: 'host:TEST-team',
      savedSettingsFingerprint: configuration.revision,
      members: [{ name: 'reviewer', role: 'Reviewer' }],
    });
    expect(savedProjectPath(configuration)).toBeUndefined();
  });

  it.each([undefined, null, ' ', '\0', 42])('refuses malformed workspace value %s', (cwd) => {
    expect(() => rosterSavedSettings({ cwd }, true)).toThrow();
  });
});
