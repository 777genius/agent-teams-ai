import { describe, expect, it, vi } from 'vitest';

import {
  cleanupCursorAgentProcessTrees,
  DEFAULT_CURSOR_AGENT_TREE_SWEEP_PORT,
  extractCursorAgentWorkspace,
  isCursorAgentRootProcess,
  isSameWorkspacePath,
} from './CursorAgentProcessCleanup';

const diagnostic = vi.hoisted(() => vi.fn());

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    diagnostic,
  }),
}));

const WORKSPACE = 'C:\\workspaces\\example';
const OTHER_WORKSPACE = 'C:\\workspaces\\other';

// Real Windows command lines: a PowerShell wrapper, the node runtime it starts,
// and the tool shells below them. The user profile path is what a cursor-agent
// install actually looks like and is the reason the tree needs a whole reap.
const WRAPPER =
  'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -File "C:\\Users\\u\\AppData\\Local\\cursor-agent\\cursor-agent.ps1" --print --trust --output-format stream-json --workspace C:\\workspaces\\example --model cursor-grok --force';
const NODE_CHILD =
  '"C:\\Users\\u\\AppData\\Local\\cursor-agent\\versions\\1\\node.exe" C:\\Users\\u\\AppData\\Local\\cursor-agent\\versions\\1\\index.js --print --trust --workspace C:\\workspaces\\example --model cursor-grok --force';
const OTHER_WRAPPER =
  'powershell.exe -File "C:\\Users\\u\\AppData\\Local\\cursor-agent\\cursor-agent.ps1" --print --workspace C:\\workspaces\\other --model cursor-grok';

describe('cursor-agent tree root detection', () => {
  it('detects a print lead in both spellings and reads back its workspace', () => {
    expect(isCursorAgentRootProcess({ pid: 1, ppid: 0, command: WRAPPER })).toBe(true);
    expect(isCursorAgentRootProcess({ pid: 2, ppid: 1, command: NODE_CHILD })).toBe(true);
    expect(extractCursorAgentWorkspace(WRAPPER)).toBe(WORKSPACE);
    expect(extractCursorAgentWorkspace('x --workspace "C:\\ws\\a b\\c" --model m')).toBe(
      'C:\\ws\\a b\\c'
    );
  });

  /**
   * The three ways this sweep could reach a process that is not a team lead. It
   * kills whole trees, so each of them would take a user's own work with it.
   */
  it('refuses an interactive cursor-agent, a bare cursor command, and an unrelated process', () => {
    expect(
      isCursorAgentRootProcess({
        pid: 3,
        ppid: 0,
        command: 'cursor-agent --workspace C:\\workspaces\\example --model cursor-grok',
      })
    ).toBe(false);
    expect(
      isCursorAgentRootProcess({ pid: 4, ppid: 0, command: 'cursor.exe --print C:\\workspaces' })
    ).toBe(false);
    expect(
      isCursorAgentRootProcess({ pid: 5, ppid: 0, command: 'opencode.exe serve --port 1' })
    ).toBe(false);
  });

  it('compares two spellings of one workspace exactly, and never an empty one', () => {
    expect(isSameWorkspacePath('c:/workspaces/Example/', WORKSPACE, 'win32')).toBe(true);
    expect(isSameWorkspacePath(WORKSPACE, 'C:\\workspaces\\example-backup', 'win32')).toBe(false);
    expect(isSameWorkspacePath('   ', '', 'win32')).toBe(false);
  });

  /**
   * Case is part of the identity of a POSIX directory, so two teams can work in
   * `/work/Team` and `/work/team` at the same time. Folding them together would
   * make the "another live team works here" guard in the stop path answer for
   * the wrong directory in both directions.
   */
  it('keeps two POSIX directories that differ only by case apart', () => {
    expect(isSameWorkspacePath('/work/Team', '/work/team', 'linux')).toBe(false);
    expect(isSameWorkspacePath('/work/Team/', '/work/Team', 'linux')).toBe(true);
  });

  /**
   * A backslash separates nothing off Windows: it is an ordinary character in a
   * filename, so `/work/a\b` is a directory of its own and not another spelling
   * of `/work/a/b`. Rewriting it into a separator makes the two compare equal,
   * which is a licence to reap the whole lead tree of a workspace nobody owns.
   */
  it('reads a backslash as a POSIX filename character and only as a Windows separator', () => {
    expect(isSameWorkspacePath('/work/a\\b', '/work/a/b', 'linux')).toBe(false);
    expect(isSameWorkspacePath('/work/a\\b', '/work/a\\b', 'linux')).toBe(true);
    expect(isSameWorkspacePath('C:\\workspaces\\example', 'c:/workspaces/example', 'win32')).toBe(
      true
    );
  });
});

