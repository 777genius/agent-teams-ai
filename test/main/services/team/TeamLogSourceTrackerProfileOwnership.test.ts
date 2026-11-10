import { appendFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  claimTeamForThisProfile,
  createTeamProfileOwnership,
} from '../../../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership';
import { TeamLogSourceTracker } from '../../../../src/main/services/team/TeamLogSourceTracker';
import {
  getTeamsBasePath,
  setClaudeBasePathOverride,
} from '../../../../src/main/utils/pathDecoder';
import { addLogSink } from '../../../../src/shared/utils/logger';

import type { TeamMemberLogsFinder } from '../../../../src/main/services/team/TeamMemberLogsFinder';
import type { TeamChangeEvent } from '../../../../src/shared/types';
import type { LogSinkEntry } from '../../../../src/shared/utils/logger';

const THIS_PROFILE = 'profile-this';
const OTHER_PROFILE = 'profile-other';
const SESSION_ID = 'lead-session';

const originalChokidarUsePolling = process.env.CHOKIDAR_USEPOLLING;
const originalChokidarInterval = process.env.CHOKIDAR_INTERVAL;

let root: string;
let transcriptProjectDir: string;
let workspaceDir: string;
let trackerLogEntries: LogSinkEntry[];
let removeLogSink: () => void;

function teamDir(teamName: string): string {
  return path.join(getTeamsBasePath(), teamName);
}

/** A team as the UI finds it: config, an owner marker (or none) and one lead transcript. */
async function writeTeam(teamName: string, ownerProfile: string | null): Promise<void> {
  await mkdir(teamDir(teamName), { recursive: true });
  await writeFile(
    path.join(teamDir(teamName), 'config.json'),
    `${JSON.stringify({ name: teamName, projectPath: workspaceDir })}\n`
  );
  if (ownerProfile) {
    await claimTeamForThisProfile({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      reason: 'create',
      profileScope: ownerProfile,
    });
  }
}

function createTracker(): {
  tracker: TeamLogSourceTracker;
  emitter: ReturnType<typeof vi.fn<(event: TeamChangeEvent) => void>>;
} {
  const logsFinder = {
    getLiveLogSourceWatchContext: vi.fn(() =>
      Promise.resolve({
        projectDir: transcriptProjectDir,
        projectPath: workspaceDir,
        taskFreshnessRootDirs: [workspaceDir],
        sessionIds: [SESSION_ID],
        watchSessionIds: [SESSION_ID],
      })
    ),
  } as unknown as TeamMemberLogsFinder;
  const ownership = createTeamProfileOwnership({
    isTrackedInThisProcess: () => false,
    getTeamsBasePath,
    getProfileScope: () => THIS_PROFILE,
  });
  const tracker = new TeamLogSourceTracker(logsFinder, (teamName) =>
    ownership.isManagedByThisProfile(teamName)
  );
  const emitter = vi.fn<(event: TeamChangeEvent) => void>();
  tracker.setEmitter(emitter);
  return { tracker, emitter };
}

/** Every directory and file under `dir` with its mtime, and the bytes of every file. */
async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (current: string): Promise<void> => {
    const relative = path.relative(dir, current).split(path.sep).join('/');
    snapshot[`${relative}/`] = `dir mtime=${(await lstat(current)).mtimeMs}`;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      const [stat, bytes] = await Promise.all([lstat(fullPath), readFile(fullPath)]);
      snapshot[path.relative(dir, fullPath).split(path.sep).join('/')] =
        `mtime=${stat.mtimeMs} bytes=${bytes.toString('base64')}`;
    }
  };
  await visit(dir);
  return snapshot;
}

async function settleWatcher(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 350));
}

