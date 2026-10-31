import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getStallMonitorJournalPath } from '../../../../../src/main/services/team/stallMonitor/JsonTaskStallJournalStore';
import { TeamTaskStallJournal } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallJournal';
import { TeamTaskStallMonitor } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallMonitor';
import { TeamTaskStallNotifier } from '../../../../../src/main/services/team/stallMonitor/TeamTaskStallNotifier';
import { TeamDataService } from '../../../../../src/main/services/team/TeamDataService';
import { isTaskStallRemediationMessage } from '../../../../../src/shared/utils/teamAutomationMessages';
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
const MINUTE_MS = 60_000;

interface StallTask {
  id: string;
  displayId: string;
  subject: string;
  owner: string;
  /** Stands in for the last activity the policy keys an epoch on. */
  epoch: string;
  /** The owner's OpenCode turn is running: the policy skips the task meanwhile. */
  laneActive?: boolean;
  /** Lands in the alert text, like the lane idle time of an OpenCode stall. */
  idleSince?: string;
}

const writerTask = (): StallTask => ({
  id: 'task-w',
  displayId: 'abcd1234',
  subject: 'Write the parser',
  owner: 'bob',
  epoch: 'epoch',
});
const openCodeTask = (): StallTask => ({
  id: 'task-o',
  displayId: 'feed5678',
  subject: 'Port the CLI',
  owner: 'alice',
  epoch: 'epoch',
});

function evaluateWork(task: StallTask) {
  if (task.laneActive) {
    return {
      status: 'skip',
      taskId: task.id,
      reason: 'OpenCode lane turn is still active.',
      skipReason: 'lane_active',
    };
  }
  return {
    status: 'alert',
    taskId: task.id,
    branch: 'work',
    signal: 'turn_ended_after_touch',
    epochKey: `${task.id}:${task.epoch}`,
    reason: task.idleSince
      ? `Potential work stall: OpenCode lane idle since ${task.idleSince}.`
      : 'Potential work stall.',
  };
}

let root: string;
const monitors: TeamTaskStallMonitor[] = [];

const inboxPath = (memberName: string): string =>
  path.join(getTeamsBasePath(), 'demo', 'inboxes', `${memberName}.json`);

async function readInbox(memberName: string): Promise<InboxMessage[]> {
  return JSON.parse(await readFile(inboxPath(memberName), 'utf8')) as InboxMessage[];
}