describe('the ownership proof', () => {
  /**
   * The proof is the process, never a pid this app wrote down: `--print` says
   * the orchestrator spawned it rather than a user's own terminal, and the
   * `--workspace` says which team it was spawned for. Without a workspace the
   * caller can prove it owns, there is no proof at all, so there is nothing to
   * reap - and the sweep does not even look at the process table, because a
   * sweep with no owner cannot make a decision about a single row of it.
   */
  it('reaps nothing, and reads no process table, when no owned workspace is given', async () => {
    const killTree = vi.fn();
    const listProcessRows = vi.fn(() =>
      Promise.resolve([
        { pid: 10, ppid: 1, command: WRAPPER },
        { pid: 20, ppid: 1, command: OTHER_WRAPPER },
      ])
    );

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [],
      listProcessRows,
      killTree,
    });

    expect(listProcessRows).not.toHaveBeenCalled();
    expect(killTree).not.toHaveBeenCalled();
    // A deliberate skip, not a failure: there was nothing to reap.
    expect(result).toEqual({
      scanned: 0,
      killed: [],
      keptRecent: [],
      incomplete: false,
      diagnostics: [
        'cursor-agent sweep skipped: no owned workspace was given, and a tree is only reaped for a workspace this app owns',
      ],
    });
  });

  it('treats a blank workspace entry as no proof at all', async () => {
    const listProcessRows = vi.fn(() => Promise.resolve([{ pid: 10, ppid: 1, command: WRAPPER }]));

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: ['   ', ''],
      listProcessRows,
      killTree: vi.fn(),
    });

    expect(listProcessRows).not.toHaveBeenCalled();
    expect(result.killed).toEqual([]);
  });

  /**
   * A `cursor-agent --print` with no `--workspace` names no team, so no caller
   * can own it. It survives every sweep.
   */
  it('never reaps a print lead whose command line names no workspace', async () => {
    const killTree = vi.fn();
    const noWorkspace = WRAPPER.replace('--workspace C:\\workspaces\\example ', '');

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE],
      listProcessRows: () => Promise.resolve([{ pid: 40, ppid: 1, command: noWorkspace }]),
      killTree,
    });

    expect(result.killed).toEqual([]);
    expect(killTree).not.toHaveBeenCalled();
  });
});

