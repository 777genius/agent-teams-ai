import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupCursorAgentProcessTrees,
  commandNamesOwnedWorkspace,
  CURSOR_AGENT_TREE_SWEEP_ENV,
  DEFAULT_CURSOR_AGENT_TREE_SWEEP_PORT,
  isConfusableWorkspacePath,
  isCursorAgentRootProcess,
  isCursorAgentTreeSweepEnabled,
  isSameWorkspacePath,
} from './CursorAgentProcessCleanup';

import type { CursorAgentAttributionRecord } from './CursorAgentAttributionRecords';

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

/** What a reap that reached the whole tree reports back to the sweep. */
const reapedTree = (pid: number) => ({ killed: [pid], incomplete: false, diagnostics: [] });

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
    expect(commandNamesOwnedWorkspace(WRAPPER, WORKSPACE, 'win32')).toBe(true);
    expect(
      commandNamesOwnedWorkspace(
        'x --workspace "C:\\ws\\a b\\c" --model m',
        'C:\\ws\\a b\\c',
        'win32'
      )
    ).toBe(true);
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
    const killTree = vi.fn(reapedTree);
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
      killTree: vi.fn(reapedTree),
    });

    expect(listProcessRows).not.toHaveBeenCalled();
    expect(result.killed).toEqual([]);
  });

  /**
   * A `cursor-agent --print` with no `--workspace` names no team, so no caller
   * can own it. It survives every sweep.
   */
  it('never reaps a print lead whose command line names no workspace', async () => {
    const killTree = vi.fn(reapedTree);
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
    const killTree = vi.fn(reapedTree);

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
    const killTree = vi.fn(reapedTree);

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
    const killTree = vi.fn(reapedTree);

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
    const killTree = vi.fn(reapedTree);
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
    const killTree = vi.fn(reapedTree);
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
    const killTree = vi.fn(reapedTree);
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
      killTree: vi.fn(reapedTree),
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
      killTree: vi.fn(reapedTree),
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
    const killTree = vi.fn(reapedTree);
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
    const killTree = vi.fn(reapedTree);

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
      killTree: vi.fn(reapedTree),
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
    const killTree = vi.fn(reapedTree);

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
        return reapedTree(pid);
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
      killTree: vi.fn(reapedTree),
    });

    expect(readProcessStartTimeMs).not.toHaveBeenCalled();
    expect(result.killed).toEqual([10]);
  });
});

describe('a sweep that cannot finish still answers', () => {
  it('reports a failed process scan and reaps nothing', async () => {
    const killTree = vi.fn(reapedTree);

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
      return reapedTree(pid);
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

/**
 * The sweep ships OFF.
 *
 * Everything it can observe comes from a joined command line, and joining
 * destroys the argument boundaries - a directory named `/work/app --model auto`
 * is indistinguishable from `/work/app` plus a model argument. The stop path
 * declines when it can SEE a conflicting live team, but that is proof of a
 * conflict, not proof of ownership: it cannot see a team whose config is
 * unreadable right then, a team of another copy of this app, or a
 * `cursor-agent --print` the user started themselves.
 *
 * Reaping on "no known conflict" is the wrong shape for killing process trees,
 * so it stays off until a process carries positive attribution to its team.
 */
describe('DEFAULT_CURSOR_AGENT_TREE_SWEEP_PORT', () => {
  const previous = process.env[CURSOR_AGENT_TREE_SWEEP_ENV];
  afterEach(() => {
    if (previous === undefined) delete process.env[CURSOR_AGENT_TREE_SWEEP_ENV];
    else process.env[CURSOR_AGENT_TREE_SWEEP_ENV] = previous;
  });

  it('is disabled unless an operator turns it on', () => {
    delete process.env[CURSOR_AGENT_TREE_SWEEP_ENV];
    expect(DEFAULT_CURSOR_AGENT_TREE_SWEEP_PORT.isEnabled()).toBe(false);
  });

  it('turns on for the spellings of yes, and for nothing else', () => {
    for (const on of ['1', 'true', 'on', 'yes', 'TRUE']) {
      expect(isCursorAgentTreeSweepEnabled({ [CURSOR_AGENT_TREE_SWEEP_ENV]: on })).toBe(true);
    }
    for (const off of ['0', 'false', 'off', 'no', 'maybe', '', '   ']) {
      expect(isCursorAgentTreeSweepEnabled({ [CURSOR_AGENT_TREE_SWEEP_ENV]: off })).toBe(false);
    }
    expect(isCursorAgentTreeSweepEnabled({})).toBe(false);
  });
});

/**
 * A POSIX lead: `ps` joins the argument vector with spaces and re-quotes
 * nothing, so a real project directory arrives as bare text with spaces in it.
 */
const POSIX_SPACED_WORKSPACE = '/Users/u/My Projects/app';
const POSIX_SPACED_WRAPPER =
  '/bin/sh /Users/u/.local/bin/cursor-agent --print --output-format stream-json ' +
  '--workspace /Users/u/My Projects/app --model cursor-grok --force';

describe('a workspace that contains spaces', () => {
  /**
   * A joined argv cannot be split back unambiguously, so an unquoted spaced path
   * followed by more arguments is refused rather than guessed at.
   */
  it('refuses an ambiguous unquoted spaced path', () => {
    // POSIX_SPACED_WRAPPER has arguments after the spaced path, so it is
    // ambiguous and deliberately does not match.
    expect(commandNamesOwnedWorkspace(POSIX_SPACED_WRAPPER, POSIX_SPACED_WORKSPACE, 'darwin')).toBe(
      false
    );
    expect(commandNamesOwnedWorkspace(POSIX_SPACED_WRAPPER, '/Users/u/My', 'darwin')).toBe(false);
    // Quoted, the same path is unambiguous and does match.
    expect(
      commandNamesOwnedWorkspace(
        `cursor-agent --print --workspace "${POSIX_SPACED_WORKSPACE}" --model m`,
        POSIX_SPACED_WORKSPACE,
        'darwin'
      )
    ).toBe(true);
  });

  it('reads it back in either quoting style', () => {
    for (const quote of ['"', "'"]) {
      const command = `cursor-agent --print --workspace ${quote}${POSIX_SPACED_WORKSPACE}${quote} -m x`;
      expect(commandNamesOwnedWorkspace(command, POSIX_SPACED_WORKSPACE, 'darwin')).toBe(true);
    }
  });

  it('reaps a tree whose owned workspace contains spaces when it is unambiguous', async () => {
    const killTree = vi.fn(reapedTree);
    const unambiguous = `/bin/sh cursor-agent --print --workspace ${POSIX_SPACED_WORKSPACE}`;

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [POSIX_SPACED_WORKSPACE],
      platform: 'darwin',
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: unambiguous }]),
      killTree,
    });

    expect(killTree).toHaveBeenCalledExactlyOnceWith(10);
    expect(result.killed).toEqual([10]);
  });

  it('still refuses a sibling directory that merely shares a prefix', async () => {
    const killTree = vi.fn(reapedTree);

    await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: ['/Users/u/My Projects/app-backup'],
      platform: 'darwin',
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: POSIX_SPACED_WRAPPER }]),
      killTree,
    });

    expect(killTree).not.toHaveBeenCalled();
  });
});

