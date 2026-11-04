import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BackendSelectingTaskCommentNotificationJournalStore } from '@features/internal-storage/main/composition/BackendSelectingTaskCommentNotificationJournalStore';
import { InternalStorageBackendSelector } from '@features/internal-storage/main/composition/InternalStorageBackendSelector';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getCommentNotificationJournalPath,
  JsonTaskCommentNotificationJournalStore,
} from '../../../../src/main/services/team/JsonTaskCommentNotificationJournalStore';
import { TeamDataService } from '../../../../src/main/services/team/TeamDataService';
import {
  getTasksBasePath,
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';

import type {
  TaskCommentNotificationJournalEntry,
  TaskCommentNotificationJournalStore,
} from '../../../../src/main/services/team/TaskCommentNotificationJournalStore';

const TASK_COMMENT_FORWARDING_ENV = 'CLAUDE_TEAM_TASK_COMMENT_FORWARDING';

let root: string;
let previousForwarding: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'TEST-foreign-team-notifications-'));
  setClaudeBasePathOverride(root);
  previousForwarding = process.env[TASK_COMMENT_FORWARDING_ENV];
  process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  if (previousForwarding === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
  else process.env[TASK_COMMENT_FORWARDING_ENV] = previousForwarding;
  setClaudeBasePathOverride(null);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/** The SQLite side of the journal, kept in memory; the fallback replica stays on disk. */
function createInMemoryJournalStore(): TaskCommentNotificationJournalStore {
  const journals = new Map<string, TaskCommentNotificationJournalEntry[]>();
  return {
    exists: async (teamName) => journals.has(teamName),
    ensureInitialized: async (teamName) => {
      if (!journals.has(teamName)) journals.set(teamName, []);
    },
    read: async (teamName) => structuredClone(journals.get(teamName) ?? []),
    withEntries: async (teamName, fn) => {
      const entries = structuredClone(journals.get(teamName) ?? []);
      const mutation = await fn(entries);
      if (mutation.changed) journals.set(teamName, entries);
      return mutation.result;
    },
  };
}

function createService(ownedTeams: ReadonlySet<string>): TeamDataService {
  const service = new TeamDataService();
  service.setTaskCommentNotificationJournalStore(
    new BackendSelectingTaskCommentNotificationJournalStore(
      new InternalStorageBackendSelector(() =>
        Promise.resolve({
          driver: 'better-sqlite3',
          databasePath: 'test.db',
          schemaVersion: 4,
          integrity: 'ok',
        })
      ),
      createInMemoryJournalStore(),
      new JsonTaskCommentNotificationJournalStore(),
      { fallbackRequiresReplica: false }
    )
  );
  service.setTeamProfileOwnership(async (teamName) => ownedTeams.has(teamName));
  return service;
}

const comment = (id: string, text: string, createdAt: string) => ({
  id,
  author: 'alice',
  text,
  createdAt,
  type: 'regular',
});

async function writeTask(teamName: string, comments: ReturnType<typeof comment>[]): Promise<void> {
  const taskDir = path.join(getTasksBasePath(), teamName);
  await mkdir(taskDir, { recursive: true });
  await writeFile(
    path.join(taskDir, 'task-1.json'),
    JSON.stringify({
      id: 'task-1',
      displayId: 'abcd1234',
      subject: 'Investigate',
      status: 'in_progress',
      owner: 'alice',
      comments,
      historyEvents: [
        {
          id: 'event-1',
          type: 'status_changed',
          from: 'pending',
          to: 'in_progress',
          actor: 'alice',
          timestamp: '2026-10-30T10:00:00.000Z',
        },
      ],
    })
  );
}

/** A running team whose teammate has started a task and commented on it. */
async function writeTeam(teamName: string): Promise<void> {
  const teamDir = path.join(getTeamsBasePath(), teamName);
  await mkdir(teamDir, { recursive: true });
  await writeFile(
    path.join(teamDir, 'config.json'),
    JSON.stringify({
      name: teamName,
      leadSessionId: 'lead-session',
      members: [
        { name: 'team-lead', agentType: 'team-lead' },
        { name: 'alice', role: 'developer' },
      ],
    })
  );
  await writeTask(teamName, [
    comment('comment-1', 'Found the root cause.', '2026-10-30T10:05:00.000Z'),
  ]);
}

async function snapshotTeamDir(teamName: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string, label: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(entryPath, `${label}/${entry.name}`);
      else files[`${label}/${entry.name}`] = await readFile(entryPath, 'utf8');
    }
  };
  await walk(path.join(getTeamsBasePath(), teamName), '');
  return files;
}

const replicaPath = (teamName: string): string =>
  `${getCommentNotificationJournalPath(teamName)}.sqlite-fallback-replica`;

/** Startup initialization, then a new comment and a task start seen by the file watcher. */
async function runNotificationPasses(service: TeamDataService, teamName: string): Promise<void> {
  await service.initializeTaskCommentNotificationState();
  await writeTask(teamName, [
    comment('comment-1', 'Found the root cause.', '2026-10-30T10:05:00.000Z'),
    comment('comment-2', 'The fix is ready for review.', '2026-10-30T10:20:00.000Z'),
  ]);
  await service.notifyLeadOnTeammateTaskComment(teamName, 'task-1');
  await service.notifyLeadOnTeammateTaskStart(teamName, 'task-1');
}

describe('TeamDataService lead notifications for teams this profile does not manage', () => {
  it('writes no journal replica and no lead inbox message into a foreign team', async () => {
    await writeTeam('other-profile');
    const before = await snapshotTeamDir('other-profile');

    await runNotificationPasses(createService(new Set()), 'other-profile');

    expect(await snapshotTeamDir('other-profile')).toEqual(before);
    await expect(readFile(replicaPath('other-profile'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps journaling and forwarding for a team this profile manages', async () => {
    await writeTeam('own');

    await runNotificationPasses(createService(new Set(['own'])), 'own');

    const replica = JSON.parse(await readFile(replicaPath('own'), 'utf8')) as {
      state: string;
      snapshot?: { entries: TaskCommentNotificationJournalEntry[] };
    };
    expect(replica.state).toBe('clean');
    expect(replica.snapshot?.entries.map((entry) => [entry.commentId, entry.state])).toEqual([
      ['comment-1', 'seeded'],
      ['comment-2', 'sent'],
    ]);
    const inbox = JSON.parse(
      await readFile(path.join(getTeamsBasePath(), 'own', 'inboxes', 'team-lead.json'), 'utf8')
    ) as { text: string; messageKind?: string }[];
    expect(inbox.map((message) => message.messageKind ?? message.text.split('\n')[0])).toEqual([
      'task_comment_notification',
      '@alice **started task** #abcd1234 "Investigate"',
    ]);
  });
});