describe('TeamLogSourceTracker and teams of other profiles', () => {
  beforeAll(() => {
    process.env.CHOKIDAR_USEPOLLING = '1';
    process.env.CHOKIDAR_INTERVAL = '25';
  });

  afterAll(() => {
    if (originalChokidarUsePolling === undefined) {
      delete process.env.CHOKIDAR_USEPOLLING;
    } else {
      process.env.CHOKIDAR_USEPOLLING = originalChokidarUsePolling;
    }
    if (originalChokidarInterval === undefined) {
      delete process.env.CHOKIDAR_INTERVAL;
    } else {
      process.env.CHOKIDAR_INTERVAL = originalChokidarInterval;
    }
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'team-log-source-tracker-ownership-'));
    setClaudeBasePathOverride(path.join(root, '.claude'));
    transcriptProjectDir = path.join(root, '.claude', 'projects', '-workspace');
    workspaceDir = path.join(root, 'workspace');
    await mkdir(transcriptProjectDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(transcriptProjectDir, `${SESSION_ID}.jsonl`), '{"seq":1}\n');
    trackerLogEntries = [];
    removeLogSink = addLogSink((entry) => {
      if (entry.namespace === 'Service:TeamLogSourceTracker') {
        trackerLogEntries.push(entry);
      }
    });
  });

  afterEach(async () => {
    removeLogSink();
    setClaudeBasePathOverride(null);
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ['claimed by another profile', OTHER_PROFILE],
    ['without an owner marker', null],
  ])(
    'leaves a team %s exactly as it was and still reads its logs',
    async (_label, ownerProfile) => {
      await writeTeam('foreign-team', ownerProfile);
      const before = await snapshotTree(root);
      const { tracker, emitter } = createTracker();

      const snapshot = await tracker.enableTracking('foreign-team', 'task_log_stream');
      await settleWatcher();

      // No freshness dir in teams/<team>/, in the transcript project dir or in
      // the workspace, and nothing else touched anywhere under the root.
      expect(await snapshotTree(root)).toEqual(before);
      expect(snapshot.logSourceGeneration).not.toBeNull();

      emitter.mockClear();
      await appendFile(path.join(transcriptProjectDir, `${SESSION_ID}.jsonl`), '{"seq":2}\n');
      await vi.waitFor(() => {
        expect(emitter).toHaveBeenCalledWith({
          type: 'log-source-change',
          teamName: 'foreign-team',
        });
      });

      await tracker.disableTracking('foreign-team', 'task_log_stream');
      expect(trackerLogEntries).toEqual([]);
    }
  );

  it('still delivers freshness signals of a foreign team whose owner created the dirs', async () => {
    await writeTeam('foreign-team', OTHER_PROFILE);
    const signalDir = path.join(teamDir('foreign-team'), 'task-log-freshness');
    await mkdir(signalDir);
    const { tracker, emitter } = createTracker();

    await tracker.enableTracking('foreign-team', 'task_log_stream');
    await settleWatcher();
    emitter.mockClear();

    const taskId = 'foreign-task';
    await writeFile(path.join(signalDir, `${encodeURIComponent(taskId)}.json`), '{"ok":true}');
    await vi.waitFor(() => {
      expect(emitter).toHaveBeenCalledWith({
        type: 'task-log-change',
        teamName: 'foreign-team',
        taskId,
        taskSignalKind: 'log',
      });
    });

    await tracker.disableTracking('foreign-team', 'task_log_stream');
    expect(trackerLogEntries).toEqual([]);
  });

  it('creates the freshness dirs of a team this profile manages, as before', async () => {
    await writeTeam('own-team', THIS_PROFILE);
    const before = await snapshotTree(root);
    const { tracker, emitter } = createTracker();

    await tracker.enableTracking('own-team', 'task_log_stream');
    await settleWatcher();

    const after = await snapshotTree(root);
    const created = Object.keys(after).filter((entry) => !(entry in before));
    expect(new Set(created)).toEqual(
      new Set([
        '.claude/projects/-workspace/.board-task-change-freshness/',
        '.claude/teams/own-team/task-log-freshness/',
        'workspace/.board-task-change-freshness/',
      ])
    );

    emitter.mockClear();
    const taskId = 'own-task';
    await writeFile(
      path.join(teamDir('own-team'), 'task-log-freshness', `${encodeURIComponent(taskId)}.json`),
      '{"ok":true}'
    );
    await vi.waitFor(() => {
      expect(emitter).toHaveBeenCalledWith({
        type: 'task-log-change',
        teamName: 'own-team',
        taskId,
        taskSignalKind: 'log',
      });
    });

    await tracker.disableTracking('own-team', 'task_log_stream');
    expect(trackerLogEntries).toEqual([]);
  });
});