describe('cleanupCursorAgentProcessTrees', () => {
  it('kills the outermost root of each tree and never a nested one', async () => {
    const killTree = vi.fn();

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE, OTHER_WORKSPACE],
      listProcessRows: () =>
        Promise.resolve([
          { pid: 10, ppid: 1, command: WRAPPER },
          // Also a root by command, but parented by pid 10: reaped with the tree.
          { pid: 11, ppid: 10, command: NODE_CHILD },
          { pid: 12, ppid: 11, command: 'pwsh.exe -File tool-script.ps1' },
          { pid: 20, ppid: 1, command: OTHER_WRAPPER },
        ]),
      killTree,
    });

    expect([...result.killed].sort((a, b) => a - b)).toEqual([10, 20]);
    expect(killTree).toHaveBeenCalledTimes(2);
    expect(killTree).not.toHaveBeenCalledWith(11);
    expect(result.scanned).toBe(4);
  });

  it('reaps only the asked-for workspace and leaves another team lead alone', async () => {
    const killTree = vi.fn();

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [OTHER_WORKSPACE],
      listProcessRows: () =>
        Promise.resolve([
          { pid: 10, ppid: 1, command: WRAPPER },
          { pid: 20, ppid: 1, command: OTHER_WRAPPER },
        ]),
      killTree,
    });

    expect(result.killed).toEqual([20]);
    expect(killTree).toHaveBeenCalledExactlyOnceWith(20);
  });

  it('matches a workspace across separator direction, trailing separator, and case', async () => {
    const killTree = vi.fn();

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: ['c:/workspaces/Example/'],
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: WRAPPER }]),
      killTree,
      platform: 'win32',
    });

    expect(result.killed).toEqual([10]);
  });

  /**
   * The same input off Windows. `/work/Team` and `/work/team` are two
   * directories there, so a stop that owns one must not reap the lead tree
   * standing in the other - the sweep kills the whole tree, and the tree it
   * would take belongs to a team that is still running.
   */
  it('never reaps a POSIX lead whose workspace differs from the owned one only by case', async () => {
    const killTree = vi.fn();
    const posixLead =
      '/home/u/.local/cursor-agent/bin/cursor-agent --print --workspace /work/Team --model cursor-grok';

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: ['/work/team'],
      listProcessRows: () => Promise.resolve([{ pid: 40, ppid: 1, command: posixLead }]),
      killTree,
      platform: 'linux',
    });

    expect(result.killed).toEqual([]);
    expect(killTree).not.toHaveBeenCalled();
  });

  /**
   * The same shape one character further down. `/work/a\b` is a directory whose
   * name contains a backslash, which is legal off Windows, and the owned
   * `/work/a/b` is a different directory entirely. Reading the backslash as a
   * separator here hands this sweep somebody else's tree.
   */
  it('never reaps a POSIX lead whose workspace only becomes the owned one once backslashes are separators', async () => {
    const killTree = vi.fn();
    const posixLead =
      '/home/u/.local/cursor-agent/bin/cursor-agent --print --workspace /work/a\\b --model cursor-grok';

    const posixRows = [{ pid: 41, ppid: 1, command: posixLead }];

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: ['/work/a/b'],
      listProcessRows: () => Promise.resolve(posixRows),
      killTree,
      platform: 'linux',
    });

    expect(result.killed).toEqual([]);
    expect(killTree).not.toHaveBeenCalled();

    // The other half of the same rule: the directory that really is named
    // `a\b` is still reaped for the caller that owns it.
    const owned = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: ['/work/a\\b'],
      listProcessRows: () => Promise.resolve(posixRows),
      killTree,
      platform: 'linux',
    });

    expect(owned.killed).toEqual([41]);
    expect(killTree).toHaveBeenCalledExactlyOnceWith(41);
  });

  /**
   * The workspace comparison is exact, not a prefix: a sibling directory whose
   * name merely starts with the stopped team's path keeps its lead. A prefix
   * match here would make stopping one team kill the neighbouring one.
   */
  it('never treats a longer sibling directory as the same workspace', async () => {
    const killTree = vi.fn();
    const backupLead = WRAPPER.replace(
      '--workspace C:\\workspaces\\example',
      '--workspace C:\\workspaces\\example-backup'
    );

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE],
      listProcessRows: () => Promise.resolve([{ pid: 30, ppid: 1, command: backupLead }]),
      killTree,
    });

    expect(result.killed).toEqual([]);
    expect(killTree).not.toHaveBeenCalled();
  });

  it('reports the reap through the durable diagnostic sink', async () => {
    diagnostic.mockClear();

    await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE],
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: WRAPPER }]),
      killTree: vi.fn(),
      platform: 'win32',
    });

    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
      '[OpenCode] opencode_cursor_agent_trees_reaped count=1 pids=10 workspaces=c:/workspaces/example'
    );
  });

  it('says nothing at all when it killed nothing', async () => {
    diagnostic.mockClear();

    await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE],
      listProcessRows: () => Promise.resolve([]),
      killTree: vi.fn(),
    });

    expect(diagnostic).not.toHaveBeenCalled();
  });
});

