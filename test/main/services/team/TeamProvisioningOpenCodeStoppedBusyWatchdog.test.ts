// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearPendingOpenCodePromptDeliveriesForTeam } from '../../../../src/main/services/team/lifecycle/teamForceStopFlow';
import { OpenCodePromptDeliveryLedgerStore } from '../../../../src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import {
  clearOpenCodeRuntimeLaneStorage,
  getOpenCodeRuntimeLaneIndexPath,
} from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { createOpenCodePromptDeliveryLedger } from '../../../../src/main/services/team/provisioning/OpenCodePromptDeliveryQueries';
import { createTeamProvisioningMemberWorkSyncBusySignals } from '../../../../src/main/services/team/provisioning/TeamProvisioningMemberWorkSyncBusySignals';
import { TeamInboxReader } from '../../../../src/main/services/team/TeamInboxReader';
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
  it.each([
    { state: 'stopped', cancel: null, clearLane: false, expectedWatchdog: 0 },
    { state: 'degraded', cancel: null, clearLane: false, expectedWatchdog: 0 },
    { state: 'active', cancel: null, clearLane: false, expectedWatchdog: 1 },
    { state: 'missing', cancel: null, clearLane: false, expectedWatchdog: 1 },
    { state: 'active', cancel: 'selected', clearLane: true, expectedWatchdog: 0 },
    { state: 'active', cancel: 'other', clearLane: true, expectedWatchdog: 1 },
    { state: 'active', cancel: 'selected', clearLane: false, expectedWatchdog: 0 },
    { state: 'missing', cancel: null, clearLane: false, expectedWatchdog: 0, pauseAt: 'inbox' },
    { state: 'missing', cancel: null, clearLane: false, expectedWatchdog: 0, pauseAt: 'ledger' },
  ] as const)(
    '$state lane, cancellation=$cancel, cleanup=$clearLane, pause=$pauseAt preserves busy and eligible wakes',
    async (scenario) => {
      const { state, cancel, clearLane, expectedWatchdog } = scenario;
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
      const teamsBasePath = join(root, 'claude/teams');
      const ledger = createOpenCodePromptDeliveryLedger(teamName, laneId, { teamsBasePath });
      if (cancel) {
        // Use the real Stop cancellation and lane cleanup, then discard Main's in-memory state.
        await ledger.ensurePending({
          teamName,
          memberName,
          laneId,
          runId: 'TEST-original-run',
          inboxMessageId: cancel === 'selected' ? 'TEST-foreground' : 'TEST-other',
          inboxTimestamp: nowIso,
          source: 'ui-send',
          replyRecipient: 'user',
          payloadHash: 'TEST-payload',
          now: nowIso,
        });
        const beforeStop = new FixtureProvisioning();
        cleanups.push(() => beforeStop.cancelWake(teamName));
        await beforeStop.getOpenCodeMemberDeliveryBusyStatus({ teamName, memberName, nowIso });
        expect(beforeStop.readStoppedTeamImportRuntimeFacts(teamName).watchdog).toBe(1);
        const cancelled = await clearPendingOpenCodePromptDeliveriesForTeam({
          teamName,
          teamsBasePath,
          ownedLaneIds: [laneId],
          ownedRunIds: ['TEST-original-run'],
          reason: 'stop_requested: pending delivery cancelled by user stop',
          now: () => new Date(nowIso),
          throwOnError: true,
        });
        expect(cancelled.cleared).toBe(1);
        beforeStop.cancelWake(teamName);
        expect(beforeStop.readStoppedTeamImportRuntimeFacts(teamName).watchdog).toBe(0);
        if (clearLane) {
          await expect(
            clearOpenCodeRuntimeLaneStorage({ teamsBasePath, teamName, laneId })
          ).resolves.toBe(true);
        }
        expect((await ledger.list())[0].cancelledAt).toBe(nowIso);
      }
      const beforeLedger = await ledger.list();
      const beforeIndex = existsSync(index) ? readFileSync(index, 'utf8') : null;
      const service = new FixtureProvisioning();
      cleanups.push(() => {
        service.cancelWake(teamName);
        rmSync(root, { recursive: true, force: true });
      });
      const beforeFacts = service.readStoppedTeamImportRuntimeFacts(teamName);
      expect(Object.values(beforeFacts).every((count) => count === 0)).toBe(true);
      const signal = createTeamProvisioningMemberWorkSyncBusySignals(service).extraBusySignals[0];
      let pauseRead: (() => Promise<void>) | undefined;
      let resumeRead: (() => void) | undefined;
      if ('pauseAt' in scenario) {
        const reached = Promise.withResolvers<void>();
        const resumed = Promise.withResolvers<void>();
        resumeRead = resumed.resolve;
        cleanups.push(resumed.resolve);
        const pause = async <T>(read: Promise<T>): Promise<T> => {
          const captured = await read;
          reached.resolve();
          await resumed.promise;
          return captured;
        };
        pauseRead = () => reached.promise;
        if (scenario.pauseAt === 'ledger') {
          const read = OpenCodePromptDeliveryLedgerStore.prototype.getByInboxMessage;
          const spy = vi
            .spyOn(OpenCodePromptDeliveryLedgerStore.prototype, 'getByInboxMessage')
            .mockImplementationOnce(function (this: OpenCodePromptDeliveryLedgerStore, input) {
              return pause(read.call(this, input));
            });
          cleanups.push(() => spy.mockRestore());
        } else {
          const read = TeamInboxReader.prototype.getMessagesFor;
          const spy = vi
            .spyOn(TeamInboxReader.prototype, 'getMessagesFor')
            .mockImplementationOnce(function (this: TeamInboxReader, ...args) {
              return pause(read.call(this, ...args));
            });
          cleanups.push(() => spy.mockRestore());
        }
      }
      const reading = signal.isBusy({ teamName, memberName, nowIso });
      if (pauseRead) {
        await pauseRead();
        service.cancelWake(teamName);
        expect(service.readStoppedTeamImportRuntimeFacts(teamName)).toEqual(beforeFacts);
        resumeRead?.();
      }
      await expect(reading).resolves.toMatchObject({
        busy: true,
        reason: 'opencode_foreground_inbox_unread',
        activeMessageId: 'TEST-foreground',
      });
      expect(readFileSync(inbox, 'utf8')).toBe(beforeInbox);
      expect(await ledger.list()).toEqual(beforeLedger);
      expect(existsSync(index) ? readFileSync(index, 'utf8') : null).toBe(beforeIndex);
      expect(service.isTeamAlive(teamName)).toBe(false);
      expect(service.readStoppedTeamImportRuntimeFacts(teamName)).toEqual({
        ...beforeFacts,
        watchdog: expectedWatchdog,
      });
    }
  );
});