describe('ownership fences beyond the command line', () => {
  // Space-free on purpose: this block is about the environment fence, and a
  // spaced path would drag the (deliberately strict) parsing rules into it.
  const PLAIN_WORKSPACE = '/work/app';
  const PLAIN_WRAPPER =
    '/bin/sh /Users/u/.local/bin/cursor-agent --print --workspace /work/app --model m';
  const OWNED_ENV = `CURSOR_X=1 CLAUDE_TEAM_APP_INSTANCE_ID=abc123 ${PLAIN_WRAPPER}`;
  const FOREIGN_ENV = `PATH=/usr/bin ${PLAIN_WRAPPER}`;

  const sweep = (overrides: Record<string, unknown>) =>
    cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [PLAIN_WORKSPACE],
      platform: 'darwin',
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: PLAIN_WRAPPER }]),
      ...overrides,
    } as Parameters<typeof cleanupCursorAgentProcessTrees>[0]);

  it('reaps a tree whose environment carries this app instance marker', async () => {
    const killTree = vi.fn(reapedTree);

    await sweep({
      requiredEnvMarkers: ['CLAUDE_TEAM_APP_INSTANCE_ID='],
      requireOwnershipProof: true,
      readProcessDetails: () => Promise.resolve(OWNED_ENV),
      killTree,
    });

    expect(killTree).toHaveBeenCalledExactlyOnceWith(10);
  });

  /**
   * The case the workspace fence cannot see: a user running `cursor-agent
   * --print` in their own project produces a command line identical in every
   * byte the sweep reads.
   */
  it('keeps a tree that carries no marker of this app', async () => {
    const killTree = vi.fn(reapedTree);

    const result = await sweep({
      requiredEnvMarkers: ['CLAUDE_TEAM_APP_INSTANCE_ID='],
      requireOwnershipProof: true,
      readProcessDetails: () => Promise.resolve(FOREIGN_ENV),
      killTree,
    });

    expect(killTree).not.toHaveBeenCalled();
    expect(result.keptRecent).toEqual([10]);
    expect(result.diagnostics.join(' ')).toContain('carries no marker of this app');
  });

  it('keeps a tree whose environment could not be read at all', async () => {
    const killTree = vi.fn(reapedTree);

    const result = await sweep({
      requiredEnvMarkers: ['CLAUDE_TEAM_APP_INSTANCE_ID='],
      requireOwnershipProof: true,
      readProcessDetails: () => Promise.resolve(null),
      killTree,
    });

    expect(killTree).not.toHaveBeenCalled();
    expect(result.diagnostics.join(' ')).toContain('ownership is unproven');
  });

  /**
   * The stop path. It has already proven more than the environment could add -
   * this team was just stopped, its project path came from this app's own team
   * config, and every live team sharing the directory vetoed the sweep - so an
   * unreadable environment must not leave the proxy port held.
   */
  it('falls back to the command line when ownership proof is not required', async () => {
    const killTree = vi.fn(reapedTree);

    const result = await sweep({
      requiredEnvMarkers: ['CLAUDE_TEAM_APP_INSTANCE_ID='],
      requireOwnershipProof: false,
      readProcessDetails: () => Promise.resolve(null),
      killTree,
    });

    expect(killTree).toHaveBeenCalledExactlyOnceWith(10);
    expect(result.diagnostics.join(' ')).toContain('falling back to the command line');
  });

  /**
   * Windows cannot read another process's environment, so a caller demanding
   * ownership proof cannot get it. The sweep refuses rather than quietly falling
   * back to the command line - see the dedicated describe block below.
   */
  it('refuses ownership proof on macOS, where ps cannot reach an environment', async () => {
    // Verified on macOS 15.6.1: `ps eww`, `ps eww -o command=` and `ps -E` all
    // return the command alone, even for a child of the caller. Without this
    // the sweep kept every candidate one by one with an "environment could not
    // be read" line, which reads like a transient failure instead of a platform
    // that has no such facility.
    const killTree = vi.fn(reapedTree);

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE],
      platform: 'darwin',
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: WRAPPER }]),
      requiredEnvMarkers: ['CLAUDE_TEAM_APP_INSTANCE_ID='],
      requireOwnershipProof: true,
      killTree,
    });

    expect(killTree).not.toHaveBeenCalled();
    expect(result.diagnostics.join(' ')).toContain('cannot be read on macOS');
  });

  it('does not ask for an environment it cannot read on Windows', async () => {
    const readProcessDetails = vi.fn(() => Promise.resolve(null));
    const killTree = vi.fn(reapedTree);

    await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE],
      platform: 'win32',
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: WRAPPER }]),
      requiredEnvMarkers: ['CLAUDE_TEAM_APP_INSTANCE_ID='],
      requireOwnershipProof: false,
      readProcessDetails,
      killTree,
    });

    expect(readProcessDetails).not.toHaveBeenCalled();
    expect(killTree).toHaveBeenCalledExactlyOnceWith(10);
  });
});

