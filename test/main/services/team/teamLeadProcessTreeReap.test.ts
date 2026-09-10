import { reapCursorAgentLeadTreesForStoppedTeam } from '@main/services/team/lifecycle/teamLeadProcessTreeReap';
import type {
  AttributedCursorAgentProcess,
  CursorAgentAttributionOwner,
} from '@main/services/team/opencode/bridge/CursorAgentAttributionRecords';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

interface CursorAgentSweepInput {
  ownedWorkspaceCwds: readonly string[];
  startedBeforeMs?: number | null;
}
interface CursorAgentSweepOutcome {
  scanned: number;
  killed: number[];
  keptRecent: number[];
  incomplete: boolean;
  diagnostics: string[];
}

const sweepCursorAgentTrees = vi.hoisted(() =>
  vi.fn<(input: CursorAgentSweepInput) => Promise<CursorAgentSweepOutcome>>(() =>
    Promise.resolve({ scanned: 0, killed: [], keptRecent: [], incomplete: false, diagnostics: [] })
  )
);
// Read through the mocked `getTeamsBasePath` closure at call time, so the team
// config this reap reads is a fixture directory rather than the real user's.
const teamsBasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-tree-reap-teams-'));

// The default port reads the host's process table and kills what it finds
// there, so it is stubbed rather than left alone.
vi.mock(
  '@main/services/team/opencode/bridge/CursorAgentProcessCleanup',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@main/services/team/opencode/bridge/CursorAgentProcessCleanup')
    >()),
    DEFAULT_CURSOR_AGENT_TREE_SWEEP_PORT: { isEnabled: () => true, sweepCursorAgentTrees },
  })
);
// The default port reads the record directory this app designates for the
// runtime; every case here hands in what the runtime is supposed to have
// written there, so the assertions are about the stop, not about this machine.
const readAttributedProcesses = vi.hoisted(() =>
  vi.fn<() => Promise<readonly AttributedCursorAgentProcess[]>>(() => Promise.resolve([]))
);
vi.mock(
  '@main/services/team/opencode/bridge/CursorAgentAttributionRecords',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@main/services/team/opencode/bridge/CursorAgentAttributionRecords')
    >()),
    DEFAULT_CURSOR_AGENT_ATTRIBUTION_PORT: { readAttributedProcesses },
  })
);
vi.mock('@main/utils/pathDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/utils/pathDecoder')>()),
  getTeamsBasePath: () => teamsBasePath,
}));

function writeTeamConfig(teamName: string, config: unknown): void {
  fs.mkdirSync(path.join(teamsBasePath, teamName), { recursive: true });
  fs.writeFileSync(
    path.join(teamsBasePath, teamName, 'config.json'),
    JSON.stringify(config),
    'utf8'
  );
}

/**
 * The same directory spelled two ways, in a spelling that really is the same
 * directory on this platform. Case folding is a Windows property: on a
 * case-sensitive filesystem a case variant names a different directory, so a
 * case variant here asserts Windows behaviour where the platform does not have
 * it - which is how this case passed on Windows and failed on the Linux runner.
 */
const sharedWorkspace =
  process.platform === 'win32'
    ? { stopped: 'C:\\workspaces\\shared', alive: 'c:/workspaces/Shared/' }
    : { stopped: '/workspaces/shared', alive: '/workspaces/shared/' };

/** Differs only in case: the same directory exactly where the platform folds case. */
const caseVariantWorkspace =
  process.platform === 'win32'
    ? { stopped: 'C:\\workspaces\\cased', alive: 'C:\\workspaces\\Cased' }
    : { stopped: '/workspaces/cased', alive: '/workspaces/Cased' };

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  fs.rmSync(teamsBasePath, { recursive: true, force: true });
});

