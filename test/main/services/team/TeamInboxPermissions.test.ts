import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { discardQueuedUserMessages } from '../../../../src/main/ipc/teams/teamQueuedUserMessages';
import { createDraftTeamConfig } from '../../../../src/main/services/team/createDraftTeamConfig';
import { markTeamInboxMessagesRead } from '../../../../src/main/services/team/provisioning/TeamProvisioningInboxPersistence';
import { TeamInboxWriter } from '../../../../src/main/services/team/TeamInboxWriter';
import { TeamMembersMetaStore } from '../../../../src/main/services/team/TeamMembersMetaStore';
import { TeamMetaStore } from '../../../../src/main/services/team/TeamMetaStore';
import { atomicWriteAsync } from '../../../../src/main/utils/atomicWrite';

const state = vi.hoisted(() => ({ teamsBase: '', tasksBase: '' }));
vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => state.teamsBase,
  getTasksBasePath: () => state.tasksBase,
}));

interface Delivery {
  deliveredToInbox: boolean;
  messageId: string;
  deduplicated?: boolean;
}
interface Controller {
  messages: {
    sendMessage(input: { from: string; to: string; text: string; messageId: string }): Delivery;
  };
  crossTeam: {
    sendCrossTeamMessage(input: { toTeam: string; fromMember: string; text: string }): Delivery;
  };
}
const require = createRequire(import.meta.url);
const { createController } = require('../../../../agent-teams-controller/src/index.js') as {
  createController(input: { teamName: string; claudeDir: string }): Controller;
};

describe.skipIf(process.platform === 'win32')(
  'fresh inbox permissions under a shared-group umask',
  () => {
    let root: string;
    let previousUmask: number;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-private-inbox-'));
      state.teamsBase = path.join(root, 'claude', 'teams');
      state.tasksBase = path.join(root, 'claude', 'tasks');
      previousUmask = process.umask(0o002);
    });
    afterEach(() => {
      vi.useRealTimers();
      process.umask(previousUmask);
      fs.rmSync(root, { recursive: true, force: true });
    });

    function seedTeam(name: string): void {
      const dir = path.join(state.teamsBase, name);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({
          name,
          members: [
            { name: 'team-lead', agentType: 'team-lead' },
            { name: 'worker', agentType: 'general-purpose' },
          ],
        }),
        { mode: 0o600 }
      );
    }
    function inbox(team: string, member: string): string {
      return path.join(state.teamsBase, team, 'inboxes', `${member}.json`);
    }
    function expectPrivate(file: string): void {
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      const stat = fs.statSync(file);
      expect(stat.mode & 0o777).toBe(0o600);
      expect(stat.uid).toBe(process.getuid?.());
    }
    function rows(file: string): Record<string, unknown>[] {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>[];
    }

    it('keeps controller message delivery, append and dedup private', () => {
      seedTeam('controller');
      const controller = createController({
        teamName: 'controller',
        claudeDir: path.dirname(state.teamsBase),
      });
      const request = {
        from: 'worker',
        to: 'user',
        text: 'Task implementation and tests passed',
        messageId: 'reply-one',
      };
      expect(controller.messages.sendMessage(request).deliveredToInbox).toBe(true);
      const file = inbox('controller', 'user');
      expectPrivate(file);
      const before = fs.statSync(file).ino;
      controller.messages.sendMessage({
        ...request,
        text: 'Additional verified result',
        messageId: 'reply-two',
      });
      expectPrivate(file);
      expect(fs.statSync(file).ino).not.toBe(before);
      expect(controller.messages.sendMessage(request).deduplicated).toBe(true);
      expect(rows(file).map((row) => row.messageId)).toEqual(['reply-one', 'reply-two']);
    });

    it('keeps public cross-team delivery and atomic append private', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      seedTeam('sender');
      seedTeam('receiver');
      const controller = createController({
        teamName: 'sender',
        claudeDir: path.dirname(state.teamsBase),
      });
      const request = {
        toTeam: 'receiver',
        fromMember: 'worker',
        text: 'Please review the finished task',
      };
      expect(controller.crossTeam.sendCrossTeamMessage(request).deliveredToInbox).toBe(true);
      const file = inbox('receiver', 'team-lead');
      expectPrivate(file);
      vi.setSystemTime(Date.now() + 4000);
      controller.crossTeam.sendCrossTeamMessage({
        ...request,
        text: 'A separate task is ready for review',
      });
      expectPrivate(file);
      controller.crossTeam.sendCrossTeamMessage(request);
      expect(rows(file)).toHaveLength(2);
    });

    it('keeps Electron send, text update, read mark and queued discard private', async () => {
      const writer = new TeamInboxWriter();
      const first = await writer.sendMessage('electron', {
        member: 'worker',
        text: 'First queued request',
      });
      const file = inbox('electron', 'worker');
      expectPrivate(file);
      await writer.updateMessageText('electron', {
        member: 'worker',
        messageId: first.messageId,
        text: 'Updated queued request',
      });
      expectPrivate(file);
      expect(rows(file)[0]?.text).toBe('Updated queued request');
      await markTeamInboxMessagesRead({
        teamName: 'electron',
        member: 'worker',
        messages: [{ messageId: first.messageId }],
        teamsBasePath: state.teamsBase,
        timeoutMs: 1000,
        maxBytes: 1024 * 1024,
        readRegularFileUtf8: (filePath) => fs.promises.readFile(filePath, 'utf8'),
      });
      expectPrivate(file);
      const second = await writer.sendMessage('electron', {
        member: 'worker',
        text: 'Second queued request',
      });
      expect(
        await discardQueuedUserMessages(state.teamsBase, 'electron', 'worker', [second.messageId])
      ).toEqual({ discarded: 1, remainingQueued: 0 });
      expectPrivate(file);
      expect(rows(file)).toHaveLength(1);
      expect(rows(file)[0]?.read).toBe(true);
    });

    it('creates fresh draft ancestors and inboxes privately before the first message', async () => {
      await createDraftTeamConfig(
        { teamName: 'draft', cwd: root, members: [{ name: 'worker' }] },
        {
          teamMetaStore: new TeamMetaStore(),
          membersMetaStore: new TeamMembersMetaStore(),
        }
      );
      for (const directory of [
        path.dirname(state.teamsBase),
        state.teamsBase,
        path.join(state.teamsBase, 'draft'),
        path.dirname(inbox('draft', 'user')),
      ]) {
        const stat = fs.statSync(directory);
        expect(stat.mode & 0o777).toBe(0o700);
        expect(stat.uid).toBe(process.getuid?.());
      }
      await new TeamInboxWriter().sendMessage('draft', {
        member: 'user',
        from: 'worker',
        text: 'Verified task result',
      });
      expectPrivate(inbox('draft', 'user'));
    });

    it('leaves generic project writes and pre-existing unsafe directories unchanged', async () => {
      const generic = path.join(root, 'project', 'file.txt');
      await atomicWriteAsync(generic, 'user project content');
      expect(fs.statSync(path.dirname(generic)).mode & 0o777).toBe(0o775);
      expect(fs.statSync(generic).mode & 0o777).toBe(0o664);
      const unsafeInboxDir = path.dirname(inbox('existing', 'worker'));
      fs.mkdirSync(unsafeInboxDir, { recursive: true });
      const before = fs.statSync(unsafeInboxDir);
      await new TeamInboxWriter().sendMessage('existing', {
        member: 'worker',
        text: 'No automatic directory repair',
      });
      const after = fs.statSync(unsafeInboxDir);
      expect(after.ino).toBe(before.ino);
      expect(after.mode & 0o777).toBe(0o775);
    });
  }
);
