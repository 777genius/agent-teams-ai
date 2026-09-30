import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTeamApprovalsFeature } from '@features/team-approvals/main';
import { withTeamWriterAdmission } from '@main/services/team/permanent-deletion/TeamWriterAdmission';
import { TeamBackupService } from '@main/services/team/TeamBackupService';
import { setAppDataBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, expect, it, vi } from 'vitest';

const roots: string[] = [];
afterEach(async () => {
  setAppDataBasePath(null);
  setClaudeBasePathOverride(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('denies approval settings and responses after a real deletion boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'approval-deletion-'));
  roots.push(root);
  setAppDataBasePath(root);
  setClaudeBasePathOverride(root);
  const teamName = 'approval-team';
  const teamPath = join(root, 'teams', teamName);
  await mkdir(teamPath, { recursive: true });
  await writeFile(join(teamPath, 'config.json'), JSON.stringify({ name: teamName }));
  const backup = new TeamBackupService();
  await backup.initialize();
  const respondToToolApproval = vi.fn(async () => undefined);
  const updateToolApprovalSettings = vi.fn();
  const feature = createTeamApprovalsFeature({
    toolApprovalApi: {
      respondToToolApproval,
      updateToolApprovalSettings,
      getPendingToolApprovalFileTarget: () => null,
    },
    fileReader: { read: vi.fn() },
    withWriterAdmission: (name, operation) => withTeamWriterAdmission(backup, name, operation),
  });
  try {
    const prepared = await backup.beginPermanentDeletion(teamName);
    await backup.commitPermanentDeletionBoundary(prepared);
    await expect(feature.commands.updateSettings({ teamName, settings: {} as never }))
      .rejects.toThrow('operator_required');
    await expect(feature.commands.respond({
      teamName, runId: 'run-1', requestId: 'request-1', allow: true,
    })).rejects.toThrow('operator_required');
    expect(updateToolApprovalSettings).not.toHaveBeenCalled();
    expect(respondToToolApproval).not.toHaveBeenCalled();
  } finally {
    backup.dispose();
  }
});
