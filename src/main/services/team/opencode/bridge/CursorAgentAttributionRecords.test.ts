import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  getClaudeBasePath,
  setAppDataBasePath,
  setClaudeBasePathOverride,
} from '@main/utils/pathDecoder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_TEAMS_PROCESS_ATTRIBUTION_DIR_ENV,
  applyCursorAgentAttributionEnv,
  readAttributedCursorAgentProcesses,
  resolveCursorAgentAttributionDirectory,
  summarizeAttributedCursorAgentProcesses,
} from './CursorAgentAttributionRecords';
import { buildOpenCodeAppProfileScope } from './OpenCodeMcpBridgeEnv';

const FIRST_ATTRIBUTION_ID = 'aaaa1111aaaa1111aaaa1111aaaa1111';
const SECOND_ATTRIBUTION_ID = 'bbbb2222bbbb2222bbbb2222bbbb2222';
const UNKNOWN_OWNER = {
  teamId: null,
  teamName: null,
  laneId: null,
  memberName: null,
  runId: null,
  sessionId: null,
  createdAt: null,
  updatedAt: null,
};
/** The directory a joined command line cannot decide, spelled exactly. */
const OWNED_WORKSPACE = 'D:\\work\\app - backup';

describe('CursorAgentAttributionRecords', () => {
  let tempRoot: string;
  let tempHome: string;
  let tempAppDataBase: string;
  let attributionDirectory: string;
  let appProfileScope: string;
  let previousHome: string | undefined;
  let previousAttributionDir: string | undefined;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cursor-agent-attribution-'));
    tempHome = path.join(tempRoot, 'home');
    tempAppDataBase = path.join(tempRoot, 'app-user-data');
    await fs.mkdir(tempHome, { recursive: true });
    previousHome = process.env.HOME;
    previousAttributionDir = process.env[AGENT_TEAMS_PROCESS_ATTRIBUTION_DIR_ENV];
    process.env.HOME = tempHome;
    delete process.env[AGENT_TEAMS_PROCESS_ATTRIBUTION_DIR_ENV];
    setClaudeBasePathOverride(null);
    setAppDataBasePath(tempAppDataBase);
    attributionDirectory = path.join(tempAppDataBase, 'opencode-bridge', 'process-attribution');
    appProfileScope = buildOpenCodeAppProfileScope(tempAppDataBase, getClaudeBasePath());
  });

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    setAppDataBasePath(null);
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousAttributionDir === undefined) {
      delete process.env[AGENT_TEAMS_PROCESS_ATTRIBUTION_DIR_ENV];
    } else {
      process.env[AGENT_TEAMS_PROCESS_ATTRIBUTION_DIR_ENV] = previousAttributionDir;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  function agentRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: 1,
      kind: 'cursor-agent',
      attributionId: FIRST_ATTRIBUTION_ID,
      pid: 4321,
      parentPid: 4320,
      startedAtMs: 1757500000123,
      startTimeToleranceMs: 2000,
      nativeStartToken: 'proc:8843211',
      workspacePath: OWNED_WORKSPACE,
      cwd: OWNED_WORKSPACE,
      appInstanceId: '9100-1757499999000',
      appProfileScope,
      hostPid: 999,
      runtimeVersion: '0.0.95',
      writtenAtMs: 1757500000180,
      exitedAtMs: null,
      ...overrides,
    };
  }

  function hostRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: 1,
      attributionId: FIRST_ATTRIBUTION_ID,
      hostPid: 999,
      hostStartedAtNative: 8712334,
      hostStartTimeFormat: 'linux-ticks',
      projectPath: OWNED_WORKSPACE,
      appInstanceId: '9100-1757499999000',
      appProfileScope,
      runtimeVersion: '0.0.95',
      owners: [
        {
          teamId: 'team-1',
          teamName: 'alpha',
          laneId: 'primary',
          memberName: 'lead',
          runId: 'run-1',
          sessionId: 'session-1',
          createdAt: '2026-09-10T10:00:00.000Z',
          updatedAt: '2026-09-10T10:05:00.000Z',
        },
      ],
      updatedAt: '2026-09-10T10:05:00.000Z',
      ...overrides,
    };
  }

  async function writeAgentFile(
    attributionId: string,
    fileName: string,
    body: unknown
  ): Promise<void> {
    const directory = path.join(attributionDirectory, 'v1', 'agents', attributionId);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, fileName),
      typeof body === 'string' ? body : JSON.stringify(body),
      'utf8'
    );
  }

  async function writeHostFile(attributionId: string, body: unknown): Promise<void> {
    const directory = path.join(attributionDirectory, 'v1', 'hosts');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, `${attributionId}.json`),
      typeof body === 'string' ? body : JSON.stringify(body),
      'utf8'
    );
  }

  /**
   * The whole point of the record: the pid, the start time and the exact
   * `--workspace` argument the process itself wrote down, joined to the team
   * leases its host held - none of which survives a joined command line.
   */
  it('reads back the agent records of this install joined to their host owners', async () => {
    await writeHostFile(FIRST_ATTRIBUTION_ID, hostRecord());
    await writeAgentFile(FIRST_ATTRIBUTION_ID, '4321-1757500000123.json', agentRecord());
    await writeAgentFile(
      FIRST_ATTRIBUTION_ID,
      '4322-1757500000500.json',
      agentRecord({ pid: 4322, kind: 'readiness-probe' })
    );
    await writeAgentFile(
      SECOND_ATTRIBUTION_ID,
      '5000-1757500009000.json',
      agentRecord({ attributionId: SECOND_ATTRIBUTION_ID, pid: 5000 })
    );

    const attributed = await readAttributedCursorAgentProcesses();

    expect(attributed.map((entry) => entry.record.pid)).toEqual([4321, 4322, 5000]);
    expect(attributed[0].record.workspacePath).toBe(OWNED_WORKSPACE);
    expect(attributed[0].record.startedAtMs).toBe(1757500000123);
    expect(attributed[0].record.kind).toBe('cursor-agent');
    expect(attributed[0].owners).toEqual([
      {
        teamId: 'team-1',
        teamName: 'alpha',
        laneId: 'primary',
        memberName: 'lead',
        runId: 'run-1',
        sessionId: 'session-1',
        createdAt: '2026-09-10T10:00:00.000Z',
        updatedAt: '2026-09-10T10:05:00.000Z',
      },
    ]);
    // The probe tree the sweep documents as untouchable is evidence now, not a comment.
    expect(attributed[1].record.kind).toBe('readiness-probe');
    // Missing host evidence is an unknown lease, not a released lease set.
    expect(attributed[2].host).toBeNull();
    expect(attributed[2].owners).toEqual([UNKNOWN_OWNER]);
    expect(summarizeAttributedCursorAgentProcesses(attributed)).toEqual({
      total: 3,
      withRecordedOwner: 2,
    });
  });

  it('ignores an agent record written in a schema version this app does not know', async () => {
    await writeHostFile(FIRST_ATTRIBUTION_ID, hostRecord());
    await writeAgentFile(FIRST_ATTRIBUTION_ID, 'future.json', agentRecord({ schemaVersion: 2 }));

    expect(await readAttributedCursorAgentProcesses()).toEqual([]);
  });

  it.each(['missing', 'invalid JSON', 'unsupported schema', 'mismatched id', 'foreign profile'])(
    'reports an unknown owner for a host with %s',
    async (scenario) => {
      const overrides: Record<string, unknown> = {};
      if (scenario === 'unsupported schema') overrides.schemaVersion = 7;
      if (scenario === 'mismatched id') overrides.attributionId = SECOND_ATTRIBUTION_ID;
      if (scenario === 'foreign profile') overrides.appProfileScope = 'another-install';
      if (scenario !== 'missing') {
        await writeHostFile(
          FIRST_ATTRIBUTION_ID,
          scenario === 'invalid JSON' ? '{' : hostRecord(overrides)
        );
      }
      await writeAgentFile(FIRST_ATTRIBUTION_ID, '4321-1757500000123.json', agentRecord());

      const attributed = await readAttributedCursorAgentProcesses();

      expect(attributed).toHaveLength(1);
      expect(attributed[0].host).toBeNull();
      expect(attributed[0].owners).toEqual([UNKNOWN_OWNER]);
      expect(summarizeAttributedCursorAgentProcesses(attributed)).toEqual({
        total: 1,
        withRecordedOwner: 0,
      });
    }
  );

  it('preserves an explicitly empty lease set from a valid host', async () => {
    await writeHostFile(FIRST_ATTRIBUTION_ID, hostRecord({ owners: [] }));
    await writeAgentFile(FIRST_ATTRIBUTION_ID, '4321-1757500000123.json', agentRecord());

    const attributed = await readAttributedCursorAgentProcesses();

    expect(attributed).toHaveLength(1);
    expect(attributed[0].host).not.toBeNull();
    expect(attributed[0].owners).toEqual([]);
    expect(summarizeAttributedCursorAgentProcesses(attributed)).toEqual({
      total: 1,
      withRecordedOwner: 0,
    });
  });

  it.each([
    { owners: [UNKNOWN_OWNER], owned: 0 },
    { owners: [{ teamName: 'alpha' }], owned: 1 },
    { owners: [{ teamId: 'team-1' }], owned: 1 },
    { owners: [{ teamName: 'alpha' }, { teamId: 'team-2' }], owned: 1 },
  ])('counts processes with named recorded teams: $owners', async ({ owners, owned }) => {
    await writeHostFile(FIRST_ATTRIBUTION_ID, hostRecord({ owners }));
    await writeAgentFile(FIRST_ATTRIBUTION_ID, '4321-1757500000123.json', agentRecord());

    const attributed = await readAttributedCursorAgentProcesses();

    expect(summarizeAttributedCursorAgentProcesses(attributed)).toEqual({
      total: 1,
      withRecordedOwner: owned,
    });
  });

  it('ignores corrupt and malformed records and keeps their readable neighbour', async () => {
    await writeHostFile(FIRST_ATTRIBUTION_ID, hostRecord());
    await writeAgentFile(FIRST_ATTRIBUTION_ID, 'half-written.json', '{"schemaVersion": 1, "pid"');
    await writeAgentFile(FIRST_ATTRIBUTION_ID, 'no-pid.json', agentRecord({ pid: undefined }));
    await writeAgentFile(FIRST_ATTRIBUTION_ID, 'not-a-record.json', ['schemaVersion', 1]);
    await writeAgentFile(FIRST_ATTRIBUTION_ID, '4321-1757500000123.json', agentRecord());

    const attributed = await readAttributedCursorAgentProcesses();

    expect(attributed.map((entry) => entry.record.pid)).toEqual([4321]);
  });

  /**
   * A second copy of this app hashes to another profile scope, writes into
   * another directory, and owns its own processes. Its records are not evidence
   * here - neither for the process nor for the team that owns it.
   */
  it('returns nothing for records another install wrote', async () => {
    await writeHostFile(FIRST_ATTRIBUTION_ID, hostRecord());
    await writeAgentFile(
      FIRST_ATTRIBUTION_ID,
      'foreign.json',
      agentRecord({ pid: 7777, appProfileScope: 'a-different-install' })
    );

    expect(await readAttributedCursorAgentProcesses()).toEqual([]);
  });

  it('does not join owners from a host record another install wrote', async () => {
    await writeHostFile(
      FIRST_ATTRIBUTION_ID,
      hostRecord({ appProfileScope: 'a-different-install' })
    );
    await writeAgentFile(FIRST_ATTRIBUTION_ID, '4321-1757500000123.json', agentRecord());

    const attributed = await readAttributedCursorAgentProcesses();

    expect(attributed).toHaveLength(1);
    expect(attributed[0].owners).toEqual([UNKNOWN_OWNER]);
  });

  /**
   * The attribution id is the join key, and the directory holding the record is
   * where a host record is looked up by. A record that disagrees with its own
   * directory would join to a host that never spawned it.
   */
  it('ignores a record filed under an attribution id that is not its own', async () => {
    await writeHostFile(FIRST_ATTRIBUTION_ID, hostRecord());
    await writeAgentFile(
      FIRST_ATTRIBUTION_ID,
      'misfiled.json',
      agentRecord({ attributionId: SECOND_ATTRIBUTION_ID })
    );

    expect(await readAttributedCursorAgentProcesses()).toEqual([]);
  });

  /** A misfiled host cannot supply lease evidence for the readable agent. */
  it('ignores a host record filed under an attribution id that is not its own', async () => {
    await writeAgentFile(FIRST_ATTRIBUTION_ID, '4321-1757500000123.json', agentRecord());
    // A stale or corrupt host file named for one id but naming another would
    // lend its owners to trees its host never spawned.
    await writeHostFile(SECOND_ATTRIBUTION_ID, hostRecord({ attributionId: FIRST_ATTRIBUTION_ID }));

    const attributed = await readAttributedCursorAgentProcesses();

    expect(attributed.map((entry) => entry.record.pid)).toEqual([4321]);
    expect(attributed[0]?.host).toBeNull();
    expect(attributed[0]?.owners).toEqual([UNKNOWN_OWNER]);
  });

  /**
   * Fail closed on the lease set. A caller that has to prove it may clear every
   * lease refuses on an owner it cannot name, so an unreadable set has to reach
   * it as such - dropped, it would read as "nobody owns this host".
   */
  it('reports an owner set it cannot read as an owner it cannot name', async () => {
    const unnamed = {
      teamId: null,
      teamName: null,
      laneId: null,
      memberName: null,
      runId: null,
      sessionId: null,
      createdAt: null,
      updatedAt: null,
    };
    await writeAgentFile(FIRST_ATTRIBUTION_ID, '4321-1757500000123.json', agentRecord());
    await writeHostFile(FIRST_ATTRIBUTION_ID, hostRecord({ owners: 'team-1' }));
    await writeAgentFile(
      SECOND_ATTRIBUTION_ID,
      '4322-1757500000123.json',
      agentRecord({ attributionId: SECOND_ATTRIBUTION_ID, pid: 4322 })
    );
    await writeHostFile(
      SECOND_ATTRIBUTION_ID,
      hostRecord({
        attributionId: SECOND_ATTRIBUTION_ID,
        owners: [42, { teamId: 'team-2', laneId: 'primary', memberName: 'lead' }],
      })
    );

    const attributed = await readAttributedCursorAgentProcesses();

    expect(attributed.map((entry) => entry.record.pid)).toEqual([4321, 4322]);
    expect(attributed[0]?.owners).toEqual([unnamed]);
    expect(attributed[1]?.owners.map((owner) => owner.teamId)).toEqual([null, 'team-2']);
    expect(summarizeAttributedCursorAgentProcesses(attributed)).toEqual({
      total: 2,
      withRecordedOwner: 1,
    });
  });

  it('answers with no records when the runtime has written none', async () => {
    expect(await readAttributedCursorAgentProcesses()).toEqual([]);
    expect(
      await readAttributedCursorAgentProcesses({ directory: path.join(tempRoot, 'absent') })
    ).toEqual([]);
  });

  it('designates the bridge attribution directory and creates it', async () => {
    const env: NodeJS.ProcessEnv = {};

    await applyCursorAgentAttributionEnv(env);

    expect(env[AGENT_TEAMS_PROCESS_ATTRIBUTION_DIR_ENV]).toBe(attributionDirectory);
    expect(resolveCursorAgentAttributionDirectory({})).toBe(attributionDirectory);
    await expect(fs.stat(attributionDirectory)).resolves.toBeDefined();
  });

  it('keeps a directory the environment already designates', async () => {
    const designated = path.join(tempRoot, 'designated-elsewhere');
    const env: NodeJS.ProcessEnv = { [AGENT_TEAMS_PROCESS_ATTRIBUTION_DIR_ENV]: designated };

    await applyCursorAgentAttributionEnv(env);

    expect(env[AGENT_TEAMS_PROCESS_ATTRIBUTION_DIR_ENV]).toBe(designated);
    await expect(fs.stat(designated)).resolves.toBeDefined();
  });

  it('resolves a relative designation to an absolute path before it travels', async () => {
    const relative = path.join('cursor-agent-attribution-test', `store-${process.pid}`);
    const expected = path.resolve(relative);
    const env: NodeJS.ProcessEnv = { [AGENT_TEAMS_PROCESS_ATTRIBUTION_DIR_ENV]: relative };
    try {
      await applyCursorAgentAttributionEnv(env);

      // The runtime is launched from each project's own working directory, so
      // only an absolute path names the same place for the writer and the reader.
      expect(env[AGENT_TEAMS_PROCESS_ATTRIBUTION_DIR_ENV]).toBe(expected);
      expect(resolveCursorAgentAttributionDirectory(env)).toBe(expected);
      await expect(fs.stat(expected)).resolves.toBeDefined();
    } finally {
      // Only what this test created: the parent goes when nothing else is in it.
      await fs.rm(expected, { recursive: true, force: true });
      await fs.rmdir(path.dirname(expected)).catch(() => undefined);
    }
  });

  it('logs a directory it cannot create and still designates it', async () => {
    const blocker = path.join(tempRoot, 'blocker');
    await fs.writeFile(blocker, 'not a directory', 'utf8');
    const designated = path.join(blocker, 'process-attribution');
    const env: NodeJS.ProcessEnv = { [AGENT_TEAMS_PROCESS_ATTRIBUTION_DIR_ENV]: designated };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await applyCursorAgentAttributionEnv(env);

      // Still designated - the runtime may yet manage what this app could not -
      // and said out loud, so an empty store is not mistaken for this.
      expect(env[AGENT_TEAMS_PROCESS_ATTRIBUTION_DIR_ENV]).toBe(designated);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain(designated);
    } finally {
      errorSpy.mockRestore();
    }
  });

  /**
   * The contract between the two halves of this module: what the app hands the
   * runtime in the bridge environment is the directory the app reads back, and
   * the scope the app hashes for its own env is the scope it filters on.
   */
  it('reads records back out of the directory it designated', async () => {
    const env: NodeJS.ProcessEnv = {};
    await applyCursorAgentAttributionEnv(env);
    // Never the empty string: a relative fallback would put the fixture in the
    // working directory rather than in this test's own temporary tree.
    const designated =
      env[AGENT_TEAMS_PROCESS_ATTRIBUTION_DIR_ENV] ?? path.join(tempRoot, 'undesignated');
    await fs.mkdir(path.join(designated, 'v1', 'agents', FIRST_ATTRIBUTION_ID), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(designated, 'v1', 'agents', FIRST_ATTRIBUTION_ID, '4321-1757500000123.json'),
      JSON.stringify(agentRecord()),
      'utf8'
    );

    const attributed = await readAttributedCursorAgentProcesses();

    expect(attributed.map((entry) => entry.record.pid)).toEqual([4321]);
  });
});