describe('reapCursorAgentLeadTreesForStoppedTeam', () => {
  it('reaps the trees launched for this team workspace, fenced by the stop', async () => {
    writeTeamConfig('scopedteam', { projectPath: 'C:\\workspaces\\example' });
    sweepCursorAgentTrees.mockResolvedValueOnce({
      scanned: 4,
      killed: [8100],
      keptRecent: [],
      incomplete: false,
      diagnostics: [],
    });
    const requestedAtMs = Date.parse('2026-09-01T10:00:00.000Z');

    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'scopedteam',
      otherAliveTeams: [],
      requestedAtMs,
    });

    expect(sweepCursorAgentTrees).toHaveBeenCalledExactlyOnceWith({
      ownedWorkspaceCwds: ['C:\\workspaces\\example'],
      startedBeforeMs: requestedAtMs,
      // The stop path adds the marker but does NOT require it: the caller has
      // already proven this exact team was stopped and that no live team shares
      // the directory, and refusing on an unreadable environment would leave the
      // proxy port held for the next launch.
      requiredEnvMarkers: ['CLAUDE_TEAM_APP_INSTANCE_ID='],
      requireOwnershipProof: false,
      // The team's own serve host may still be shutting down beside the lead it
      // owns, so an orphan-only fence would spare the lead for being exactly
      // what it is.
      orphanedOnly: false,
    });
    expect(result.killedPids).toEqual([8100]);
    expect(result.diagnostics).toEqual(['Reaped 1 cursor-agent process tree(s)']);
    // The control for the scan-failure case below: a sweep that finished
    // reports a cleanup that finished.
    expect(result.incomplete).toBe(false);
  });

  /**
   * The ownership proof is the workspace, so a team whose project path this app
   * cannot read is a team whose lead it cannot attribute. That must reap
   * nothing at all; the earlier reading, "no filter means every tree", is a
   * cross-team kill the moment a second team is running.
   */
  it('reaps nothing when this team has no readable project path', async () => {
    writeTeamConfig('pathlessteam', { displayName: 'no project path here' });

    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'pathlessteam',
      otherAliveTeams: [],
    });

    expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
    expect(result.killedPids).toEqual([]);
    expect(result.diagnostics).toEqual([
      'Skipped cursor-agent sweep: this team has no readable project path, and a lead tree is only reaped for a workspace this stop can name',
    ]);
  });

  /**
   * Two teams in one directory launch leads that carry the identical
   * `--workspace`, and nothing on a command line tells them apart. The stop
   * declines rather than reaping the live team's lead.
   */
  it('reaps nothing while another live team works in the same project directory', async () => {
    writeTeamConfig('sharedstop', { projectPath: sharedWorkspace.stopped });
    writeTeamConfig('sharedalive', { projectPath: sharedWorkspace.alive });

    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'sharedstop',
      otherAliveTeams: ['sharedalive'],
    });

    expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
    expect(result.diagnostics).toEqual([
      'Skipped cursor-agent sweep: still-running team(s) work in the same project directory (sharedalive)',
    ]);
  });

  // The guard is exactly as case-sensitive as the filesystem underneath it.
  it('follows the platform on whether a case-variant project path is the same directory', async () => {
    writeTeamConfig('casedstop', { projectPath: caseVariantWorkspace.stopped });
    writeTeamConfig('casedalive', { projectPath: caseVariantWorkspace.alive });

    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'casedstop',
      otherAliveTeams: ['casedalive'],
      requestedAtMs: 1_700_000_000_000,
    });

    if (process.platform === 'win32') {
      expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
      expect(result.diagnostics).toEqual([
        'Skipped cursor-agent sweep: still-running team(s) work in the same project directory (casedalive)',
      ]);
      return;
    }
    // Two different directories here, so the live team is no obstacle at all.
    expect(sweepCursorAgentTrees).toHaveBeenCalledExactlyOnceWith({
      ownedWorkspaceCwds: [caseVariantWorkspace.stopped],
      startedBeforeMs: 1_700_000_000_000,
      // The stop path adds the marker but does NOT require it: the caller has
      // already proven this exact team was stopped and that no live team shares
      // the directory, and refusing on an unreadable environment would leave the
      // proxy port held for the next launch.
      requiredEnvMarkers: ['CLAUDE_TEAM_APP_INSTANCE_ID='],
      requireOwnershipProof: false,
      // The team's own serve host may still be shutting down beside the lead it
      // owns, so an orphan-only fence would spare the lead for being exactly
      // what it is.
      orphanedOnly: false,
    });
  });

  it('still reaps while another team is alive in a different directory', async () => {
    writeTeamConfig('elsewherestop', { projectPath: 'C:\\workspaces\\example' });
    writeTeamConfig('elsewherealive', { projectPath: 'C:\\workspaces\\other' });

    await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'elsewherestop',
      otherAliveTeams: ['elsewherealive'],
      requestedAtMs: 1_700_000_000_000,
    });

    expect(sweepCursorAgentTrees).toHaveBeenCalledExactlyOnceWith({
      ownedWorkspaceCwds: ['C:\\workspaces\\example'],
      startedBeforeMs: 1_700_000_000_000,
      // The stop path adds the marker but does NOT require it: the caller has
      // already proven this exact team was stopped and that no live team shares
      // the directory, and refusing on an unreadable environment would leave the
      // proxy port held for the next launch.
      requiredEnvMarkers: ['CLAUDE_TEAM_APP_INSTANCE_ID='],
      requireOwnershipProof: false,
      // The team's own serve host may still be shutting down beside the lead it
      // owns, so an orphan-only fence would spare the lead for being exactly
      // what it is.
      orphanedOnly: false,
    });
  });

  it('touches no process and says so when the lead tree sweep port is disabled', async () => {
    writeTeamConfig('disabledteam', { projectPath: 'C:\\workspaces\\example' });
    const disabledSweep = vi.fn();

    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'disabledteam',
      otherAliveTeams: [],
      cursorAgentTreeSweep: { isEnabled: () => false, sweepCursorAgentTrees: disabledSweep },
    });

    expect(disabledSweep).not.toHaveBeenCalled();
    expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
    expect(result.diagnostics).toEqual([
      'Skipped cursor-agent sweep: the cursor-agent tree sweep is disabled for this app instance',
    ]);
  });

  /**
   * A sweep that could not read the process table reports and returns an empty
   * result, and the production sweep marks that result `incomplete` - a scan
   * that never ran leaves every tree it would have reaped standing. The stop
   * above it has to carry both out: the diagnostic, so the failure is legible,
   * and the flag, because a stop that reports a completed cleanup here is
   * claiming a lead tree is gone that is still holding the workspace.
   */
  it('passes a sweep that could not scan through as an incomplete cleanup', async () => {
    writeTeamConfig('scanfailteam', { projectPath: 'C:\\workspaces\\example' });
    sweepCursorAgentTrees.mockResolvedValueOnce({
      scanned: 0,
      killed: [],
      keptRecent: [],
      incomplete: true,
      diagnostics: ['cursor-agent process scan failed: process table unavailable'],
    });

    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'scanfailteam',
      otherAliveTeams: [],
    });

    expect(result.killedPids).toEqual([]);
    expect(result.incomplete).toBe(true);
    expect(result.diagnostics).toEqual([
      'cursor-agent sweep: cursor-agent process scan failed: process table unavailable',
    ]);
  });
});

