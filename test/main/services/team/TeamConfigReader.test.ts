import * as nodeFs from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  teamsBase: '',
}));

vi.mock('../../../../src/main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => hoisted.teamsBase,
}));

vi.mock('../../../../src/main/services/team/TeamFsWorkerClient', () => ({
  getTeamFsWorkerClient: () => ({
    isAvailable: () => false,
  }),
}));

import { TeamConfigReader } from '../../../../src/main/services/team/TeamConfigReader';
import { createPersistedLaunchSummaryProjection } from '../../../../src/main/services/team/TeamLaunchSummaryProjection';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('TeamConfigReader', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-config-reader-'));
    hoisted.teamsBase = tempDir;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    TeamConfigReader.clearCacheForTests();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    hoisted.teamsBase = '';
  });

  it('uses compact launch summary projection when launch-state.json is oversized', async () => {
    const teamName = 'mixed-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Mixed Team',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    await fs.writeFile(path.join(teamDir, 'launch-state.json'), 'x'.repeat(40 * 1024), 'utf8');
    await fs.writeFile(
      path.join(teamDir, 'launch-summary.json'),
      JSON.stringify(
        createPersistedLaunchSummaryProjection({
          version: 2,
          teamName,
          updatedAt: '2026-04-22T12:00:00.000Z',
          launchPhase: 'finished',
          expectedMembers: ['alice', 'bob'],
          bootstrapExpectedMembers: ['alice'],
          members: {
            alice: {
              name: 'alice',
              providerId: 'codex',
              laneId: 'primary',
              laneKind: 'primary',
              laneOwnerProviderId: 'codex',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              hardFailure: false,
              lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
            },
            bob: {
              name: 'bob',
              providerId: 'opencode',
              laneId: 'secondary:opencode:bob',
              laneKind: 'secondary',
              laneOwnerProviderId: 'opencode',
              launchState: 'failed_to_start',
              agentToolAccepted: true,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: true,
              hardFailureReason: 'Side lane failed',
              lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
            },
          },
          summary: {
            confirmedCount: 1,
            pendingCount: 0,
            failedCount: 1,
            runtimeAlivePendingCount: 0,
          },
          teamLaunchState: 'partial_failure',
        } as never),
        null,
        2
      ),
      'utf8'
    );
    await fs.writeFile(
      path.join(teamDir, 'bootstrap-state.json'),
      JSON.stringify({
        version: 1,
        teamName,
        runId: 'bootstrap-run-1',
        ownerPid: process.pid,
        startedAt: Date.parse('2026-04-22T12:01:00.000Z'),
        updatedAt: Date.parse('2026-04-22T12:01:00.000Z'),
        phase: 'spawning_members',
        members: [{ name: 'alice', status: 'pending' }],
      }),
      'utf8'
    );

    const reader = new TeamConfigReader();
    const teams = await reader.listTeams();
    expect(teams).toHaveLength(1);
    expect(teams[0]).toMatchObject({
      teamName,
      displayName: 'Mixed Team',
      partialLaunchFailure: true,
      expectedMemberCount: 2,
      confirmedMemberCount: 1,
      missingMembers: ['bob'],
      teamLaunchState: 'partial_failure',
      confirmedCount: 1,
      pendingCount: 0,
      failedCount: 1,
    });
  });

  it('projects bootstrap-confirmed provisioned-but-not-alive launch state as settled', async () => {
    const teamName = 'signal-ops';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Signal Ops',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(teamDir, 'launch-state.json'),
      JSON.stringify({
        version: 2,
        teamName,
        updatedAt: '2026-05-25T20:14:02.147Z',
        launchPhase: 'finished',
        expectedMembers: ['tom'],
        members: {
          tom: {
            name: 'tom',
            providerId: 'anthropic',
            launchState: 'failed_to_start',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: true,
            hardFailure: true,
            hardFailureReason: 'CLI process exited (code 1) \u2014 team provisioned but not alive',
            livenessKind: 'confirmed_bootstrap',
            runtimeDiagnostic:
              'runtime pid could not be verified because process table is unavailable',
            runtimeDiagnosticSeverity: 'warning',
            firstSpawnAcceptedAt: '2026-05-25T20:13:46.326Z',
            lastHeartbeatAt: '2026-05-25T20:13:56.110Z',
            lastEvaluatedAt: '2026-05-25T20:14:02.147Z',
          },
        },
        summary: {
          confirmedCount: 0,
          pendingCount: 0,
          failedCount: 1,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'partial_failure',
      }),
      'utf8'
    );

    const reader = new TeamConfigReader();
    const teams = await reader.listTeams();

    expect(teams).toHaveLength(1);
    expect(teams[0]).toMatchObject({
      teamName,
      displayName: 'Signal Ops',
      teamLaunchState: 'clean_success',
      confirmedMemberCount: 1,
      confirmedCount: 1,
      failedCount: 0,
    });
    expect(teams[0]).not.toMatchObject({
      partialLaunchFailure: true,
      missingMembers: ['tom'],
    });
  });

  it('does not invent a partial-failure summary from artifact counts for mixed-aware teams when canonical launch truth is unavailable', async () => {
    const teamName = 'mixed-aware-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(path.join(teamDir, 'inboxes'), { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Mixed Aware Team',
        leadSessionId: 'lead-session-1',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(teamDir, 'team.meta.json'),
      JSON.stringify({
        version: 1,
        cwd: tempDir,
        providerId: 'codex',
        createdAt: Date.now(),
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(teamDir, 'members.meta.json'),
      JSON.stringify({
        version: 1,
        members: [
          { name: 'alice', providerId: 'codex', role: 'reviewer' },
          { name: 'tom', providerId: 'opencode', role: 'developer' },
        ],
      }),
      'utf8'
    );
    await fs.writeFile(path.join(teamDir, 'inboxes', 'alice.json'), '{}', 'utf8');

    const reader = new TeamConfigReader();
    const teams = await reader.listTeams();
    expect(teams).toHaveLength(1);
    expect(teams[0]).toMatchObject({
      teamName,
      displayName: 'Mixed Aware Team',
      memberCount: 2,
    });
    expect(teams[0]?.partialLaunchFailure).toBeUndefined();
    expect(teams[0]?.teamLaunchState).toBeUndefined();
    expect(teams[0]?.missingMembers).toBeUndefined();
  });

  it('exposes lead summary fields without adding lead to teammate member chips', async () => {
    const teamName = 'lead-summary-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Lead Summary Team',
        members: [
          { name: 'captain', agentType: 'team-lead', color: '#123456' },
          { name: 'alice', role: 'reviewer', color: '#abcdef' },
        ],
      }),
      'utf8'
    );

    const reader = new TeamConfigReader();
    const teams = await reader.listTeams();

    expect(teams).toHaveLength(1);
    expect(teams[0]).toMatchObject({
      teamName,
      displayName: 'Lead Summary Team',
      memberCount: 1,
      members: [{ name: 'alice', role: 'reviewer', color: '#abcdef' }],
      leadName: 'captain',
      leadColor: '#123456',
    });
  });

  it('dedupes and briefly caches listTeams scans until invalidated', async () => {
    const teamName = 'cached-list-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Cached List Team',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    const readdirSpy = vi.spyOn(nodeFs.promises, 'readdir');

    const reader = new TeamConfigReader();
    const [first, second] = await Promise.all([reader.listTeams(), reader.listTeams()]);
    const readdirAfterFirstBatch = readdirSpy.mock.calls.length;

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);

    await reader.listTeams();
    expect(readdirSpy).toHaveBeenCalledTimes(readdirAfterFirstBatch);

    TeamConfigReader.invalidateTeam(teamName);
    await reader.listTeams();
    expect(readdirSpy.mock.calls.length).toBeGreaterThan(readdirAfterFirstBatch);
  });

  it('returns a frozen team-summary snapshot shared across cached reads (no per-read clone)', async () => {
    const teamName = 'frozen-list-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Frozen Team',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );

    const reader = new TeamConfigReader();
    const first = await reader.listTeams();
    const second = await reader.listTeams(); // served from cache

    expect(first.length).toBeGreaterThan(0);
    // Deep-frozen so the shared snapshot cannot be mutated by any reader.
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    // Same reference across reads -> the per-read structuredClone is gone.
    expect(second).toBe(first);
  });

  it('does not reuse a stale in-flight listTeams scan after invalidation', async () => {
    const teamName = 'inflight-invalidated-list-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Before Invalidation',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );

    const firstReadStarted = createDeferred<void>();
    const releaseFirstRead = createDeferred<void>();
    const originalReaddir = nodeFs.promises.readdir.bind(nodeFs.promises);
    let blockedFirstTeamScan = false;
    const readdirSpy = vi
      .spyOn(nodeFs.promises, 'readdir')
      .mockImplementation(async (...args: unknown[]) => {
        if (!blockedFirstTeamScan && args[0] === tempDir) {
          blockedFirstTeamScan = true;
          firstReadStarted.resolve();
          await releaseFirstRead.promise;
        }
        return originalReaddir(...(args as Parameters<typeof nodeFs.promises.readdir>));
      });

    const reader = new TeamConfigReader();
    const first = reader.listTeams();
    await firstReadStarted.promise;

    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'After Invalidation',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    TeamConfigReader.invalidateTeam(teamName);

    const second = reader.listTeams();
    await Promise.resolve();

    const teamDirReads = readdirSpy.mock.calls.filter((call) => call[0] === tempDir);
    expect(teamDirReads.length).toBeGreaterThanOrEqual(2);

    releaseFirstRead.resolve();
    const [, secondTeams] = await Promise.all([first, second]);
    expect(secondTeams[0]?.displayName).toBe('After Invalidation');
  });

  it('does not let a removed base member hide an active auto-suffixed teammate in team summaries', async () => {
    const teamName = 'suffix-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Suffix Team',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(teamDir, 'members.meta.json'),
      JSON.stringify({
        version: 1,
        members: [
          { name: 'alice', role: 'developer', removedAt: Date.now() - 60_000 },
          { name: 'alice-2', role: 'reviewer' },
        ],
      }),
      'utf8'
    );

    const reader = new TeamConfigReader();
    const teams = await reader.listTeams();
    expect(teams).toHaveLength(1);
    expect(teams[0]).toMatchObject({
      teamName,
      displayName: 'Suffix Team',
      memberCount: 1,
      members: [{ name: 'alice-2', role: 'reviewer' }],
    });
  });

  it('counts only active non-lead teammates for draft team summaries', async () => {
    const teamName = 'draft-summary-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'team.meta.json'),
      JSON.stringify({
        version: 1,
        cwd: tempDir,
        displayName: 'Draft Summary Team',
        createdAt: Date.parse('2026-04-22T12:00:00.000Z'),
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(teamDir, 'members.meta.json'),
      JSON.stringify({
        version: 1,
        members: [
          { name: 'team-lead', agentType: 'team-lead', color: '#123456' },
          { name: 'alice', removedAt: Date.now() - 60_000 },
          { name: 'bob', role: 'developer' },
        ],
      }),
      'utf8'
    );

    const reader = new TeamConfigReader();
    const teams = await reader.listTeams();
    expect(teams).toHaveLength(1);
    expect(teams[0]).toMatchObject({
      teamName,
      displayName: 'Draft Summary Team',
      memberCount: 1,
      leadName: 'team-lead',
      leadColor: '#123456',
      pendingCreate: true,
    });
  });

  it('uses injected members meta store for draft team summaries', async () => {
    const teamName = 'draft-summary-injected-store-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'team.meta.json'),
      JSON.stringify({
        version: 1,
        cwd: tempDir,
        displayName: 'Injected Draft Team',
        createdAt: Date.parse('2026-04-22T12:00:00.000Z'),
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(teamDir, 'members.meta.json'),
      JSON.stringify({ version: 1, members: [] }),
      'utf8'
    );
    const getMembers = vi.fn(async () => [
      { name: 'captain', agentType: 'team-lead', color: '#123456' },
      { name: 'alice', role: 'developer' },
    ]);

    const reader = new TeamConfigReader({ getMembers } as never);
    const teams = await reader.listTeams();

    expect(getMembers).toHaveBeenCalledWith(teamName);
    expect(teams[0]).toMatchObject({
      teamName,
      displayName: 'Injected Draft Team',
      memberCount: 1,
      leadName: 'captain',
      leadColor: '#123456',
      pendingCreate: true,
    });
  });

  it('shares in-flight verified reads without reusing completed cache', async () => {
    const teamName = 'cached-config-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Cached Config Team',
        projectPath: tempDir,
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    const readFileSpy = vi.spyOn(nodeFs.promises, 'readFile');

    const reader = new TeamConfigReader();
    const [first, second] = await Promise.all([
      reader.getConfigVerified(teamName),
      reader.getConfigVerified(teamName),
    ]);
    if (!first) {
      throw new Error('Expected config to load.');
    }
    first.name = 'Mutated In Caller';
    const third = await reader.getConfigVerified(teamName);

    expect(second?.name).toBe('Cached Config Team');
    expect(third?.name).toBe('Cached Config Team');
    expect(readFileSpy).toHaveBeenCalledTimes(2);
  });

  it('uses fingerprint-validated snapshot cache without rereading unchanged config content', async () => {
    const teamName = 'snapshot-cache-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Snapshot Cache Team',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    const readFileSpy = vi.spyOn(nodeFs.promises, 'readFile');
    const statSpy = vi.spyOn(nodeFs.promises, 'stat');

    const reader = new TeamConfigReader();
    const first = await reader.getConfigSnapshot(teamName);
    if (!first) {
      throw new Error('Expected config to load.');
    }
    first.name = 'Mutated In Caller';
    const second = await reader.getConfigSnapshot(teamName);

    expect(second?.name).toBe('Snapshot Cache Team');
    expect(statSpy).toHaveBeenCalledTimes(2);
    expect(readFileSpy).toHaveBeenCalledTimes(1);
  });

  it('logs slow config reads with mode, likely cause, generation, and caller diagnostics', async () => {
    const teamName = 'slow-read-diagnostics-team';
    const teamDir = path.join(tempDir, teamName);
    const configPath = path.join(teamDir, 'config.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'Slow Diagnostics Team',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2_001)
      .mockReturnValueOnce(2_001)
      .mockReturnValueOnce(2_001)
      .mockReturnValueOnce(2_001)
      .mockReturnValueOnce(2_001);

    const reader = new TeamConfigReader();
    expect((await reader.getConfigVerified(teamName))?.name).toBe('Slow Diagnostics Team');

    const slowLog = warnSpy.mock.calls.find((call) =>
      String(call[1] ?? '').includes('[getConfig] slow read diag=')
    );
    expect(slowLog).toBeTruthy();
    const rawMessage = String(slowLog?.[1] ?? '');
    const diag = JSON.parse(rawMessage.slice(rawMessage.indexOf('diag=') + 'diag='.length)) as {
      mode: string;
      configPath: string;
      likelyCause: string;
      readMs: number;
      cacheGeneration: number;
      currentGeneration: number;
      caller: string | null;
    };
    expect(diag).toMatchObject({
      mode: 'verified',
      configPath,
      likelyCause: 'io_read_slow',
      readMs: 2000,
      cacheGeneration: 0,
      currentGeneration: 0,
    });
    expect(diag.caller).toBeTruthy();
  });

  it('shares in-flight snapshot stat and read work for concurrent calls', async () => {
    const teamName = 'snapshot-inflight-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Snapshot Inflight Team',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    const readFileSpy = vi.spyOn(nodeFs.promises, 'readFile');
    const statSpy = vi.spyOn(nodeFs.promises, 'stat');

    const reader = new TeamConfigReader();
    const [first, second] = await Promise.all([
      reader.getConfigSnapshot(teamName),
      reader.getConfigSnapshot(teamName),
    ]);

    expect(first?.name).toBe('Snapshot Inflight Team');
    expect(second?.name).toBe('Snapshot Inflight Team');
    expect(statSpy).toHaveBeenCalledTimes(1);
    expect(readFileSpy).toHaveBeenCalledTimes(1);
  });

  it('rereads snapshot when ctime changes even if mtime is unchanged', async () => {
    const teamName = 'snapshot-ctime-team';
    const teamDir = path.join(tempDir, teamName);
    const configPath = path.join(teamDir, 'config.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'Before Ctime',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    let ctimeMs = 1000;
    vi.spyOn(nodeFs.promises, 'stat').mockImplementation(
      async () =>
        ({
          size: BigInt(4096),
          mode: BigInt(33188),
          dev: BigInt(1),
          ino: BigInt(2),
          mtimeMs: 1000,
          ctimeMs,
          birthtimeMs: 1000,
          isFile: () => true,
        }) as never
    );
    const readFileSpy = vi.spyOn(nodeFs.promises, 'readFile');

    const reader = new TeamConfigReader();
    expect((await reader.getConfigSnapshot(teamName))?.name).toBe('Before Ctime');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'After Ctime',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    ctimeMs = 2000;

    expect((await reader.getConfigSnapshot(teamName))?.name).toBe('After Ctime');
    expect(readFileSpy).toHaveBeenCalledTimes(2);
  });

  it('rereads snapshot when the config fingerprint changes', async () => {
    const teamName = 'snapshot-reread-team';
    const teamDir = path.join(tempDir, teamName);
    const configPath = path.join(teamDir, 'config.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'Before',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    const readFileSpy = vi.spyOn(nodeFs.promises, 'readFile');

    const reader = new TeamConfigReader();
    expect((await reader.getConfigSnapshot(teamName))?.name).toBe('Before');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'After',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );

    expect((await reader.getConfigSnapshot(teamName))?.name).toBe('After');
    expect(readFileSpy).toHaveBeenCalledTimes(2);
  });

  it('primeConfig updates snapshot cache immediately after app-owned writes', async () => {
    const teamName = 'prime-cache-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Before Prime',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );

    const reader = new TeamConfigReader();
    expect((await reader.getConfigSnapshot(teamName))?.name).toBe('Before Prime');
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'After Prime',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    await TeamConfigReader.primeConfig(teamName, {
      name: 'After Prime',
      members: [{ name: 'team-lead', agentType: 'team-lead' }],
    } as never);

    const snapshot = await reader.getConfigSnapshot(teamName);
    expect(snapshot?.name).toBe('After Prime');
  });

  it('does not let stale in-flight snapshot reads overwrite a primed config cache', async () => {
    const teamName = 'stale-read-prime-team';
    const teamDir = path.join(tempDir, teamName);
    const configPath = path.join(teamDir, 'config.json');
    await fs.mkdir(teamDir, { recursive: true });
    const staleRaw = JSON.stringify({
      name: 'Stale Read',
      members: [{ name: 'team-lead', agentType: 'team-lead' }],
    });
    await fs.writeFile(configPath, staleRaw, 'utf8');

    const readDeferred = createDeferred<string>();
    const realReadFile = nodeFs.promises.readFile.bind(nodeFs.promises);
    let intercepted = false;
    vi.spyOn(nodeFs.promises, 'readFile').mockImplementation(((
      file: unknown,
      ...args: unknown[]
    ) => {
      if (!intercepted && String(file) === configPath) {
        intercepted = true;
        return readDeferred.promise as never;
      }
      return realReadFile(file as never, ...(args as never[])) as never;
    }) as never);

    const reader = new TeamConfigReader();
    const staleSnapshot = reader.getConfigSnapshot(teamName);
    await vi.waitFor(() => expect(intercepted).toBe(true));

    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'Fresh Prime',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    await TeamConfigReader.primeConfig(teamName, {
      name: 'Fresh Prime',
      members: [{ name: 'team-lead', agentType: 'team-lead' }],
    } as never);

    readDeferred.resolve(staleRaw);
    expect((await staleSnapshot)?.name).toBe('Stale Read');

    vi.spyOn(nodeFs.promises, 'stat').mockRejectedValue(new Error('stat unavailable'));
    expect((await reader.getConfigSnapshot(teamName))?.name).toBe('Fresh Prime');
  });

  it('does not reuse stale in-flight verified reads after app-owned primeConfig', async () => {
    const teamName = 'verified-stale-read-prime-team';
    const teamDir = path.join(tempDir, teamName);
    const configPath = path.join(teamDir, 'config.json');
    await fs.mkdir(teamDir, { recursive: true });
    const staleRaw = JSON.stringify({
      name: 'Stale Verified Read',
      members: [{ name: 'team-lead', agentType: 'team-lead' }],
    });
    await fs.writeFile(configPath, staleRaw, 'utf8');

    const readDeferred = createDeferred<string>();
    const realReadFile = nodeFs.promises.readFile.bind(nodeFs.promises);
    let intercepted = false;
    vi.spyOn(nodeFs.promises, 'readFile').mockImplementation(((
      file: unknown,
      ...args: unknown[]
    ) => {
      if (!intercepted && String(file) === configPath) {
        intercepted = true;
        return readDeferred.promise as never;
      }
      return realReadFile(file as never, ...(args as never[])) as never;
    }) as never);

    const reader = new TeamConfigReader();
    const staleVerified = reader.getConfig(teamName);
    await vi.waitFor(() => expect(intercepted).toBe(true));

    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'Fresh Verified Prime',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    await TeamConfigReader.primeConfig(teamName, {
      name: 'Fresh Verified Prime',
      members: [{ name: 'team-lead', agentType: 'team-lead' }],
    } as never);

    expect((await reader.getConfig(teamName))?.name).toBe('Fresh Verified Prime');

    readDeferred.resolve(staleRaw);
    expect((await staleVerified)?.name).toBe('Stale Verified Read');
    expect((await reader.getConfigSnapshot(teamName))?.name).toBe('Fresh Verified Prime');
  });

  it('does not let stale in-flight snapshot read failures invalidate a primed config cache', async () => {
    const teamName = 'stale-read-failure-prime-team';
    const teamDir = path.join(tempDir, teamName);
    const configPath = path.join(teamDir, 'config.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'Before Failure',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );

    const readDeferred = createDeferred<string>();
    const realReadFile = nodeFs.promises.readFile.bind(nodeFs.promises);
    let intercepted = false;
    vi.spyOn(nodeFs.promises, 'readFile').mockImplementation(((
      file: unknown,
      ...args: unknown[]
    ) => {
      if (!intercepted && String(file) === configPath) {
        intercepted = true;
        return readDeferred.promise as never;
      }
      return realReadFile(file as never, ...(args as never[])) as never;
    }) as never);

    const reader = new TeamConfigReader();
    const staleSnapshot = reader.getConfigSnapshot(teamName);
    await vi.waitFor(() => expect(intercepted).toBe(true));

    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'Fresh After Failure',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    await TeamConfigReader.primeConfig(teamName, {
      name: 'Fresh After Failure',
      members: [{ name: 'team-lead', agentType: 'team-lead' }],
    } as never);

    readDeferred.reject(new Error('old read failed'));
    await expect(staleSnapshot).resolves.toBeNull();

    vi.spyOn(nodeFs.promises, 'stat').mockRejectedValue(new Error('stat unavailable'));
    expect((await reader.getConfigSnapshot(teamName))?.name).toBe('Fresh After Failure');
  });

  it('does not let stale in-flight snapshot stat results invalidate a primed config cache', async () => {
    const teamName = 'stale-stat-prime-team';
    const teamDir = path.join(tempDir, teamName);
    const configPath = path.join(teamDir, 'config.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'Before Stat Race',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );

    const statDeferred = createDeferred<unknown>();
    let statCalls = 0;
    vi.spyOn(nodeFs.promises, 'stat').mockImplementation(async () => {
      statCalls++;
      if (statCalls === 1) {
        return (await statDeferred.promise) as never;
      }
      throw new Error('stat unavailable');
    });

    const reader = new TeamConfigReader();
    const snapshot = reader.getConfigSnapshot(teamName);
    await vi.waitFor(() => expect(statCalls).toBe(1));

    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'Fresh After Stat Race',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    await TeamConfigReader.primeConfig(teamName, {
      name: 'Fresh After Stat Race',
      members: [{ name: 'team-lead', agentType: 'team-lead' }],
    } as never);

    statDeferred.resolve({
      size: BigInt(4096),
      mode: BigInt(33188),
      dev: BigInt(1),
      ino: BigInt(2),
      mtimeMs: 1000,
      ctimeMs: 1000,
      birthtimeMs: 1000,
      isFile: () => false,
    });

    expect((await snapshot)?.name).toBe('Fresh After Stat Race');
  });

  it('invalidateTeam forces the next snapshot to reread config content', async () => {
    const teamName = 'invalidate-cache-team';
    const teamDir = path.join(tempDir, teamName);
    const configPath = path.join(teamDir, 'config.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'Before Invalidate',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    const readFileSpy = vi.spyOn(nodeFs.promises, 'readFile');

    const reader = new TeamConfigReader();
    expect((await reader.getConfigSnapshot(teamName))?.name).toBe('Before Invalidate');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'After Invalidate',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    TeamConfigReader.invalidateTeam(teamName);

    expect((await reader.getConfigSnapshot(teamName))?.name).toBe('After Invalidate');
    expect(readFileSpy).toHaveBeenCalledTimes(2);
  });

  it('uses recent snapshot cache on stat failure but verified mode does not', async () => {
    const teamName = 'stat-failure-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Recent Cache',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );

    const reader = new TeamConfigReader();
    expect((await reader.getConfigSnapshot(teamName))?.name).toBe('Recent Cache');
    vi.spyOn(nodeFs.promises, 'stat').mockRejectedValue(new Error('stat unavailable'));

    expect((await reader.getConfigSnapshot(teamName))?.name).toBe('Recent Cache');
    await expect(reader.getConfigVerified(teamName)).resolves.toBeNull();
  });

  it('clears snapshot cache after parse failure', async () => {
    const teamName = 'parse-failure-team';
    const teamDir = path.join(tempDir, teamName);
    const configPath = path.join(teamDir, 'config.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'Valid Config',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );

    const reader = new TeamConfigReader();
    expect((await reader.getConfigSnapshot(teamName))?.name).toBe('Valid Config');
    await fs.writeFile(configPath, '{"name":', 'utf8');

    expect(await reader.getConfigSnapshot(teamName)).toBeNull();
    await fs.rm(configPath);
    expect(await reader.getConfigSnapshot(teamName)).toBeNull();
  });

  it('clears snapshot cache when config disappears and reloads after recreation', async () => {
    const teamName = 'missing-then-recreated-team';
    const teamDir = path.join(tempDir, teamName);
    const configPath = path.join(teamDir, 'config.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'Before Delete',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );

    const reader = new TeamConfigReader();
    expect((await reader.getConfigSnapshot(teamName))?.name).toBe('Before Delete');
    await fs.rm(configPath);

    expect(await reader.getConfigSnapshot(teamName)).toBeNull();
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'After Recreate',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );

    expect((await reader.getConfigSnapshot(teamName))?.name).toBe('After Recreate');
  });

  it('bounds stale snapshots on coarse fingerprints with periodic full verification', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-30T12:00:00.000Z'));

    const teamName = 'coarse-fs-team';
    const teamDir = path.join(tempDir, teamName);
    const configPath = path.join(teamDir, 'config.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'Alpha',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    const readFileSpy = vi.spyOn(nodeFs.promises, 'readFile');
    vi.spyOn(nodeFs.promises, 'stat').mockResolvedValue({
      size: BigInt(4096),
      mode: BigInt(33188),
      dev: BigInt(1),
      ino: BigInt(2),
      mtimeMs: 1000,
      ctimeMs: 1000,
      birthtimeMs: 1000,
      isFile: () => true,
    } as never);

    const reader = new TeamConfigReader();
    expect((await reader.getConfigSnapshot(teamName))?.name).toBe('Alpha');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'Bravo',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );

    expect((await reader.getConfigSnapshot(teamName))?.name).toBe('Alpha');
    vi.advanceTimersByTime(1_501);
    expect((await reader.getConfigSnapshot(teamName))?.name).toBe('Bravo');
    expect(readFileSpy).toHaveBeenCalledTimes(2);
  });
});
