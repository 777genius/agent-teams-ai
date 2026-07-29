import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const auxiliarySource = readFileSync(resolve(ROOT, 'src/main/ipc/teamAuxiliaryIpc.ts'), 'utf8');
const handlersSource = readFileSync(resolve(ROOT, 'src/main/ipc/handlers.ts'), 'utf8');
const teamCompositionSource = readFileSync(
  resolve(ROOT, 'src/main/ipc/teamFeatureComposition.ts'),
  'utf8'
);
const teamsSource = readFileSync(resolve(ROOT, 'src/main/ipc/teams.ts'), 'utf8');

const AUXILIARY_CHANNELS = [
  'TEAM_SET_PROJECT_BRANCH_TRACKING',
  'TEAM_SET_TASK_LOG_STREAM_TRACKING',
  'TEAM_SET_TOOL_ACTIVITY_TRACKING',
  'TEAM_GET_WORKTREE_GIT_STATUS',
  'TEAM_INITIALIZE_GIT_REPOSITORY',
  'TEAM_CREATE_INITIAL_GIT_COMMIT',
  'TEAM_GET_PROJECT_BRANCH',
  'TEAM_SHOW_MESSAGE_NOTIFICATION',
] as const;

const EXTRACTED_TEAM_CHANNELS = [
  'TEAM_LIST',
  'TEAM_DELETE_TEAM',
  'TEAM_RESTORE',
  'TEAM_PERMANENTLY_DELETE',
] as const;

describe('team auxiliary IPC architecture boundary', () => {
  it('owns all eight auxiliary channels exclusively in the focused registrar', () => {
    for (const channel of AUXILIARY_CHANNELS) {
      expect(auxiliarySource.match(new RegExp(`ipcMain\\.handle\\(${channel}`, 'g'))).toHaveLength(
        1
      );
      expect(
        auxiliarySource.match(new RegExp(`ipcMain\\.removeHandler\\(${channel}`, 'g'))
      ).toHaveLength(1);
      expect(teamsSource, channel).not.toContain(channel);
    }
  });

  it('keeps the stable teams facade as the only app-shell registration surface', () => {
    expect(teamsSource.match(/\n {2}registerTeamAuxiliaryIpc\(ipcMain\);/g)).toHaveLength(1);
    expect(teamsSource.match(/\n {2}removeTeamAuxiliaryIpc\(ipcMain\);/g)).toHaveLength(1);
    expect(teamsSource.match(/\n {2}initializeTeamAuxiliaryIpc\(\{/g)).toHaveLength(1);
    expect(teamsSource).toContain(
      "export { showTeamNativeNotification } from './teamAuxiliaryIpc';"
    );
    expect(handlersSource).not.toContain('teamAuxiliaryIpc');
    expect(teamCompositionSource).toContain('registerTeamHandlers(ipcMain)');
    expect(teamCompositionSource).toContain('removeTeamHandlers(ipcMain)');
  });

  it('leaves identity-fenced compatibility but no feature-specific registration in teams.ts', () => {
    for (const channel of EXTRACTED_TEAM_CHANNELS) {
      expect(teamsSource, channel).not.toContain(channel);
    }
    expect(teamsSource).toContain('createIdentityFencedProvisioningStart');
    expect(teamsSource).toContain('createIdentityFencedTeamConfigurationRepository');
    expect(teamsSource).toContain('withTeamIdentityFence');
    expect(teamsSource).not.toMatch(/ipcMain\.(?:handle|removeHandler)\(/);
    expect(auxiliarySource).not.toMatch(
      /\b(?:TEAM_LIST|TEAM_DELETE_TEAM|TEAM_RESTORE|TEAM_PERMANENTLY_DELETE)\b/
    );
  });

  it('does not acquire lifecycle, runtime-control, provider, or process ownership', () => {
    expect(auxiliarySource).not.toMatch(
      /createTeamLifecycleCommandFeature|@features\/team-lifecycle|@features\/team-runtime-control/
    );
    expect(auxiliarySource).not.toMatch(
      /\b(?:TEAM_CREATE|TEAM_LAUNCH|TEAM_STOP|TEAM_CANCEL_PROVISIONING)\b/
    );
    expect(auxiliarySource).not.toMatch(
      /OpenCode|TeamProvisioningApis|child_process|node:child_process|\bspawn\s*\(/
    );
  });
});