/**
 * The counter-example review reproduced through the real stop helper: stopping a
 * team in `/work/app` reached the live tree of a team in `/work/app - backup`.
 *
 * No parsing rule settles it - `ps` joins argv, so `--workspace /work/app -
 * backup` and `--workspace /work/app` plus arguments are the same string. What
 * the stop DOES know is which teams are still running and where, and that is
 * evidence rather than guesswork.
 */
describe('a live team whose directory cannot be told apart on a command line', () => {
  it('declines instead of reaping', async () => {
    writeTeamConfig('stopped-confusable', { projectPath: '/work/app' });
    writeTeamConfig('alive-confusable', { projectPath: '/work/app - backup' });

    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'stopped-confusable',
      otherAliveTeams: ['alive-confusable'],
      requestedAtMs: 1_700_000_000_000,
    });

    expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
    expect(result.killedPids).toEqual([]);
    expect(result.diagnostics.join(' ')).toContain('cannot be told apart');
  });

  /** The same guard must not fire for an unrelated neighbour. */
  it('still reaps when the other team is merely nearby', async () => {
    writeTeamConfig('stopped-nearby', { projectPath: '/work/app' });
    writeTeamConfig('alive-nearby', { projectPath: '/work/app-backup' });
    sweepCursorAgentTrees.mockResolvedValueOnce({
      scanned: 1,
      killed: [8100],
      keptRecent: [],
      incomplete: false,
      diagnostics: [],
    });

    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'stopped-nearby',
      otherAliveTeams: ['alive-nearby'],
      requestedAtMs: 1_700_000_000_000,
    });

    expect(sweepCursorAgentTrees).toHaveBeenCalledTimes(1);
    expect(result.killedPids).toEqual([8100]);
  });
});

/**
 * The record the runtime writes from inside the process it spawned - the pid,
 * the start time and the exact `--workspace` argument a joined command line
 * cannot give back, plus the teams its host holds leases for.
 *
 * The app cannot act on any of it yet: the proof path needs a pinned runtime
 * that writes the record, so today a stop only reports what it can read. Every
 * fence below has to decide exactly what it decides without a record.
 */
