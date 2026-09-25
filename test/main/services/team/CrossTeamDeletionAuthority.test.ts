import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CrossTeamService } from '@main/services/team/CrossTeamService';
import { withCapturedTeamWriterIdentity, withTeamWriterAdmission } from '@main/services/team/permanent-deletion/TeamWriterAdmission';
import { TeamBackupService } from '@main/services/team/TeamBackupService';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { TeamDataService } from '@main/services/team/TeamDataService';
import { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';
import { setAppDataBasePath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(async () => {
  setAppDataBasePath(null);
  setClaudeBasePathOverride(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('cross-team desktop writer admission on real files', () => {
  it('revalidates a queued inbox/outbox write after the target deletion boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cross-team-deletion-'));
    roots.push(root);
    setAppDataBasePath(root);
    setClaudeBasePathOverride(root);
    for (const teamName of ['source-team', 'target-team']) {
      const teamPath = join(root, 'teams', teamName);
      await mkdir(join(teamPath, 'inboxes'), { recursive: true });
      await writeFile(join(teamPath, 'config.json'), JSON.stringify({
        name: teamName,
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }));
    }
    const backup = new TeamBackupService();
    await backup.initialize();
    let releaseTargetRead: (() => void) | undefined;
    let targetReadStarted: (() => void) | undefined;
    const reachedTargetRead = new Promise<void>((resolve) => { targetReadStarted = resolve; });
    const targetReadGate = new Promise<void>((resolve) => { releaseTargetRead = resolve; });
    const realReader = new TeamConfigReader();
    const reader = {
      getConfig: async (teamName: string) => {
        if (teamName === 'target-team') {
          targetReadStarted?.();
          await targetReadGate;
        }
        return realReader.getConfig(teamName);
      },
    };
    const service = new CrossTeamService(
      reader as TeamConfigReader, new TeamDataService(), new TeamInboxWriter(), null
    );
    service.setWriterAdmission(
      (teamName, operation) => withTeamWriterAdmission(backup, teamName, operation),
      (teamName, operation) => withCapturedTeamWriterIdentity(backup, teamName, operation)
    );
    const send = service.send({
      fromTeam: 'source-team', fromMember: 'team-lead',
      toTeam: 'target-team', text: 'queued message',
    });
    try {
      await reachedTargetRead;
      const prepared = await backup.beginPermanentDeletion('target-team');
      await backup.commitPermanentDeletionBoundary(prepared);
      releaseTargetRead?.();
      await expect(send).rejects.toThrow('operator_required');
      expect(existsSync(join(root, 'teams', 'source-team', 'sent-cross-team.json'))).toBe(false);
      expect(existsSync(join(root, 'teams', 'target-team', 'inboxes', 'team-lead.json'))).toBe(false);
      expect(await readFile(join(root, 'teams', 'target-team', 'config.json'), 'utf8'))
        .toContain('target-team');
    } finally {
      releaseTargetRead?.();
      backup.dispose();
      await send.catch(() => undefined);
    }
  });
});