describe('startedBeforeMs ownership fence', () => {
  // Regression fixture: the startup sweep ran with no fence shortly after app
  // start and reaped the `cursor-agent --print` tree of the primary lane's own
  // readiness execution proof, which blocked the launch before it reached the
  // bridge at all.
  const APP_STARTED_AT_MS = Date.parse('2026-08-28T12:17:56.000Z');
  const PROBE_TREE_STARTED_AT_MS = Date.parse('2026-08-28T12:18:31.000Z');
  const ORPHAN_TREE_STARTED_AT_MS = Date.parse('2026-08-28T11:52:04.000Z');

  it('keeps a tree this app instance started and still reaps the previous orphan', async () => {
    const killTree = vi.fn();
    const startTimes = new Map([
      [10, PROBE_TREE_STARTED_AT_MS],
      [20, ORPHAN_TREE_STARTED_AT_MS],
    ]);

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE, OTHER_WORKSPACE],
      startedBeforeMs: APP_STARTED_AT_MS,
      listProcessRows: () =>
        Promise.resolve([
          { pid: 10, ppid: 1, command: WRAPPER },
          { pid: 11, ppid: 10, command: NODE_CHILD },
          { pid: 20, ppid: 1, command: OTHER_WRAPPER },
        ]),
      readProcessStartTimeMs: (pid) => Promise.resolve(startTimes.get(pid) ?? null),
      killTree,
    });

    expect(result.killed).toEqual([20]);
    expect(result.keptRecent).toEqual([10]);
    expect(killTree).toHaveBeenCalledExactlyOnceWith(20);
    expect(result.diagnostics).toEqual([
      'Kept cursor-agent tree pid=10: process started after this app instance began',
    ]);
  });

  /**
   * The fail-safe direction: a start time this app cannot read means "unknown",
   * and unknown keeps the process. Reading it as "old enough" would make an
   * unreadable process table into a licence to kill.
   */
  it('keeps a tree whose start time cannot be verified', async () => {
    const killTree = vi.fn();

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE],
      startedBeforeMs: APP_STARTED_AT_MS,
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: WRAPPER }]),
      readProcessStartTimeMs: () => Promise.resolve(null),
      killTree,
    });

    expect(killTree).not.toHaveBeenCalled();
    expect(result.killed).toEqual([]);
    expect(result.keptRecent).toEqual([10]);
    expect(result.diagnostics).toEqual([
      'Kept cursor-agent tree pid=10: process start time could not be verified',
    ]);
  });

  it('reads each start time once per sweep', async () => {
    const readProcessStartTimeMs = vi.fn(() => Promise.resolve(ORPHAN_TREE_STARTED_AT_MS));

    await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE, OTHER_WORKSPACE],
      startedBeforeMs: APP_STARTED_AT_MS,
      listProcessRows: () =>
        Promise.resolve([
          { pid: 10, ppid: 1, command: WRAPPER },
          { pid: 20, ppid: 1, command: OTHER_WRAPPER },
        ]),
      readProcessStartTimeMs,
      killTree: vi.fn(),
    });

    expect(readProcessStartTimeMs).toHaveBeenCalledTimes(2);
  });

  /**
   * The half of the pid-reuse race a pid-based sweep can close. The process
   * table named pid 10 as a lead of the owned workspace; by the time the fence
   * asks for its start time, the pid belongs to a process that started just
   * now. A recycled pid always reads as newer than the fence - it started after
   * it by definition - so the sweep keeps it, and `killTree` is never reached
   * for a pid whose identity moved between the scan and the check.
   */
  it('keeps a pid the process table named but that a newer process now holds', async () => {
    const killTree = vi.fn();

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE],
      startedBeforeMs: APP_STARTED_AT_MS,
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: WRAPPER }]),
      readProcessStartTimeMs: () => Promise.resolve(PROBE_TREE_STARTED_AT_MS),
      killTree,
    });

    expect(killTree).not.toHaveBeenCalled();
    expect(result.keptRecent).toEqual([10]);
  });

  /**
   * The other half is a window, not a check, and this pins how narrow it is:
   * each tree is signalled in the same turn as its own start-time check, so no
   * other candidate's probe - the one thing in this loop that costs real time -
   * ever sits between a check and the signal it authorizes. A sweep that
   * collected every verdict first and killed afterwards would read
   * `check:10, check:20, kill:10, kill:20` and would widen that window by a
   * whole probe per tree.
   */
  it('signals each tree in the same turn as its own start-time check', async () => {
    const events: string[] = [];
    const startTimes = new Map([
      [10, ORPHAN_TREE_STARTED_AT_MS],
      [20, ORPHAN_TREE_STARTED_AT_MS],
    ]);

    await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE, OTHER_WORKSPACE],
      startedBeforeMs: APP_STARTED_AT_MS,
      listProcessRows: () => {
        events.push('scan');
        return Promise.resolve([
          { pid: 10, ppid: 1, command: WRAPPER },
          { pid: 20, ppid: 1, command: OTHER_WRAPPER },
        ]);
      },
      readProcessStartTimeMs: (pid) => {
        events.push(`check:${pid}`);
        return Promise.resolve(startTimes.get(pid) ?? null);
      },
      killTree: (pid) => {
        events.push(`kill:${pid}`);
      },
    });

    expect(events).toEqual(['scan', 'check:10', 'kill:10', 'check:20', 'kill:20']);
  });

  it('never reads start times when no fence is given', async () => {
    const readProcessStartTimeMs = vi.fn(() => Promise.resolve(ORPHAN_TREE_STARTED_AT_MS));

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE],
      startedBeforeMs: null,
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: WRAPPER }]),
      readProcessStartTimeMs,
      killTree: vi.fn(),
    });

    expect(readProcessStartTimeMs).not.toHaveBeenCalled();
    expect(result.killed).toEqual([10]);
  });
});

