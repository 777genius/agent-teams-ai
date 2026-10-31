import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getStallMonitorJournalPath } from '../../../../../src/main/services/team/stallMonitor/JsonTaskStallJournalStore';
import { TeamTaskStallJournal } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallJournal';
import { TeamTaskStallMonitor } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallMonitor';
import { TeamTaskStallNotifier } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallNotifier';
import { TeamDataService } from '../../../../../src/main/services/team/TeamDataService';
import {
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../../src/main/utils/pathDecoder';

import type { TaskStallJournalEntry } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallTypes';
import type { InboxMessage } from '../../../../../src/shared/types';

/**
 * The monitor, journal, notifier, TeamDataService and inbox writer are the
 * real ones over a temporary Claude root; only stall detection (snapshot and
 * policy) is stubbed. Scans are driven one at a time with an explicit clock.
 */
interface ScanDriver {
  scanTeam(teamName: string, now: Date, scanRun: { cancelled: boolean }): Promise<void>;
}

const T0 = Date.parse('2026-10-31T10:00:00.000Z');
const SCAN_INTERVAL_MS = 30_000;

const writerTask = {
  id: 'task-w',
  displayId: 'abcd1234',
  subject: 'Write the parser',
  owner: 'bob',
};
const openCodeTask = {
  id: 'task-o',
  displayId: 'feed5678',
  subject: 'Port the CLI',
  owner: 'alice',
};

function workAlert(task: typeof writerTask) {
  return {
    status: 'alert',
    taskId: task.id,
    branch: 'work',
    signal: 'turn_ended_after_touch',
    epochKey: `${task.id}:epoch`,
    reason: 'Potential work stall.',
  };
}

let root: string;
const monitors: TeamTaskStallMonitor[] = [];

const inboxPath = (memberName: string): string =>
  path.join(getTeamsBasePath(), 'demo', 'inboxes', `${memberName}.json`);

async function readInbox(memberName: string): Promise<InboxMessage[]> {
  return JSON.parse(await readFile(inboxPath(memberName), 'utf8')) as InboxMessage[];
}

async function readJournalStates(): Promise<Record<string, string>> {
  const entries = JSON.parse(
    await readFile(getStallMonitorJournalPath('demo'), 'utf8')
  ) as TaskStallJournalEntry[];
  return Object.fromEntries(entries.map((entry) => [entry.taskId, entry.state]));
}

function createMonitor(
  tasks: (typeof writerTask)[],
  relayOpenCodeMemberInboxMessages = vi.fn(async () => ({
    lastDelivery: { delivered: true, accepted: true },
  }))
) {
  const journal = new TeamTaskStallJournal({ alertCooldownMs: 10 * 60_000 });
  const markAlerted = vi.spyOn(journal, 'markAlerted');
  const teamDataService = new TeamDataService();
  teamDataService.setTeamProfileOwnership(async () => true);
  const notifier = new TeamTaskStallNotifier(teamDataService, {
    relayOpenCodeMemberInboxMessages,
  });
  const snapshot = {
    teamName: 'demo',
    inProgressTasks: tasks,
    reviewOpenTasks: [],
    allTasksById: new Map(tasks.map((task) => [task.id, task])),
    providerByMemberName: new Map([
      ['alice', 'opencode'],
      ['bob', 'anthropic'],
    ]),
  };
  const monitor = new TeamTaskStallMonitor(
    // No active teams, so the monitor's own timer never scans behind the test.
    {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      noteTeamChange: vi.fn(),
      listActiveTeams: vi.fn(async () => []),
      isTeamOfThisProfile: vi.fn(async () => true),
    } as never,
    { getSnapshot: vi.fn(async () => snapshot) } as never,
    {
      evaluateWork: vi.fn(({ task }: { task: typeof writerTask }) => workAlert(task)),
      evaluateReview: vi.fn(),
    } as never,
    journal,
    notifier
  );
  monitor.start();
  monitors.push(monitor);
  let scans = 0;
  const scan = (): Promise<void> =>
    (monitor as unknown as ScanDriver).scanTeam('demo', new Date(T0 + SCAN_INTERVAL_MS * scans++), {
      cancelled: false,
    });
  return { scan, markAlerted, relayOpenCodeMemberInboxMessages };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'TEST-stall-lead-alert-'));
  setClaudeBasePathOverride(root);
  vi.stubEnv('CLAUDE_TEAM_TASK_STALL_MONITOR_ENABLED', '1');
  vi.stubEnv('CLAUDE_TEAM_OPENCODE_TASK_STALL_REMEDIATION_ENABLED', '1');
  vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ALERTS_ENABLED', '1');
  const teamDir = path.join(getTeamsBasePath(), 'demo');
  await mkdir(teamDir, { recursive: true });
  await writeFile(
    path.join(teamDir, 'config.json'),
    JSON.stringify({
      name: 'demo',
      leadSessionId: 'lead-session',
      members: [
        { name: 'team-lead', agentType: 'team-lead' },
        { name: 'alice', role: 'developer' },
        { name: 'bob', role: 'developer' },
      ],
    })
  );
});

