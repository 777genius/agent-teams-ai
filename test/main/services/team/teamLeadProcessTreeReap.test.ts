import { reapCursorAgentLeadTreesForStoppedTeam } from '@main/services/team/lifecycle/teamLeadProcessTreeReap';
import * as teamProjectWorkspaces from '@main/services/team/TeamProjectWorkspaces';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AttributedCursorAgentProcess,
  CursorAgentAttributionOwner,
  CursorAgentAttributionRecord,
} from '@main/services/team/opencode/bridge/CursorAgentAttributionRecords';

interface CursorAgentSweepInput {
  ownedWorkspaceCwds: readonly string[];
  startedBeforeMs?: number | null;
  reconfirmAttribution?: (record: CursorAgentAttributionRecord) => Promise<boolean>;
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
    // `allowsUnattributedReap` is the operator switch; the cases that predate
    // the runtime records assert the command-line path, so it is on here and
    // turned off explicitly where a case is about a record.
    DEFAULT_CURSOR_AGENT_TREE_SWEEP_PORT: {
      isEnabled: () => true,
      allowsUnattributedReap: () => true,
      sweepCursorAgentTrees,
    },
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
      reconfirmAttribution: expect.any(Function),
      // Nothing recorded here, so the sweep is asked for exactly what it did
      // before records existed: the command-line path this operator switch
      // admits.
      attributedProcesses: [],
      requireAttributionProof: false,
      allowUnattributedReap: true,
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
      reconfirmAttribution: expect.any(Function),
      // Nothing recorded here, so the sweep is asked for exactly what it did
      // before records existed: the command-line path this operator switch
      // admits.
      attributedProcesses: [],
      requireAttributionProof: false,
      allowUnattributedReap: true,
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
      reconfirmAttribution: expect.any(Function),
      // Nothing recorded here, so the sweep is asked for exactly what it did
      // before records existed: the command-line path this operator switch
      // admits.
      attributedProcesses: [],
      requireAttributionProof: false,
      allowUnattributedReap: true,
    });
  });

  it('touches no process and says so when the lead tree sweep port is disabled', async () => {
    writeTeamConfig('disabledteam', { projectPath: 'C:\\workspaces\\example' });
    const disabledSweep = vi.fn();

    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'disabledteam',
      otherAliveTeams: [],
      cursorAgentTreeSweep: {
        isEnabled: () => false,
        allowsUnattributedReap: () => true,
        sweepCursorAgentTrees: disabledSweep,
      },
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
 * The stop decides on it. What it may hand to the sweep is what the host's lease
 * set allows: every owner of the recorded host has to be this team or a team
 * that is no longer running, because one serve host spawns agents for several
 * teams and stopping one of them says nothing about the rest.
 */
describe('the positive attribution records the runtime writes', () => {
  /** An owner carrying both spellings of the team, agreeing with itself. */
  function owner(teamName: string | null): CursorAgentAttributionOwner {
    return {
      teamId: teamName,
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
    owners: readonly CursorAgentAttributionOwner[] = [],
    overrides: Partial<AttributedCursorAgentProcess['record']> = {}
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
        ...overrides,
      },
      host: {
        schemaVersion: 1,
        attributionId: overrides.attributionId ?? 'aaaa1111aaaa1111aaaa1111aaaa1111',
        hostPid: 999,
        hostStartedAtNative: null,
        hostStartTimeFormat: null,
        projectPath: overrides.workspacePath ?? 'C:\\workspaces\\example',
        appInstanceId: '9100-1699999999000',
        appProfileScope: overrides.appProfileScope ?? 'this-install',
        runtimeVersion: '0.0.95',
        owners,
        updatedAt: null,
      },
      owners,
    };
  }

  /**
   * The owner exactly as the RUNTIME writes it: one team field per lease entry,
   * named `teamId`, which this app fills with the team NAME it launched under.
   * `teamName` is a second spelling no writer produces today, so a rule that
   * reads only that field drops every record the paired runtime writes.
   */
  function runtimeOwner(teamId: string): CursorAgentAttributionOwner {
    return {
      teamId,
      teamName: null,
      laneId: 'primary',
      memberName: 'lead',
      runId: 'run-1',
      sessionId: 'session-1',
      createdAt: '2026-09-10T10:00:00.000Z',
      updatedAt: '2026-09-10T10:05:00.000Z',
    };
  }

  const recordOnlyPort = {
    isEnabled: () => true,
    allowsUnattributedReap: () => false,
    sweepCursorAgentTrees,
  };

  it.each([
    'missing',
    'invalid JSON',
    'unsupported schema',
    'mismatched id',
    'foreign profile',
    'other live owner',
    'released',
  ])('checks real reader lease evidence through stop selection: %s', async (scenario) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-reap-attribution-'));
    const workspace = path.join(directory, 'workspace');
    const fixture = attributedProcess(4321, [runtimeOwner('team-b')], {
      workspacePath: workspace,
      cwd: workspace,
    });
    const workspaceRead = vi
      .spyOn(teamProjectWorkspaces, 'readTeamProjectWorkspace')
      .mockImplementation((_basePath, teamName) =>
        Promise.resolve(teamName === 'team-a' ? workspace : null)
      );
    try {
      const { readAttributedCursorAgentProcesses } = await vi.importActual<
        typeof import('@main/services/team/opencode/bridge/CursorAgentAttributionRecords')
      >('@main/services/team/opencode/bridge/CursorAgentAttributionRecords');
      const agentDirectory = path.join(directory, 'v1', 'agents', fixture.record.attributionId);
      const hostDirectory = path.join(directory, 'v1', 'hosts');
      fs.mkdirSync(agentDirectory, { recursive: true });
      fs.mkdirSync(hostDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(agentDirectory, '4321-1700000000000.json'),
        JSON.stringify(fixture.record)
      );
      const host = {
        ...fixture.host,
        ...(scenario === 'unsupported schema' ? { schemaVersion: 7 } : {}),
        ...(scenario === 'mismatched id' ? { attributionId: 'another-host' } : {}),
        ...(scenario === 'foreign profile' ? { appProfileScope: 'another-install' } : {}),
        ...(scenario === 'released' ? { owners: [] } : {}),
      };
      if (scenario !== 'missing') {
        fs.writeFileSync(
          path.join(hostDirectory, `${fixture.record.attributionId}.json`),
          scenario === 'invalid JSON' ? '{' : JSON.stringify(host)
        );
      }

      const result = await reapCursorAgentLeadTreesForStoppedTeam({
        teamName: 'team-a',
        otherAliveTeams: ['team-b'],
        requestedAtMs: 1_700_000_001_000,
        cursorAgentTreeSweep: recordOnlyPort,
        cursorAgentAttribution: {
          readAttributedProcesses: () =>
            readAttributedCursorAgentProcesses({ directory, appProfileScope: 'this-install' }),
        },
      });

      expect(workspaceRead).toHaveBeenCalledWith(teamsBasePath, 'team-b');
      expect(readAttributedProcesses).not.toHaveBeenCalled();
      expect(result.killedPids).toEqual([]);
      if (scenario === 'released') {
        expect(sweepCursorAgentTrees).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            ownedWorkspaceCwds: [workspace],
            startedBeforeMs: 1_700_000_001_000,
            attributedProcesses: [fixture.record],
            requireAttributionProof: true,
            allowUnattributedReap: false,
          })
        );
      } else {
        expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
        expect(result.diagnostics[0]).toBe(
          'cursor-agent attribution: 1 runtime process record(s) available, 0 this stop may reap'
        );
      }
    } finally {
      workspaceRead.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('hands the sweep the records this team may reap, and demands their proof', async () => {
    writeTeamConfig('attributedteam', { projectPath: 'C:\\workspaces\\example' });
    writeTeamConfig('attributedalive', { projectPath: 'C:\\workspaces\\other' });
    const mine = attributedProcess(4321, [owner('attributedteam')]);
    readAttributedProcesses.mockResolvedValueOnce([
      mine,
      // Its host still holds a lease for a team that is running right now.
      attributedProcess(4322, [owner('attributedteam'), owner('attributedalive')]),
      // An owner this app cannot even name is a lease it cannot clear.
      attributedProcess(4323, [owner(null)]),
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
      otherAliveTeams: ['attributedalive'],
      requestedAtMs: 1_700_000_000_000,
      cursorAgentTreeSweep: recordOnlyPort,
    });

    expect(sweepCursorAgentTrees).toHaveBeenCalledExactlyOnceWith({
      ownedWorkspaceCwds: ['C:\\workspaces\\example'],
      startedBeforeMs: 1_700_000_000_000,
      requiredEnvMarkers: ['CLAUDE_TEAM_APP_INSTANCE_ID='],
      requireOwnershipProof: false,
      orphanedOnly: false,
      attributedProcesses: [mine.record],
      reconfirmAttribution: expect.any(Function),
      requireAttributionProof: true,
      // The operator never turned the command-line path on, and a record does
      // not need them to.
      allowUnattributedReap: false,
    });
    expect(result.killedPids).toEqual([4321]);
    expect(result.diagnostics).toEqual([
      'cursor-agent attribution: 3 runtime process record(s) available, 1 this stop may reap',
      'Reaped 1 cursor-agent process tree(s)',
    ]);
  });

  /**
   * The same rule against the shape the paired runtime actually writes: the
   * lease entry carries `teamId` and nothing else, and the value in it is the
   * team name. A rule that reads only `teamName` withholds every record on disk
   * and leaves this whole path inert against its own runtime.
   */
  it('accepts an owner that names this team only through the field the runtime writes', async () => {
    writeTeamConfig('runtimeteam', { projectPath: 'C:\\workspaces\\example' });
    const mine = attributedProcess(4321, [runtimeOwner('runtimeteam')]);
    readAttributedProcesses.mockResolvedValueOnce([mine]);
    sweepCursorAgentTrees.mockResolvedValueOnce({
      scanned: 1,
      killed: [4321],
      keptRecent: [],
      incomplete: false,
      diagnostics: [],
    });

    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'runtimeteam',
      otherAliveTeams: [],
      requestedAtMs: 1_700_000_000_000,
      cursorAgentTreeSweep: recordOnlyPort,
    });

    expect(sweepCursorAgentTrees).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        attributedProcesses: [mine.record],
        requireAttributionProof: true,
        allowUnattributedReap: false,
      })
    );
    expect(result.killedPids).toEqual([4321]);
    expect(result.diagnostics[0]).toBe(
      'cursor-agent attribution: 1 runtime process record(s) available, 1 this stop may reap'
    );
  });

  /** And the veto reads the same field: a live other team named there is a veto. */
  it('withholds a runtime-written owner that names a team still running', async () => {
    writeTeamConfig('runtimestopped', { projectPath: 'C:\\workspaces\\example' });
    writeTeamConfig('runtimealive', { projectPath: 'C:\\workspaces\\other' });
    readAttributedProcesses.mockResolvedValueOnce([
      attributedProcess(4321, [runtimeOwner('runtimestopped'), runtimeOwner('runtimealive')]),
    ]);

    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'runtimestopped',
      otherAliveTeams: ['runtimealive'],
      requestedAtMs: 1_700_000_000_000,
      cursorAgentTreeSweep: recordOnlyPort,
    });

    expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
    expect(result.diagnostics[0]).toBe(
      'cursor-agent attribution: 1 runtime process record(s) available, 0 this stop may reap'
    );
  });

  /**
   * "No other LIVE owner" is not "mine". A host whose only lease belongs to a
   * team that stopped an hour ago passes that test and names nothing this stop
   * owns, so the record it carries is not this team's to hand to a sweep - and a
   * sweep handed it would reap the other team's lead on this team's fences.
   */
  it('withholds a record whose only owner is another team that is no longer running', async () => {
    writeTeamConfig('unnamedteam', { projectPath: 'C:\\workspaces\\example' });
    readAttributedProcesses.mockResolvedValueOnce([
      attributedProcess(4321, [runtimeOwner('a-team-that-stopped-earlier')]),
    ]);

    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'unnamedteam',
      otherAliveTeams: [],
      requestedAtMs: 1_700_000_000_000,
      cursorAgentTreeSweep: recordOnlyPort,
    });

    expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
    expect(result.killedPids).toEqual([]);
    expect(result.diagnostics).toEqual([
      'cursor-agent attribution: 1 runtime process record(s) available, 0 this stop may reap',
      'Skipped cursor-agent sweep: no runtime record names a tree of this team, and reaping an unattributed tree on its command line alone is off',
    ]);
  });

  /**
   * The documented exception, and the control on the rule above: a record whose
   * validated host explicitly reports no remaining leases travels, because the
   * fences behind this one are what decide it. A missing host is not released.
   */
  it('passes on a record whose host has no owner left', async () => {
    writeTeamConfig('ownerlessteam', { projectPath: 'C:\\workspaces\\example' });
    const orphaned = attributedProcess(4321, []);
    readAttributedProcesses.mockResolvedValueOnce([orphaned]);
    sweepCursorAgentTrees.mockResolvedValueOnce({
      scanned: 1,
      killed: [4321],
      keptRecent: [],
      incomplete: false,
      diagnostics: [],
    });

    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'ownerlessteam',
      otherAliveTeams: ['someoneelse'],
      requestedAtMs: 1_700_000_000_000,
      cursorAgentTreeSweep: recordOnlyPort,
    });

    expect(sweepCursorAgentTrees).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        attributedProcesses: [orphaned.record],
        requireAttributionProof: true,
      })
    );
    expect(result.killedPids).toEqual([4321]);
  });

  /**
   * The gate, both halves in one place. The switch keeps its meaning - reaping a
   * tree NOTHING attributed is opt-in - and stops being the switch for the sweep
   * itself, so a stop with no record in hand reads no process table at all,
   * exactly as it did before records existed.
   */
  it('reads no process table when nothing recorded a tree of this team', async () => {
    writeTeamConfig('unrecordedteam', { projectPath: 'C:\\workspaces\\example' });

    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'unrecordedteam',
      otherAliveTeams: [],
      requestedAtMs: 1_700_000_000_000,
      cursorAgentTreeSweep: recordOnlyPort,
    });

    expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
    expect(result.killedPids).toEqual([]);
    expect(result.diagnostics).toEqual([
      'Skipped cursor-agent sweep: no runtime record names a tree of this team, and reaping an unattributed tree on its command line alone is off',
    ]);
  });

  /**
   * The runtime's own readiness probe. Nothing may reap it, and the sweep can
   * only decline it by name if the record reaches it - so it travels whatever
   * its host's lease set says.
   */
  it('passes a readiness-probe record on so the sweep can decline it by name', async () => {
    writeTeamConfig('probeteam', { projectPath: 'C:\\workspaces\\example' });
    const probe = attributedProcess(4400, [owner('probealive')], { kind: 'readiness-probe' });
    readAttributedProcesses.mockResolvedValueOnce([probe]);

    await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'probeteam',
      otherAliveTeams: ['probealive'],
      requestedAtMs: 1_700_000_000_000,
    });

    expect(sweepCursorAgentTrees).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        attributedProcesses: [probe.record],
        // A probe is not something this stop may reap, so the command-line path
        // is what admits the sweep at all here.
        requireAttributionProof: false,
        allowUnattributedReap: true,
      })
    );
  });

  /**
   * The control: against a runtime that writes no record the stop says exactly
   * what it said before, and reaps on the command line an operator turned on.
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
   * them at all is what an operator deciding anything here needs to know - and
   * reading them changes nothing a disabled port decides.
   */
  it('reports the records even where the sweep itself is switched off', async () => {
    writeTeamConfig('disabledattributedteam', { projectPath: 'C:\\workspaces\\example' });
    readAttributedProcesses.mockResolvedValueOnce([
      attributedProcess(4321, [owner('disabledattributedteam')]),
    ]);

    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'disabledattributedteam',
      otherAliveTeams: [],
      cursorAgentTreeSweep: {
        isEnabled: () => false,
        allowsUnattributedReap: () => true,
        sweepCursorAgentTrees: vi.fn(),
      },
    });

    expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
    expect(result.killedPids).toEqual([]);
    expect(result.diagnostics).toEqual([
      'cursor-agent attribution: 1 runtime process record(s) available, 1 this stop may reap',
      'Skipped cursor-agent sweep: the cursor-agent tree sweep is disabled for this app instance',
    ]);
  });

  /**
   * The counter-example that closed the loop the other way. A live team in
   * `/work/app - backup` makes every command line unreadable, and the stop has
   * declined ever since. A record is not a command line: the workspace in it is
   * the argument the spawned process was handed, so the ambiguity is gone and
   * the tree this team left behind is reachable again.
   */
  it('reaps through a confusable neighbour when a record names this team', async () => {
    writeTeamConfig('recorded-confusable', { projectPath: '/work/app' });
    writeTeamConfig('alive-confusable-record', { projectPath: '/work/app - backup' });
    const mine = attributedProcess(4321, [owner('recorded-confusable')], {
      workspacePath: '/work/app',
      cwd: '/work/app',
    });
    readAttributedProcesses.mockResolvedValueOnce([mine]);
    sweepCursorAgentTrees.mockResolvedValueOnce({
      scanned: 2,
      killed: [4321],
      keptRecent: [],
      incomplete: false,
      diagnostics: [],
    });

    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'recorded-confusable',
      otherAliveTeams: ['alive-confusable-record'],
      requestedAtMs: 1_700_000_000_000,
    });

    expect(sweepCursorAgentTrees).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ownedWorkspaceCwds: ['/work/app'],
        attributedProcesses: [mine.record],
        requireAttributionProof: true,
        // Even where the operator turned the command-line path on. The reason
        // this stop is allowed to run at all is the record, and the neighbour it
        // could otherwise reach is live.
        allowUnattributedReap: false,
      })
    );
    expect(result.killedPids).toEqual([4321]);
    expect(result.diagnostics.join(' ')).toContain(
      'so only a tree the runtime recorded for this team is reaped'
    );
  });

  /**
   * One owner entry, two spellings, two different teams: not "the first one".
   * A writer that disagrees with itself is an owner this app cannot name, and
   * the lease it stands for is not one this stop can clear - even when the
   * spelling read first is this team's own.
   */
  it('withholds an owner whose two spellings name different teams', async () => {
    writeTeamConfig('spelledteam', { projectPath: 'C:\\workspaces\\example' });
    readAttributedProcesses.mockResolvedValueOnce([
      attributedProcess(4321, [{ ...runtimeOwner('some-other-team'), teamName: 'spelledteam' }]),
    ]);

    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'spelledteam',
      otherAliveTeams: [],
      requestedAtMs: 1_700_000_000_000,
      cursorAgentTreeSweep: recordOnlyPort,
    });

    expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
    expect(result.diagnostics[0]).toBe(
      'cursor-agent attribution: 1 runtime process record(s) available, 0 this stop may reap'
    );
  });

  /**
   * The lease set is what the host holds now, and a released lease leaves it.
   * A second name in it is therefore a live claim whether or not the caller's
   * snapshot of running teams has caught up - and the snapshot is exactly what
   * a team that started while this stop was already in flight is missing from.
   */
  it('withholds a host leased by a team the caller does not yet know is running', async () => {
    writeTeamConfig('stoppingteam', { projectPath: 'C:\\workspaces\\example' });
    readAttributedProcesses.mockResolvedValueOnce([
      attributedProcess(4321, [runtimeOwner('stoppingteam'), runtimeOwner('newcomer')]),
    ]);

    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'stoppingteam',
      otherAliveTeams: [],
      requestedAtMs: 1_700_000_000_000,
      cursorAgentTreeSweep: recordOnlyPort,
    });

    expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
    expect(result.killedPids).toEqual([]);
    expect(result.diagnostics[0]).toBe(
      'cursor-agent attribution: 1 runtime process record(s) available, 0 this stop may reap'
    );
  });

  /**
   * And the moment before the signal, the lease set is read again rather than
   * trusted from the selection made before the process table was scanned. A
   * host that gained another team's lease in between, or a record that is gone,
   * answers no; the same record under the same single lease answers yes.
   */
  it('re-reads the lease set for the sweep in the moment before it signals', async () => {
    writeTeamConfig('rereadteam', { projectPath: 'C:\\workspaces\\example' });
    const mine = attributedProcess(4321, [runtimeOwner('rereadteam')]);
    readAttributedProcesses.mockResolvedValueOnce([mine]);
    let reconfirm: ((record: CursorAgentAttributionRecord) => Promise<boolean>) | undefined;
    sweepCursorAgentTrees.mockImplementationOnce((input) => {
      reconfirm = input.reconfirmAttribution;
      return Promise.resolve({
        scanned: 1,
        killed: [],
        keptRecent: [],
        incomplete: false,
        diagnostics: [],
      });
    });

    await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'rereadteam',
      otherAliveTeams: [],
      requestedAtMs: 1_700_000_000_000,
      cursorAgentTreeSweep: recordOnlyPort,
    });
    expect(reconfirm).toBeTypeOf('function');
    expect(readAttributedProcesses).toHaveBeenCalledTimes(1);

    readAttributedProcesses.mockResolvedValueOnce([
      attributedProcess(4321, [runtimeOwner('rereadteam'), runtimeOwner('newcomer')]),
    ]);
    await expect(reconfirm!(mine.record)).resolves.toBe(false);
    readAttributedProcesses.mockResolvedValueOnce([]);
    await expect(reconfirm!(mine.record)).resolves.toBe(false);
    readAttributedProcesses.mockResolvedValueOnce([
      attributedProcess(4321, [runtimeOwner('rereadteam')]),
    ]);
    await expect(reconfirm!(mine.record)).resolves.toBe(true);
    // Each answer came from a fresh read, never from the selection above.
    expect(readAttributedProcesses).toHaveBeenCalledTimes(4);
  });

  /** And the veto stands when the only record belongs to the live neighbour. */
  it('still declines a confusable neighbour whose own record is the one on disk', async () => {
    writeTeamConfig('declined-confusable', { projectPath: '/work/app' });
    writeTeamConfig('alive-confusable-owner', { projectPath: '/work/app - backup' });
    readAttributedProcesses.mockResolvedValueOnce([
      attributedProcess(4321, [owner('alive-confusable-owner')], {
        workspacePath: '/work/app - backup',
        cwd: '/work/app - backup',
      }),
    ]);

    const result = await reapCursorAgentLeadTreesForStoppedTeam({
      teamName: 'declined-confusable',
      otherAliveTeams: ['alive-confusable-owner'],
      requestedAtMs: 1_700_000_000_000,
    });

    expect(sweepCursorAgentTrees).not.toHaveBeenCalled();
    expect(result.killedPids).toEqual([]);
    expect(result.diagnostics.join(' ')).toContain('cannot be told apart');
  });
});