describe('a sweep that cannot finish still answers', () => {
  it('reports a failed process scan and reaps nothing', async () => {
    const killTree = vi.fn();

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE],
      listProcessRows: () => Promise.reject(new Error('process table unavailable')),
      killTree,
    });

    // A scan that never ran leaves every tree it would have reaped standing,
    // so this sweep did not finish and has to say so.
    expect(result).toEqual({
      scanned: 0,
      killed: [],
      keptRecent: [],
      incomplete: true,
      diagnostics: ['cursor-agent process scan failed: process table unavailable'],
    });
    expect(killTree).not.toHaveBeenCalled();
  });

  it('keeps reaping the remaining trees after one kill throws', async () => {
    const killTree = vi.fn((pid: number) => {
      if (pid === 10) throw new Error('access denied');
    });

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE, OTHER_WORKSPACE],
      listProcessRows: () =>
        Promise.resolve([
          { pid: 10, ppid: 1, command: WRAPPER },
          { pid: 20, ppid: 1, command: OTHER_WRAPPER },
        ]),
      killTree,
    });

    expect(result.killed).toEqual([20]);
    expect(result.diagnostics).toEqual(['cursor-agent tree kill failed pid=10: access denied']);
    expect(killTree).toHaveBeenCalledTimes(2);
    // The sweep carried on, and the tree it could not kill is still holding the
    // workspace: carrying on is not the same as having finished.
    expect(result.incomplete).toBe(true);
  });
});

describe('DEFAULT_CURSOR_AGENT_TREE_SWEEP_PORT', () => {
  it('is enabled, so a caller that hands in no port still reaps', () => {
    expect(DEFAULT_CURSOR_AGENT_TREE_SWEEP_PORT.isEnabled()).toBe(true);
  });
});