afterEach(async () => {
  await Promise.all(monitors.splice(0).map((monitor) => monitor.stop()));
  vi.unstubAllEnvs();
  setClaudeBasePathOverride(null);
  await rm(root, { recursive: true, force: true });
});

describe('task stall lead alert delivery', () => {
  it('writes a confirmed stall into the lead inbox once and journals it', async () => {
    const { scan, markAlerted } = createMonitor([writerTask]);

    await scan();
    await expect(readFile(inboxPath('team-lead'))).rejects.toMatchObject({ code: 'ENOENT' });

    await scan();
    expect(await readInbox('team-lead')).toEqual([
      expect.objectContaining({
        from: 'system',
        to: 'team-lead',
        summary: 'Potential stalled tasks detected',
        text: '- #abcd1234 [work] Write the parser - Potential work stall.',
        taskRefs: [{ taskId: 'task-w', displayId: 'abcd1234', teamName: 'demo' }],
        source: 'system_notification',
        read: false,
      }),
    ]);
    expect(markAlerted).toHaveBeenCalledTimes(1);
    expect(markAlerted).toHaveBeenCalledWith('demo', 'task-w:epoch', expect.any(String));
    expect(await readJournalStates()).toEqual({ 'task-w': 'alerted' });

    // Inside the alert cooldown the next scan sends nothing new.
    await scan();
    expect(await readInbox('team-lead')).toHaveLength(1);
    expect(markAlerted).toHaveBeenCalledTimes(1);
  });

  it('journals the owner nudge when the lead alert fails and retries only the lead', async () => {
    const { scan, markAlerted, relayOpenCodeMemberInboxMessages } = createMonitor([
      openCodeTask,
      writerTask,
    ]);
    await mkdir(path.dirname(inboxPath('team-lead')), { recursive: true });
    await writeFile(inboxPath('team-lead'), '{ not json');

    await scan();
    await expect(scan()).resolves.toBeUndefined();

    expect(relayOpenCodeMemberInboxMessages).toHaveBeenCalledTimes(1);
    expect(await readInbox('alice')).toEqual([
      expect.objectContaining({
        from: 'system',
        messageId: 'task-stall:demo:task-o:task-o:epoch',
        messageKind: 'task_stall_remediation',
      }),
    ]);
    expect(markAlerted.mock.calls.map(([, epochKey]) => epochKey)).toEqual(['task-o:epoch']);
    expect(await readJournalStates()).toEqual({ 'task-o': 'alerted', 'task-w': 'alert_ready' });
    // test/setup.ts fails the test on any other console.warn.
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
      '[Service:TeamTaskStallMonitor]',
      expect.stringContaining('Task stall lead alert failed for demo')
    );
    vi.mocked(console.warn).mockClear();

    await writeFile(inboxPath('team-lead'), '[]');
    await scan();

    expect(await readInbox('team-lead')).toEqual([
      expect.objectContaining({
        from: 'system',
        text: '- #abcd1234 [work] Write the parser - Potential work stall.',
      }),
    ]);
    expect(relayOpenCodeMemberInboxMessages).toHaveBeenCalledTimes(1);
    expect(await readInbox('alice')).toHaveLength(1);
    expect(markAlerted.mock.calls.map(([, epochKey]) => epochKey)).toEqual([
      'task-o:epoch',
      'task-w:epoch',
    ]);
    expect(await readJournalStates()).toEqual({ 'task-o': 'alerted', 'task-w': 'alerted' });
  });
});