describe('the orphan fence a startup sweep runs under', () => {
  /**
   * A second copy of this app with a live team in the same directory. Its lead
   * still has the serve host that spawned it as a parent; a lead left behind by
   * a crashed instance has been reparented to init.
   */
  it('keeps a tree whose launcher is still running', async () => {
    const killTree = vi.fn(reapedTree);

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE],
      platform: 'darwin',
      orphanedOnly: true,
      listProcessRows: () =>
        Promise.resolve([
          { pid: 500, ppid: 1, command: 'opencode serve --port 1' },
          { pid: 10, ppid: 500, command: WRAPPER },
        ]),
      killTree,
    });

    expect(killTree).not.toHaveBeenCalled();
    expect(result.keptRecent).toEqual([10]);
    expect(result.diagnostics.join(' ')).toContain('is still running');
  });

  it('reaps a tree that was reparented to init', async () => {
    const killTree = vi.fn(reapedTree);

    await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE],
      platform: 'darwin',
      orphanedOnly: true,
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: WRAPPER }]),
      killTree,
    });

    expect(killTree).toHaveBeenCalledExactlyOnceWith(10);
  });

  it('reaps a tree whose launcher has already exited', async () => {
    const killTree = vi.fn(reapedTree);

    await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE],
      platform: 'darwin',
      orphanedOnly: true,
      // ppid 777 is not in the table: the launcher is gone.
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 777, command: WRAPPER }]),
      killTree,
    });

    expect(killTree).toHaveBeenCalledExactlyOnceWith(10);
  });

  it('leaves the fence off where the stop path needs it off', async () => {
    const killTree = vi.fn(reapedTree);

    await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE],
      platform: 'darwin',
      orphanedOnly: false,
      listProcessRows: () =>
        Promise.resolve([
          { pid: 500, ppid: 1, command: 'opencode serve --port 1' },
          { pid: 10, ppid: 500, command: WRAPPER },
        ]),
      killTree,
    });

    expect(killTree).toHaveBeenCalledExactlyOnceWith(10);
  });
});

describe('a tree the reap could not fully reach', () => {
  it('does not count a refused reap as a kill', async () => {
    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE],
      platform: 'darwin',
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: WRAPPER }]),
      killTree: () => ({
        killed: [],
        incomplete: true,
        diagnostics: ["tree kill refused: tree of pid 10 contains this app's own process"],
      }),
    });

    expect(result.killed).toEqual([]);
    expect(result.incomplete).toBe(true);
    expect(result.diagnostics.join(' ')).toContain('refused');
  });

  it('reports a partially reaped tree as an unfinished cleanup', async () => {
    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE],
      platform: 'darwin',
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: WRAPPER }]),
      killTree: () => ({
        killed: [10],
        incomplete: true,
        diagnostics: ['tree kill failed pid=11: operation not permitted'],
      }),
    });

    expect(result.killed).toEqual([10]);
    expect(result.incomplete).toBe(true);
    expect(result.diagnostics.join(' ')).toContain('operation not permitted');
  });
});

/**
 * `ps` joins the argument vector with spaces and re-quotes nothing, so an
 * unquoted path with spaces cannot be split back unambiguously. An earlier
 * attempt stopped the capture at the first ` -`, which made two DIFFERENT
 * directories read as the same one.
 */
