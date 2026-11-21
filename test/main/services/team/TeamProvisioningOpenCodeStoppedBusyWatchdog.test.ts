// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getOpenCodeRuntimeLaneIndexPath } from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { createTeamProvisioningMemberWorkSyncBusySignals } from '../../../../src/main/services/team/provisioning/TeamProvisioningMemberWorkSyncBusySignals';
import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';

const paths = vi.hoisted(() => ({ root: '/TEST-unconfigured-watchdog-producer' }));
vi.mock('@main/utils/pathDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/utils/pathDecoder')>()),
  getClaudeBasePath: () => join(paths.root, 'claude'),
  getTeamsBasePath: () => join(paths.root, 'claude/teams'),
  getTasksBasePath: () => join(paths.root, 'claude/tasks'),
  getAppDataPath: () => join(paths.root, 'app'),
  getBackupsBasePath: () => join(paths.root, 'app/backups'),
}));
// Automatic stale credential cleanup is outside this read-only Main fixture.
vi.mock(
  '../../../../src/main/services/team/provisioning/TeamProvisioningAnthropicApiKeyHelperCleanup',
  () => ({
    createStaleAnthropicTeamApiKeyHelperCleanupRetryOwner: () => ({
      start() {},
      stop() {},
      getPendingTeamNames: () => [],
      hasPendingCleanup: () => false,
    }),
  })
);
class FixtureProvisioning extends TeamProvisioningService {
  cancelWake(team: string) {
    this.openCodePromptDeliveryWatchdogScheduler.cancelTeam(team);
  }
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

describe('Main busy reads of persisted OpenCode lanes', () => {
  it.each(['stopped', 'degraded', 'active', 'missing'] as const)(
    '%s lane preserves its busy answer and only admits recoverable wakes',
    async (state) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const root = mkdtempSync(join(tmpdir(), 'TEST-watchdog-producer-'));
      paths.root = root;
      const teamName = 'test-retained-v1',
        memberName = 'bob',
        laneId = 'primary';
      const team = join(root, 'claude/teams', teamName);
      const put = (name: string, data: unknown) => {
        mkdirSync(dirname(name), { recursive: true });
        writeFileSync(name, JSON.stringify(data));
      };
      const member = { providerId: 'opencode', model: 'TEST-model' };
      const members = [
        { ...member, name: 'team-lead', agentType: 'team-lead' },
        { ...member, name: memberName, role: 'Developer' },
      ];
      put(join(team, 'config.json'), { name: teamName, projectPath: root, members });
      put(join(team, 'team.meta.json'), { ...member, version: 1, cwd: root, createdAt: 1 });
      put(join(team, 'members.meta.json'), { version: 1, members });
      const index = getOpenCodeRuntimeLaneIndexPath(join(root, 'claude/teams'), teamName);
      const nowIso = '2026-11-21T00:00:00.000Z';
      if (state !== 'missing') {
        put(index, {
          version: 1,
          updatedAt: nowIso,
          lanes: { [laneId]: { laneId, state, updatedAt: nowIso } },
        });
      }
      const inbox = join(team, 'inboxes', `${memberName}.json`);
      put(inbox, [
        {
          from: 'user',
          to: memberName,
          text: 'TEST unread foreground',
          timestamp: nowIso,
          read: false,
          messageId: 'TEST-foreground',
          messageKind: 'direct',
        },
      ]);
      const beforeInbox = readFileSync(inbox, 'utf8');
      const service = new FixtureProvisioning();
      cleanups.push(() => {
        service.cancelWake(teamName);
        rmSync(root, { recursive: true, force: true });
      });
      expect(service.readStoppedTeamImportRuntimeFacts(teamName).watchdog).toBe(0);
      const signal = createTeamProvisioningMemberWorkSyncBusySignals(service).extraBusySignals[0];
      await expect(signal.isBusy({ teamName, memberName, nowIso })).resolves.toMatchObject({
        busy: true,
        reason: 'opencode_foreground_inbox_unread',
        activeMessageId: 'TEST-foreground',
      });
      expect(readFileSync(inbox, 'utf8')).toBe(beforeInbox);
      expect(service.isTeamAlive(teamName)).toBe(false);
      expect(service.readStoppedTeamImportRuntimeFacts(teamName).watchdog).toBe(
        state === 'stopped' || state === 'degraded' ? 0 : 1
      );
    }
  );
});