describe('the positive attribution records the runtime writes', () => {
  function owner(teamName: string): CursorAgentAttributionOwner {
    return {
      teamId: `${teamName}-id`,
      teamName,
      laneId: 'primary',
      memberName: 'lead',
      runId: 'run-1',
      sessionId: 'session-1',
      createdAt: '2026-09-10T10:00:00.000Z',
      updatedAt: '2026-09-10T10:05:00.000Z',
    };
  }

  function attributedProcess(
    pid: number,
    owners: readonly CursorAgentAttributionOwner[] = []
  ): AttributedCursorAgentProcess {
    return {
      record: {
        schemaVersion: 1,
        kind: 'cursor-agent',
        attributionId: 'aaaa1111aaaa1111aaaa1111aaaa1111',
        pid,
        parentPid: pid - 1,
        startedAtMs: 1_700_000_000_000,
        startTimeToleranceMs: 2000,
        nativeStartToken: null,
        workspacePath: 'C:\\workspaces\\example',
        cwd: 'C:\\workspaces\\example',
        appInstanceId: '9100-1699999999000',
        appProfileScope: 'this-install',
        hostPid: 999,
        runtimeVersion: '0.0.95',
        writtenAtMs: 1_700_000_000_100,
        exitedAtMs: null,
      },
      host: null,
      owners,
    };
  }

  it('reports the records it can read and still reaps on the command line', async () => {
    writeTeamConfig('attributedteam', { projectPath: 'C:\\workspaces\\example' });
    readAttributedProcesses.mockResolvedValueOnce([
      attributedProcess(4321, [owner('attributedteam')]),
      attributedProcess(4322),
    ]);
    sweepCursorAgentTrees.mockResolvedValueOnce({
      scanned: 2,
      killed: [4321],
      keptRecent: [],
      incomplete: false,
      diagnostics: [],
    });

    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'attributedteam',
      otherAliveTeams: [],
      requestedAtMs: 1_700_000_000_000,
    });

    // Unchanged, deliberately: a record is not yet permission to reap, so every
    // fence the sweep runs under is the one it runs under today.
    expect(sweepCursorAgentTrees).toHaveBeenCalledExactlyOnceWith({
      ownedWorkspaceCwds: ['C:\\workspaces\\example'],
      startedBeforeMs: 1_700_000_000_000,
      requiredEnvMarkers: ['CLAUDE_TEAM_APP_INSTANCE_ID='],
      requireOwnershipProof: false,
      orphanedOnly: false,
    });
    expect(result.killedPids).toEqual([4321]);
    expect(result.diagnostics).toEqual([
      'cursor-agent attribution: 2 runtime process record(s) available, 1 with a recorded owner; this stop still decides on the command line',
      'Reaped 1 cursor-agent process tree(s)',
    ]);
  });

  /**
   * The control: against a runtime that writes no record - every runtime this
   * app pins today - the stop reports exactly what it reported before.
   */
  it('says nothing about attribution when the runtime recorded none', async () => {
    writeTeamConfig('unattributedteam', { projectPath: 'C:\\workspaces\\example' });
    sweepCursorAgentTrees.mockResolvedValueOnce({
      scanned: 1,
      killed: [8100],
      keptRecent: [],
      incomplete: false,
      diagnostics: [],
    });

    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'unattributedteam',
      otherAliveTeams: [],
      requestedAtMs: 1_700_000_000_000,
    });

    expect(result.diagnostics).toEqual(['Reaped 1 cursor-agent process tree(s)']);
  });

  /**
   * The records are read before the switch, because whether the runtime writes
   * them at all is exactly what an operator deciding to turn the sweep on needs
   * to know - and reading them changes nothing the switch decides.
   */
  it('reports the records even where the sweep itself is switched off', async () => {
    writeTeamConfig('disabledattributedteam', { projectPath: 'C:\\workspaces\\example' });
    readAttributedProcesses.mockResolvedValueOnce([attributedProcess(4321, [owner('alpha')])]);

    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'disabledattributedteam',
      otherAliveTeams: [],
      cursorAgentTreeSweep: { isEnabled: () => false, sweepCursorAgentTrees: vi.fn() },
    });

    expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
    expect(result.killedPids).toEqual([]);
    expect(result.diagnostics).toEqual([
      'cursor-agent attribution: 1 runtime process record(s) available, 1 with a recorded owner; this stop still decides on the command line',
      'Skipped cursor-agent sweep: the cursor-agent tree sweep is disabled for this app instance',
    ]);
  });
});