async function countLeadRows(): Promise<number> {
  try {
    return (await readInbox('team-lead')).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

async function readJournalEpochKeys(): Promise<string[]> {
  const entries = JSON.parse(
    await readFile(getStallMonitorJournalPath('demo'), 'utf8')
  ) as TaskStallJournalEntry[];
  return entries.map((entry) => entry.epochKey);
}

async function readJournalStates(): Promise<Record<string, string>> {
  const entries = JSON.parse(
    await readFile(getStallMonitorJournalPath('demo'), 'utf8')
  ) as TaskStallJournalEntry[];
  return Object.fromEntries(entries.map((entry) => [entry.taskId, entry.state]));
}

interface OwnerRelayResult {
  lastDelivery: { delivered: boolean; accepted?: boolean; reason?: string };
}

function createMonitor(
  tasks: StallTask[],
  relayOpenCodeMemberInboxMessages = vi.fn(
    async (): Promise<OwnerRelayResult> => ({ lastDelivery: { delivered: true, accepted: true } })
  )
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
      evaluateWork: vi.fn(({ task }: { task: StallTask }) => evaluateWork(task)),
      evaluateReview: vi.fn(),
    } as never,
    journal,
    notifier
  );
  monitor.start();
  monitors.push(monitor);
  // Without an explicit time each scan runs one scan interval after the last.
  let lastScanMs = T0 - SCAN_INTERVAL_MS;
  const scan = (atMs = lastScanMs + SCAN_INTERVAL_MS): Promise<void> => {
    lastScanMs = atMs;
    return (monitor as unknown as ScanDriver).scanTeam('demo', new Date(atMs), {
      cancelled: false,
    });
  };
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
    const { scan, markAlerted } = createMonitor([writerTask()]);

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
    // A plain lead alert, not an owner remediation row the feed hides by default.
    expect(isTaskStallRemediationMessage((await readInbox('team-lead'))[0])).toBe(false);

    // Inside the alert cooldown the next scan sends nothing new.
    await scan();
    expect(await readInbox('team-lead')).toHaveLength(1);
    expect(markAlerted).toHaveBeenCalledTimes(1);
  });

  it('journals the owner nudge when the lead alert fails and retries only the lead', async () => {
    const { scan, markAlerted, relayOpenCodeMemberInboxMessages } = createMonitor([
      openCodeTask(),
      writerTask(),
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

  it('alerts the lead at most three times per stall epoch and starts over on new activity', async () => {
    const task = writerTask();
    const { scan } = createMonitor([task]);
    const leadTexts = async (): Promise<string[]> =>
      (await readInbox('team-lead')).map((message) => message.text);

    await scan(T0);
    // Each later scan lands after the 10 minute cooldown of the previous alert.
    for (const minute of [1, 12, 23, 34, 45]) {
      await scan(T0 + minute * MINUTE_MS);
    }

    expect(await leadTexts()).toHaveLength(3);
    expect(new Set((await readInbox('team-lead')).map((message) => message.messageId)).size).toBe(
      3
    );
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
      '[Service:TeamTaskStallMonitor]',
      expect.stringContaining('stall_alerts_exhausted')
    );
    vi.mocked(console.warn).mockClear();

    task.epoch = 'epoch-after-new-activity';
    await scan(T0 + 56 * MINUTE_MS);
    await scan(T0 + 57 * MINUTE_MS);

    expect(await leadTexts()).toHaveLength(4);
    expect(await readJournalEpochKeys()).toEqual(['task-w:epoch-after-new-activity']);
  });

  it('keeps counting an alerted epoch through owner turns that skip it', async () => {
    // The owner nudge is never accepted, so every rung falls back to the lead.
    const task: StallTask = { ...openCodeTask(), idleSince: 'turn 0' };
    const { scan } = createMonitor(
      [task],
      vi.fn(async () => ({
        lastDelivery: { delivered: true, reason: 'opencode_inbox_message_already_read' },
      }))
    );
    const leadAlertScanMs: number[] = [];
    let atMs = T0;
    const step = async (): Promise<void> => {
      const before = await countLeadRows();
      await scan(atMs);
      if ((await countLeadRows()) > before) leadAlertScanMs.push(atMs);
      atMs += SCAN_INTERVAL_MS;
    };

    await step();
    await step();
    // Each owner turn skips the task for two scans and leaves a new idle time
    // in the alert text: same epoch, different text, so a different message id.
    for (let turn = 1; turn <= 20; turn += 1) {
      task.laneActive = true;
      await step();
      await step();
      task.laneActive = false;
      task.idleSince = `turn ${turn}`;
      await step();
      await step();
    }

    expect(leadAlertScanMs).toHaveLength(3);
    for (let index = 1; index < leadAlertScanMs.length; index += 1) {
      expect(leadAlertScanMs[index] - leadAlertScanMs[index - 1]).toBeGreaterThanOrEqual(
        10 * MINUTE_MS
      );
    }
    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(
      '[Service:TeamTaskStallMonitor]',
      expect.stringContaining('stall_alerts_exhausted')
    );
    vi.mocked(console.warn).mockClear();
  });

  it('drops the journal entry of a task that is no longer active', async () => {
    const tasks = [writerTask()];
    const { scan } = createMonitor(tasks);

    await scan();
    await scan();
    expect(await readJournalEpochKeys()).toEqual(['task-w:epoch']);

    tasks.splice(0);
    await scan();

    expect(await readJournalEpochKeys()).toEqual([]);
  });

  it('does not write the lead alert twice when the journal update after it failed', async () => {
    const { scan, markAlerted } = createMonitor([writerTask()]);
    markAlerted.mockRejectedValueOnce(new Error('journal busy'));

    await scan();
    await expect(scan()).rejects.toThrow('journal busy');
    expect(await readInbox('team-lead')).toHaveLength(1);

    await scan();

    expect(await readInbox('team-lead')).toHaveLength(1);
    expect(await readJournalStates()).toEqual({ 'task-w': 'alerted' });
  });

  it('writes the retried alert as a new row when its text changed meanwhile', async () => {
    const task = writerTask();
    const { scan, markAlerted } = createMonitor([task]);
    markAlerted.mockRejectedValueOnce(new Error('journal busy'));

    await scan();
    await expect(scan()).rejects.toThrow('journal busy');
    task.subject = 'Write the streaming parser';

    await expect(scan()).resolves.toBeUndefined();

    expect((await readInbox('team-lead')).map((message) => message.text)).toEqual([
      '- #abcd1234 [work] Write the parser - Potential work stall.',
      '- #abcd1234 [work] Write the streaming parser - Potential work stall.',
    ]);
    expect(await readJournalStates()).toEqual({ 'task-w': 'alerted' });
  });
});
