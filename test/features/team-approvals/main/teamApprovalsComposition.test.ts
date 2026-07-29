import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const teamCompositionSource = readFileSync(
  resolve(ROOT, 'src/main/ipc/teamFeatureComposition.ts'),
  'utf8'
);
const legacyTeamsSource = readFileSync(resolve(ROOT, 'src/main/ipc/teams.ts'), 'utf8');
const mainSource = readFileSync(resolve(ROOT, 'src/main/index.ts'), 'utf8');

const OWNED_CHANNELS = [
  'TEAM_TOOL_APPROVAL_RESPOND',
  'TEAM_TOOL_APPROVAL_READ_FILE',
  'TEAM_TOOL_APPROVAL_SETTINGS',
];

describe('team approvals production composition', () => {
  it('creates, registers, and removes the feature exactly once through public entrypoints', () => {
    expect(teamCompositionSource).toContain("from '@features/team-approvals/main'");
    expect(teamCompositionSource.match(/createTeamApprovalsFeature\(/g)).toHaveLength(1);
    expect(teamCompositionSource.match(/\n {6}registerTeamApprovalsIpc\(/g)).toHaveLength(1);
    expect(teamCompositionSource.match(/\n {2}removeTeamApprovalsIpc\(/g)).toHaveLength(1);
    expect(teamCompositionSource).toContain(
      'toolApprovalApi: dependencies.capabilities.toolApproval'
    );
    expect(teamCompositionSource).not.toContain('teamHandlerApis');
  });

  it('removes all invoke-channel ownership and API state from legacy teams IPC', () => {
    for (const channel of OWNED_CHANNELS) {
      expect(legacyTeamsSource).not.toContain(channel);
    }
    expect(legacyTeamsSource).not.toContain('teamToolApprovalApi');
    expect(legacyTeamsSource).not.toContain('handleToolApproval');
  });

  it('sources the push-event channel from feature-owned contracts', () => {
    expect(mainSource).toContain(
      "import { TEAM_TOOL_APPROVAL_EVENT } from '@features/team-approvals/contracts'"
    );
    expect(mainSource).toContain('safeSendToRenderer(mainWindow, TEAM_TOOL_APPROVAL_EVENT, event)');
  });
});