describe('a workspace value that cannot be parsed unambiguously', () => {
  const SPACED = '/work/My Team';
  const SIBLING = '/work/My Team - backup';

  it('does not let a sibling directory match an owned one', () => {
    const command = `cursor-agent --print --workspace ${SIBLING} --model x`;
    expect(commandNamesOwnedWorkspace(command, SPACED, 'darwin')).toBe(false);
    // Not the sibling either: a spaced path with arguments after it is ambiguous
    // in a joined argv, so it is refused rather than guessed at.
    expect(commandNamesOwnedWorkspace(command, SIBLING, 'darwin')).toBe(false);
    // Unambiguous spellings of the sibling do match.
    expect(
      commandNamesOwnedWorkspace(`cursor-agent --print --workspace ${SIBLING}`, SIBLING, 'darwin')
    ).toBe(true);
    expect(
      commandNamesOwnedWorkspace(
        `cursor-agent --print --workspace "${SIBLING}" --model x`,
        SIBLING,
        'darwin'
      )
    ).toBe(true);
  });

  /**
   * The other direction of the same ambiguity: an owned path that happens to be
   * the first segment of a longer one must not claim it.
   */
  it('does not let a space-free owned path claim a longer spaced one', () => {
    const command = 'cursor-agent --print --workspace /Users/u/My Projects/app --model m';
    expect(commandNamesOwnedWorkspace(command, '/Users/u/My', 'darwin')).toBe(false);
  });

  /**
   * The counter-examples that killed the previous heuristic. Treating ` --` as
   * the next flag reads a directory literally named `... -- backup` as its own
   * parent, and cannot tell it from a real flag following a spaced path.
   */
  it('refuses every spelling that a flag heuristic would have accepted', () => {
    for (const value of ['/work/My Team -- backup', '/work/My Team --model backup']) {
      const command = `cursor-agent --print --workspace ${value}`;
      expect(commandNamesOwnedWorkspace(command, '/work/My Team', 'darwin')).toBe(false);
    }
  });

  /**
   * A spaced owned path is only recognised unquoted when `--workspace` was the
   * last argument. Otherwise the tree is kept - a missed reap, which is the
   * acceptable direction here.
   */
  it('matches a spaced path only when nothing follows it', () => {
    expect(
      commandNamesOwnedWorkspace(
        'cursor-agent --print --workspace /Users/u/My Projects/app',
        '/Users/u/My Projects/app',
        'darwin'
      )
    ).toBe(true);
    expect(
      commandNamesOwnedWorkspace(
        'cursor-agent --print --workspace /Users/u/My Projects/app --model m',
        '/Users/u/My Projects/app',
        'darwin'
      )
    ).toBe(false);
  });

  /** A path without spaces ends at the first space, so following args are fine. */
  it('matches a space-free path regardless of what follows', () => {
    const command = 'cursor-agent --print --workspace /work/app --model m --force';
    expect(commandNamesOwnedWorkspace(command, '/work/app', 'darwin')).toBe(true);
    expect(commandNamesOwnedWorkspace(command, '/work', 'darwin')).toBe(false);
  });

  it('matches a quoted value exactly and nothing else', () => {
    const command = `cursor-agent --print --workspace "${SIBLING}" --model x`;
    expect(commandNamesOwnedWorkspace(command, SIBLING, 'darwin')).toBe(true);
    expect(commandNamesOwnedWorkspace(command, SPACED, 'darwin')).toBe(false);
  });

  it('keeps the sibling tree during a real sweep', async () => {
    const killTree = vi.fn(reapedTree);

    await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [SPACED],
      platform: 'darwin',
      listProcessRows: () =>
        Promise.resolve([
          {
            pid: 10,
            ppid: 1,
            command: `/bin/sh cursor-agent --print --workspace ${SIBLING} --model x`,
          },
        ]),
      killTree,
    });

    expect(killTree).not.toHaveBeenCalled();
  });
});

/**
 * Windows cannot read another process's environment, so a caller that demands
 * ownership proof cannot get it there. Continuing anyway would silently downgrade
 * the sweep to "reap on the command line alone" - the fence the caller was
 * explicitly refusing to rely on.
 */
describe('ownership proof that the platform cannot supply', () => {
  it('reaps nothing on Windows when proof is required', async () => {
    const killTree = vi.fn(reapedTree);
    const listProcessRows = vi.fn(() => Promise.resolve([{ pid: 10, ppid: 1, command: WRAPPER }]));

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE],
      platform: 'win32',
      listProcessRows,
      requiredEnvMarkers: ['CLAUDE_TEAM_APP_INSTANCE_ID='],
      requireOwnershipProof: true,
      killTree,
    });

    expect(killTree).not.toHaveBeenCalled();
    expect(result.diagnostics.join(' ')).toContain('cannot be read on Windows');
  });

  it('still reaps on Windows when proof was never required', async () => {
    const killTree = vi.fn(reapedTree);

    await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE],
      platform: 'win32',
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: WRAPPER }]),
      requiredEnvMarkers: ['CLAUDE_TEAM_APP_INSTANCE_ID='],
      requireOwnershipProof: false,
      killTree,
    });

    expect(killTree).toHaveBeenCalledExactlyOnceWith(10);
  });
});

/**
 * Both counter-examples review reproduced through a real sweep. A joined argv
 * has no argument boundaries left in it, so these are not parser bugs to fix -
 * they are the shape of the ambiguity, and the sweep has to decline.
 */
