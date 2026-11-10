import {
  collectExternalProcessTreeIdentities,
  killExternalProcessTree,
} from '@main/utils/externalProcessTreeKill';
import { describe, expect, it, vi } from 'vitest';

import type { UnixProcessIdentity } from '@main/utils/unixProcessTable';

/**
 * The shape this module exists for: a `cursor-agent` lead is a shell wrapper
 * that starts a node runtime that starts tool shells. A signal to the wrapper
 * alone reaches the wrapper alone, and the inherited socket handle keeping the
 * proxy port in LISTEN lives in the children.
 */
function tree(...entries: [pid: number, parentPid: number][]): Map<number, UnixProcessIdentity> {
  return new Map(
    entries.map(([pid, parentPid]) => [
      pid,
      { pid, parentPid, processGroupId: entries[0][0], startIdentity: `birth:${pid}` },
    ])
  );
}

const WRAPPER = 100;
const NODE_RUNTIME = 200;
const TOOL_SHELL = 300;
const SIBLING_TOOL = 301;
const APP_PID = 999;

describe('collecting a process tree by pid', () => {
  it('orders every descendant before the root that would orphan them', () => {
    const collected = collectExternalProcessTreeIdentities(
      tree([WRAPPER, 1], [NODE_RUNTIME, WRAPPER], [TOOL_SHELL, NODE_RUNTIME]),
      WRAPPER,
      APP_PID
    );

    expect(collected).toEqual({
      identities: [
        expect.objectContaining({ pid: TOOL_SHELL }),
        expect.objectContaining({ pid: NODE_RUNTIME }),
        expect.objectContaining({ pid: WRAPPER }),
      ],
    });
  });

  it('leaves unrelated processes out of the tree', () => {
    const collected = collectExternalProcessTreeIdentities(
      tree([WRAPPER, 1], [NODE_RUNTIME, WRAPPER], [500, 1], [501, 500]),
      WRAPPER,
      APP_PID
    );

    expect('identities' in collected && collected.identities.map((entry) => entry.pid)).toEqual([
      NODE_RUNTIME,
      WRAPPER,
    ]);
  });

  it('answers an empty tree for a root that is already gone', () => {
    expect(collectExternalProcessTreeIdentities(tree([NODE_RUNTIME, 1]), WRAPPER, APP_PID)).toEqual({
      identities: [],
    });
  });

  /**
   * The refusal that keeps the app alive. A tree containing this process means
   * the root is an ancestor of it - a terminal that launched both - and reaping
   * that root takes the app down with the lead it was aiming at.
   */
  it('refuses a tree that contains this app', () => {
    const collected = collectExternalProcessTreeIdentities(
      tree([WRAPPER, 1], [NODE_RUNTIME, WRAPPER], [APP_PID, NODE_RUNTIME]),
      WRAPPER,
      APP_PID
    );

    expect(collected).toEqual({
      refusal: expect.stringContaining("contains this app's own process"),
    });
  });

  it('refuses when the root IS this app', () => {
    expect(collectExternalProcessTreeIdentities(tree([APP_PID, 1]), APP_PID, APP_PID)).toEqual({
      refusal: expect.stringContaining("this app's own process"),
    });
  });
});