describe('directory names that a joined command line cannot distinguish', () => {
  it('refuses an owned path whose sibling merely adds " - suffix"', () => {
    const command = 'cursor-agent --print --workspace /work/app - backup --model m';
    // The real workspace is `/work/app - backup`; a stop of `/work/app` must not
    // reach it. A single leading dash is an ordinary directory name.
    expect(commandNamesOwnedWorkspace(command, '/work/app', 'darwin')).toBe(false);
  });

  it('still matches the normal case, where a long flag follows', () => {
    const command = 'cursor-agent --print --workspace /work/app --model m';
    expect(commandNamesOwnedWorkspace(command, '/work/app', 'darwin')).toBe(true);
  });

  /**
   * The residual case the parser cannot settle: a directory literally named
   * `/work/app --model auto` renders identically to `/work/app` plus a model
   * argument. The stop path refuses it on evidence instead - see
   * teamLeadProcessTreeReap's confusable-workspace guard.
   */
  it('names the pair that stays ambiguous', () => {
    expect(isConfusableWorkspacePath('/work/app --model auto', '/work/app', 'darwin')).toBe(true);
    expect(isConfusableWorkspacePath('/work/app - backup', '/work/app', 'darwin')).toBe(true);
    // Symmetric, and never true for equal or unrelated paths.
    expect(isConfusableWorkspacePath('/work/app', '/work/app - backup', 'darwin')).toBe(true);
    expect(isConfusableWorkspacePath('/work/app', '/work/app', 'darwin')).toBe(false);
    expect(isConfusableWorkspacePath('/work/app-backup', '/work/app', 'darwin')).toBe(false);
    expect(isConfusableWorkspacePath('/work/other', '/work/app', 'darwin')).toBe(false);
  });
});

/**
 * The fourth proof, and the first one that is evidence rather than a reading.
 *
 * A record is written by the spawned `cursor-agent` itself, before its entry
 * module loads, so it carries the pid, the start time and the `--workspace`
 * argument as the process received them. None of the three survives the join a
 * process table performs, and the two platforms this app runs on where no
 * environment can be read at all - Windows and macOS - have had no ownership
 * proof of any kind until now.
 *
 * It is identity and never liveness: a record outlives a `SIGKILL`, so every
 * case below is decided against the LIVE process, and a pid whose start time has
 * moved is a different process wearing the same number.
 */
describe('the runtime records that prove a root', () => {
  const AGENT_STARTED_AT_MS = Date.parse('2026-09-10T09:00:00.000Z');
  const SWEEP_FENCE_MS = Date.parse('2026-09-10T09:30:00.000Z');

  const POSIX_WORKSPACE = '/work/app';
  const POSIX_WRAPPER =
    '/bin/sh /Users/u/.local/bin/cursor-agent --print --workspace /work/app --model m';
  const FOREIGN_ENV = `PATH=/usr/bin ${POSIX_WRAPPER}`;
  /** The directory whose spelling defeated three parsers, as a real command line. */
  const SPACED_WORKSPACE = '/work/app - backup';
  const SPACED_WRAPPER =
    '/bin/sh /Users/u/.local/bin/cursor-agent --print --workspace /work/app - backup --model m';

  function record(
    overrides: Partial<CursorAgentAttributionRecord> = {}
  ): CursorAgentAttributionRecord {
    return {
      schemaVersion: 1,
      kind: 'cursor-agent',
      attributionId: 'aaaa1111aaaa1111aaaa1111aaaa1111',
      pid: 10,
      parentPid: 9,
      startedAtMs: AGENT_STARTED_AT_MS,
      startTimeToleranceMs: 2000,
      nativeStartToken: null,
      workspacePath: POSIX_WORKSPACE,
      cwd: POSIX_WORKSPACE,
      appInstanceId: '9100-1757000000000',
      appProfileScope: 'this-install',
      hostPid: 999,
      runtimeVersion: '0.0.95',
      writtenAtMs: AGENT_STARTED_AT_MS + 80,
      exitedAtMs: null,
      ...overrides,
    };
  }

  const startTimes = (entries: readonly [number, number][]) => {
    const table = new Map(entries);
    return (pid: number) => Promise.resolve(table.get(pid) ?? null);
  };

  /**
   * Windows, where the generated shim is a `cmd.exe` / PowerShell hop that stays
   * alive as the parent: the record is written by the node process below it and
   * names the root as its parent. Nothing here reads an environment, because
   * Windows exposes none - this is the case the sweep has never been able to
   * decide.
   */
  it('reaps a Windows tree through the shim hop, with no environment to read', async () => {
    const killTree = vi.fn(reapedTree);
    const readProcessDetails = vi.fn(() => Promise.resolve(null));

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE],
      platform: 'win32',
      listProcessRows: () =>
        Promise.resolve([
          { pid: 10, ppid: 1, command: WRAPPER },
          { pid: 11, ppid: 10, command: NODE_CHILD },
        ]),
      startedBeforeMs: SWEEP_FENCE_MS,
      requiredEnvMarkers: ['CLAUDE_TEAM_APP_INSTANCE_ID='],
      requireOwnershipProof: true,
      orphanedOnly: true,
      attributedProcesses: [record({ pid: 11, parentPid: 10, workspacePath: WORKSPACE })],
      requireAttributionProof: true,
      allowUnattributedReap: false,
      readProcessStartTimeMs: startTimes([
        [11, AGENT_STARTED_AT_MS],
        [10, AGENT_STARTED_AT_MS - 500],
      ]),
      readProcessDetails,
      killTree,
    });

    expect(killTree).toHaveBeenCalledExactlyOnceWith(10);
    expect(result.killed).toEqual([10]);
    expect(readProcessDetails).not.toHaveBeenCalled();
  });

  /** macOS, where the shim `exec`s: the recorded pid IS the root. */
  it('reaps a macOS tree whose recorded pid is the root itself', async () => {
    const killTree = vi.fn(reapedTree);

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [POSIX_WORKSPACE],
      platform: 'darwin',
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: POSIX_WRAPPER }]),
      startedBeforeMs: SWEEP_FENCE_MS,
      requiredEnvMarkers: ['CLAUDE_TEAM_APP_INSTANCE_ID='],
      requireOwnershipProof: true,
      attributedProcesses: [record()],
      requireAttributionProof: true,
      allowUnattributedReap: false,
      // `ps -o lstart=` answers in whole seconds, so a record written at a
      // fraction past the second reads back up to a second earlier here.
      readProcessStartTimeMs: startTimes([[10, AGENT_STARTED_AT_MS - 999]]),
      killTree,
    });

    expect(killTree).toHaveBeenCalledExactlyOnceWith(10);
    expect(result.killed).toEqual([10]);
  });

  /**
   * A marker this app could read and that says nothing about this tree. The
   * record already answered the question the marker exists for, so the
   * environment is not asked for at all.
   */
  it('does not ask for an environment a record has already answered for', async () => {
    const killTree = vi.fn(reapedTree);
    const readProcessDetails = vi.fn(() => Promise.resolve(FOREIGN_ENV));

    await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [POSIX_WORKSPACE],
      platform: 'linux',
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: POSIX_WRAPPER }]),
      requiredEnvMarkers: ['CLAUDE_TEAM_APP_INSTANCE_ID='],
      requireOwnershipProof: true,
      attributedProcesses: [record()],
      requireAttributionProof: true,
      allowUnattributedReap: false,
      readProcessStartTimeMs: startTimes([[10, AGENT_STARTED_AT_MS]]),
      readProcessDetails,
      killTree,
    });

    expect(readProcessDetails).not.toHaveBeenCalled();
    expect(killTree).toHaveBeenCalledExactlyOnceWith(10);
  });

  /**
   * The directory name that beat every parser: `--workspace /work/app - backup`
   * and `--workspace /work/app` followed by arguments are the same string. The
   * record does not contain a string to parse - it contains the argument.
   */
  it('reaps the spaced workspace no parse of a joined command line can resolve', async () => {
    const killTree = vi.fn(reapedTree);

    await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [SPACED_WORKSPACE],
      platform: 'darwin',
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: SPACED_WRAPPER }]),
      attributedProcesses: [record({ workspacePath: SPACED_WORKSPACE, cwd: SPACED_WORKSPACE })],
      requireAttributionProof: true,
      allowUnattributedReap: false,
      readProcessStartTimeMs: startTimes([[10, AGENT_STARTED_AT_MS]]),
      killTree,
    });

    // The command line alone never matched this tree, which is why it was left
    // standing before the record existed.
    expect(commandNamesOwnedWorkspace(SPACED_WRAPPER, SPACED_WORKSPACE, 'darwin')).toBe(false);
    expect(killTree).toHaveBeenCalledExactlyOnceWith(10);
  });

  /** And the neighbour it was confusable with is still not this caller's. */
  it('never reaches the neighbour whose record names the other directory', async () => {
    const killTree = vi.fn(reapedTree);

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [POSIX_WORKSPACE],
      platform: 'darwin',
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: SPACED_WRAPPER }]),
      attributedProcesses: [record({ workspacePath: SPACED_WORKSPACE, cwd: SPACED_WORKSPACE })],
      requireAttributionProof: true,
      allowUnattributedReap: false,
      readProcessStartTimeMs: startTimes([[10, AGENT_STARTED_AT_MS]]),
      killTree,
    });

    expect(killTree).not.toHaveBeenCalled();
    // Not even a candidate: the command line does not name this caller's
    // workspace either, so the record is the only thing that could have reached
    // this tree and it names somewhere else.
    expect(result.keptRecent).toEqual([]);
  });

  /**
   * The recycling case the start-time fence could only half close. The table
   * named pid 10 as a lead; the record says what pid 10 was when the runtime
   * spawned it, and the live process disagrees by half a minute.
   */
  it('keeps a pid whose live start time is not the one the record was written for', async () => {
    const killTree = vi.fn(reapedTree);

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [POSIX_WORKSPACE],
      platform: 'darwin',
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: POSIX_WRAPPER }]),
      startedBeforeMs: SWEEP_FENCE_MS,
      attributedProcesses: [record()],
      requireAttributionProof: true,
      allowUnattributedReap: false,
      readProcessStartTimeMs: startTimes([[10, AGENT_STARTED_AT_MS + 30_000]]),
      killTree,
    });

    expect(killTree).not.toHaveBeenCalled();
    expect(result.keptRecent).toEqual([10]);
    expect(result.diagnostics.join(' ')).toContain('no runtime record names it');
  });

  /**
   * And the record does not get to widen the fence that polices it. The
   * tolerance travels inside the file, so a value read straight out of it is a
   * file deciding how carefully it is checked: a thousand years of slack turns
   * the comparison into "any process now holding this pid". The clamp is what
   * keeps the half-minute difference above a refusal.
   */
  it('keeps a pid whose record declares a tolerance wide enough to swallow the difference', async () => {
    const killTree = vi.fn(reapedTree);

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [POSIX_WORKSPACE],
      platform: 'darwin',
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: POSIX_WRAPPER }]),
      startedBeforeMs: SWEEP_FENCE_MS,
      attributedProcesses: [record({ startTimeToleranceMs: 1e15 })],
      requireAttributionProof: true,
      allowUnattributedReap: false,
      readProcessStartTimeMs: startTimes([[10, AGENT_STARTED_AT_MS + 30_000]]),
      killTree,
    });

    expect(killTree).not.toHaveBeenCalled();
    expect(result.keptRecent).toEqual([10]);
    expect(result.diagnostics.join(' ')).toContain('no runtime record names it');
  });

  /**
   * The control on that clamp: it is a ceiling, not a replacement. A runtime
   * that asks for more slack than the floor - a slow clock, a coarse platform
   * reader - is still believed up to the bound, so a difference this record
   * declares itself tolerant of is a reap.
   */
  it('still honours a tolerance the record declares inside the bound', async () => {
    const killTree = vi.fn(reapedTree);

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [POSIX_WORKSPACE],
      platform: 'darwin',
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: POSIX_WRAPPER }]),
      startedBeforeMs: SWEEP_FENCE_MS,
      attributedProcesses: [record({ startTimeToleranceMs: 8_000 })],
      requireAttributionProof: true,
      allowUnattributedReap: false,
      readProcessStartTimeMs: startTimes([[10, AGENT_STARTED_AT_MS - 5_000]]),
      killTree,
    });

    expect(killTree).toHaveBeenCalledExactlyOnceWith(10);
    expect(result.killed).toEqual([10]);
  });

  /**
   * A record whose own writer recorded an exit. The unlink at exit failed, so
   * the file outlived the process it describes, and the pid in it belongs to
   * whoever holds it now - the writer saying so is the strongest statement in
   * the record, and it is read before anything else in it.
   */
  it('keeps a tree whose record says the process it names has already exited', async () => {
    const killTree = vi.fn(reapedTree);

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [POSIX_WORKSPACE],
      platform: 'darwin',
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: POSIX_WRAPPER }]),
      startedBeforeMs: SWEEP_FENCE_MS,
      attributedProcesses: [record({ exitedAtMs: AGENT_STARTED_AT_MS + 60_000 })],
      requireAttributionProof: true,
      allowUnattributedReap: false,
      // The live start time still matches to the millisecond: nothing but the
      // recorded exit stands between this row and a reap.
      readProcessStartTimeMs: startTimes([[10, AGENT_STARTED_AT_MS]]),
      killTree,
    });

    expect(killTree).not.toHaveBeenCalled();
    expect(result.keptRecent).toEqual([10]);
    expect(result.diagnostics.join(' ')).toContain('no runtime record names it');
  });

  /** And the control: the same tree, the same record, no recorded exit. */
  it('reaps that very tree when its record carries no exit', async () => {
    const killTree = vi.fn(reapedTree);

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [POSIX_WORKSPACE],
      platform: 'darwin',
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: POSIX_WRAPPER }]),
      startedBeforeMs: SWEEP_FENCE_MS,
      attributedProcesses: [record({ exitedAtMs: null })],
      requireAttributionProof: true,
      allowUnattributedReap: false,
      readProcessStartTimeMs: startTimes([[10, AGENT_STARTED_AT_MS]]),
      killTree,
    });

    expect(killTree).toHaveBeenCalledExactlyOnceWith(10);
    expect(result.killed).toEqual([10]);
  });

  /** A parent cannot be younger than the child that recorded it as its parent. */
  it('refuses a shim hop whose root started after the process that named it', async () => {
    const killTree = vi.fn(reapedTree);

    await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE],
      platform: 'win32',
      listProcessRows: () =>
        Promise.resolve([
          { pid: 10, ppid: 1, command: WRAPPER },
          { pid: 11, ppid: 10, command: NODE_CHILD },
        ]),
      attributedProcesses: [record({ pid: 11, parentPid: 10, workspacePath: WORKSPACE })],
      requireAttributionProof: true,
      allowUnattributedReap: false,
      readProcessStartTimeMs: startTimes([
        [11, AGENT_STARTED_AT_MS],
        [10, AGENT_STARTED_AT_MS + 60_000],
      ]),
      killTree,
    });

    expect(killTree).not.toHaveBeenCalled();
  });

  /** And the hop has to be one this very snapshot shows. */
  it('refuses a hop the process table does not stand behind', async () => {
    const killTree = vi.fn(reapedTree);

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE],
      platform: 'win32',
      listProcessRows: () =>
        Promise.resolve([
          { pid: 10, ppid: 1, command: WRAPPER },
          // The recorded pid is alive and is not this root's child, which is
          // what a pid recycled since the record was written looks like.
          { pid: 11, ppid: 777, command: 'node C:\\tools\\watcher.js' },
        ]),
      attributedProcesses: [record({ pid: 11, parentPid: 10, workspacePath: WORKSPACE })],
      requireAttributionProof: true,
      allowUnattributedReap: false,
      readProcessStartTimeMs: startTimes([
        [11, AGENT_STARTED_AT_MS],
        [10, AGENT_STARTED_AT_MS - 500],
      ]),
      killTree,
    });

    expect(killTree).not.toHaveBeenCalled();
    expect(result.keptRecent).toEqual([10]);
  });

  /**
   * The one `cursor-agent` the runtime spawns for itself. The sweep has always
   * documented it as a tree it must never reap; the record turns that comment
   * into a decline this loop can state, on the process rather than on a clock.
   */
  it('declines the tree the runtime records as its own readiness probe', async () => {
    const killTree = vi.fn(reapedTree);

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [POSIX_WORKSPACE],
      platform: 'darwin',
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: POSIX_WRAPPER }]),
      attributedProcesses: [record({ kind: 'readiness-probe' })],
      requireAttributionProof: true,
      allowUnattributedReap: false,
      readProcessStartTimeMs: startTimes([[10, AGENT_STARTED_AT_MS]]),
      killTree,
    });

    expect(killTree).not.toHaveBeenCalled();
    expect(result.keptRecent).toEqual([10]);
    expect(result.diagnostics.join(' ')).toContain('its own readiness probe');
  });

  /**
   * A corrupt file, a half-written one, a schema version this app does not know:
   * the reader answers with nothing for each of them, and nothing is what this
   * sweep then has. It must degrade to keeping the tree, never to reaping it on
   * the command line the record replaced.
   */
  it('keeps a tree whose record could not be read at all', async () => {
    const killTree = vi.fn(reapedTree);

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [POSIX_WORKSPACE],
      platform: 'darwin',
      listProcessRows: () => Promise.resolve([{ pid: 10, ppid: 1, command: POSIX_WRAPPER }]),
      attributedProcesses: [],
      requireAttributionProof: true,
      allowUnattributedReap: false,
      readProcessStartTimeMs: startTimes([[10, AGENT_STARTED_AT_MS]]),
      killTree,
    });

    expect(killTree).not.toHaveBeenCalled();
    expect(result.keptRecent).toEqual([10]);
  });

  /**
   * The gate, in the one sweep that shows both halves: the recorded tree is
   * reaped although no operator turned anything on, and the tree beside it -
   * whose command line is just as good a match - is kept because nothing
   * recorded it.
   */
  it('reaps what a record names and keeps what only a command line names', async () => {
    const killTree = vi.fn(reapedTree);

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE, OTHER_WORKSPACE],
      platform: 'win32',
      listProcessRows: () =>
        Promise.resolve([
          { pid: 10, ppid: 1, command: WRAPPER },
          { pid: 20, ppid: 1, command: OTHER_WRAPPER },
        ]),
      startedBeforeMs: SWEEP_FENCE_MS,
      attributedProcesses: [record({ pid: 10, workspacePath: WORKSPACE })],
      requireAttributionProof: true,
      allowUnattributedReap: false,
      readProcessStartTimeMs: startTimes([
        [10, AGENT_STARTED_AT_MS],
        [20, AGENT_STARTED_AT_MS],
      ]),
      killTree,
    });

    expect(killTree).toHaveBeenCalledExactlyOnceWith(10);
    expect(result.keptRecent).toEqual([20]);
    expect(result.diagnostics.join(' ')).toContain('no runtime record names it');
  });

  /**
   * The operator switch does not undo the platform it was set on. With the
   * command-line path turned on and records in hand, a Windows startup still
   * cannot prove the unrecorded tree - the environment it would need does not
   * exist there - so that tree is kept and the recorded one is reaped.
   */
  it('still refuses an unattributed Windows tree where ownership proof is required', async () => {
    const killTree = vi.fn(reapedTree);

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE, OTHER_WORKSPACE],
      platform: 'win32',
      listProcessRows: () =>
        Promise.resolve([
          { pid: 10, ppid: 1, command: WRAPPER },
          { pid: 20, ppid: 1, command: OTHER_WRAPPER },
        ]),
      requiredEnvMarkers: ['CLAUDE_TEAM_APP_INSTANCE_ID='],
      requireOwnershipProof: true,
      attributedProcesses: [record({ pid: 10, workspacePath: WORKSPACE })],
      requireAttributionProof: true,
      allowUnattributedReap: true,
      readProcessStartTimeMs: startTimes([[10, AGENT_STARTED_AT_MS]]),
      killTree,
    });

    expect(killTree).toHaveBeenCalledExactlyOnceWith(10);
    expect(result.keptRecent).toEqual([20]);
    expect(result.diagnostics.join(' ')).toContain('cannot be read on Windows');
  });

  /**
   * And with no record at all the refusal is the one it always was: the sweep
   * does not read the process table, and says why once instead of per tree.
   */
  it('refuses before the process table when nothing was recorded on Windows', async () => {
    const listProcessRows = vi.fn(() => Promise.resolve([{ pid: 10, ppid: 1, command: WRAPPER }]));

    const result = await cleanupCursorAgentProcessTrees({
      ownedWorkspaceCwds: [WORKSPACE],
      platform: 'win32',
      listProcessRows,
      requiredEnvMarkers: ['CLAUDE_TEAM_APP_INSTANCE_ID='],
      requireOwnershipProof: true,
      attributedProcesses: [],
      requireAttributionProof: true,
      killTree: vi.fn(reapedTree),
    });

    expect(listProcessRows).not.toHaveBeenCalled();
    expect(result.diagnostics).toEqual([
      'cursor-agent sweep skipped: ownership proof was required, and a process environment cannot be read on Windows',
    ]);
  });
});