describe('reaping an external process tree', () => {
  it('signals children before their parent', () => {
    const signalled: number[] = [];

    const result = killExternalProcessTree(WRAPPER, {
      platform: 'darwin',
      selfPid: APP_PID,
      readProcessTable: () =>
        tree(
          [WRAPPER, 1],
          [NODE_RUNTIME, WRAPPER],
          [TOOL_SHELL, NODE_RUNTIME],
          [SIBLING_TOOL, NODE_RUNTIME]
        ),
      killPid: (pid) => void signalled.push(pid),
    });

    expect(signalled.indexOf(TOOL_SHELL)).toBeLessThan(signalled.indexOf(NODE_RUNTIME));
    expect(signalled.indexOf(SIBLING_TOOL)).toBeLessThan(signalled.indexOf(NODE_RUNTIME));
    expect(signalled.indexOf(NODE_RUNTIME)).toBeLessThan(signalled.indexOf(WRAPPER));
    expect(result.incomplete).toBe(false);
    expect(result.killed).toHaveLength(4);
  });

  /**
   * The whole reason this module replaced `killProcessByPid` on POSIX: the old
   * call reached one pid, so the descendants holding the inherited port handle
   * survived a sweep that reported success.
   */
  it('reaches the descendants, not only the root', () => {
    const killPid = vi.fn();

    killExternalProcessTree(WRAPPER, {
      platform: 'linux',
      selfPid: APP_PID,
      readProcessTable: () => tree([WRAPPER, 1], [NODE_RUNTIME, WRAPPER], [TOOL_SHELL, NODE_RUNTIME]),
      killPid,
    });

    expect(killPid.mock.calls.map(([pid]) => pid)).toEqual(
      expect.arrayContaining([WRAPPER, NODE_RUNTIME, TOOL_SHELL])
    );
  });

  it('hands the root to taskkill on Windows and does not walk', () => {
    const killPid = vi.fn();
    const readProcessTable = vi.fn();

    const result = killExternalProcessTree(WRAPPER, {
      platform: 'win32',
      killPid,
      readProcessTable,
    });

    expect(killPid).toHaveBeenCalledExactlyOnceWith(WRAPPER, undefined);
    expect(readProcessTable).not.toHaveBeenCalled();
    expect(result).toEqual({ killed: [WRAPPER], incomplete: false, diagnostics: [] });
  });

  /**
   * An unreadable table is not an empty tree. Falling back to a bare root kill
   * here would be the single-process signal this module exists to replace, and
   * it would report success for a tree still holding its port.
   */
  it('reaps nothing and reports incomplete when the process table cannot be read', () => {
    const killPid = vi.fn();

    const result = killExternalProcessTree(WRAPPER, {
      platform: 'darwin',
      selfPid: APP_PID,
      readProcessTable: () => null,
      killPid,
    });

    expect(killPid).not.toHaveBeenCalled();
    expect(result.incomplete).toBe(true);
    expect(result.killed).toEqual([]);
    expect(result.diagnostics[0]).toContain('process table could not be read');
  });

  it('reports the refusal instead of reaping a tree containing this app', () => {
    const killPid = vi.fn();

    const result = killExternalProcessTree(WRAPPER, {
      platform: 'darwin',
      selfPid: APP_PID,
      readProcessTable: () => tree([WRAPPER, 1], [APP_PID, WRAPPER]),
      killPid,
    });

    expect(killPid).not.toHaveBeenCalled();
    expect(result.incomplete).toBe(true);
    expect(result.diagnostics[0]).toContain('refused');
  });

  /**
   * A pid whose birth identity moved was recycled; it is somebody else now.
   *
   * The re-read is what makes this observable at all. The first call collects
   * the tree; every call after it answers a table in which the node runtime's
   * pid has been taken over by an unrelated process, which is exactly the window
   * between the scan and the signal.
   */
  it('skips a pid whose identity changed between the read and the signal', () => {
    const killPid = vi.fn();
    let reads = 0;

    const result = killExternalProcessTree(WRAPPER, {
      platform: 'darwin',
      selfPid: APP_PID,
      readProcessTable: () => {
        reads += 1;
        const processes = tree([WRAPPER, 1], [NODE_RUNTIME, WRAPPER]);
        if (reads > 1) {
          processes.set(NODE_RUNTIME, {
            ...processes.get(NODE_RUNTIME)!,
            startIdentity: 'birth:someone-else',
          });
        }
        return processes;
      },
      killPid,
    });

    expect(killPid.mock.calls.map((call) => call[0])).not.toContain(NODE_RUNTIME);
    expect(result.killed).toEqual([WRAPPER]);
    expect(result.incomplete).toBe(true);
    expect(result.diagnostics.join(' ')).toContain('identity changed');
  });

  /** A pid that simply exited before its turn is the outcome, not a failure. */
  it('does not report a pid that vanished before the signal', () => {
    let reads = 0;

    const result = killExternalProcessTree(WRAPPER, {
      platform: 'darwin',
      selfPid: APP_PID,
      readProcessTable: () => {
        reads += 1;
        return reads > 1 ? tree([WRAPPER, 1]) : tree([WRAPPER, 1], [NODE_RUNTIME, WRAPPER]);
      },
      killPid: vi.fn(),
    });

    expect(result.killed).toEqual([WRAPPER]);
    expect(result.incomplete).toBe(false);
  });

  it('counts an already-exited process as reaped rather than as a failure', () => {
    const result = killExternalProcessTree(WRAPPER, {
      platform: 'darwin',
      selfPid: APP_PID,
      readProcessTable: () => tree([WRAPPER, 1], [NODE_RUNTIME, WRAPPER]),
      killPid: (pid) => {
        if (pid === NODE_RUNTIME) {
          throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
        }
      },
    });

    expect(result.incomplete).toBe(false);
    expect(result.killed).toEqual([WRAPPER]);
  });

  it('reports a signal that failed for any other reason', () => {
    const result = killExternalProcessTree(WRAPPER, {
      platform: 'darwin',
      selfPid: APP_PID,
      readProcessTable: () => tree([WRAPPER, 1]),
      killPid: () => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      },
    });

    expect(result.incomplete).toBe(true);
    expect(result.killed).toEqual([]);
    expect(result.diagnostics[0]).toContain('operation not permitted');
  });
});
