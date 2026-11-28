import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';

vi.mock('child_process', () => {
  const execFile = vi.fn();
  return { execFile, default: { execFile } };
});
import { execFile } from 'child_process';
import {
  captureWindowsProcessTree,
  extendObservedWindowsProcessTree,
  unattributableWindowsProcessBirths,
  killWindowsProcessTreeAndWait,
  parseWindowsProcessCensus,
  windowsProcessTreeRetired,
  type WindowsProcessIdentity,
} from '@main/utils/windowsProcessTree';

const root: WindowsProcessIdentity = { pid: 401, parentPid: 100, birth: '638987654321000000' };
const tool: WindowsProcessIdentity = { pid: 402, parentPid: 401, birth: '638987654321001000' };
const nested: WindowsProcessIdentity = { pid: 403, parentPid: 402, birth: '638987654321002000' };
const stale: WindowsProcessIdentity = { pid: 404, parentPid: 401, birth: '638000000000000000' };
const unrelated: WindowsProcessIdentity = { pid: 800, parentPid: 1, birth: '638987654320999999' };
const late: WindowsProcessIdentity = { pid: 450, parentPid: 401, birth: '638987654321003000' };
const grandchild: WindowsProcessIdentity = { pid: 451, parentPid: 450, birth: '638987654321004000' };
const execMock = vi.mocked(execFile);

function arrange(
  inventories: (WindowsProcessIdentity[] | Error)[], taskkillError: Error | null
) {
  const pending = [...inventories], commands: string[] = [];
  execMock.mockImplementation(((command: string, _args: string[], _options: object,
    callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    commands.push(command);
    if (/powershell\.exe$/i.test(command)) {
      const item = pending.shift();
      if (item instanceof Error || !item) callback(item ?? new Error('No census'), '', '');
      else callback(null, JSON.stringify(item), '');
    } else if (/taskkill\.exe$/i.test(command)) {
      callback(taskkillError, '', taskkillError?.message ?? '');
    } else throw new Error('Unexpected binary');
    return { pid: 999 } as ReturnType<typeof execFile>;
  }) as typeof execFile);
  const kill = vi.fn(() => true);
  const child = { pid: root.pid, exitCode: null, signalCode: null, kill } as unknown as ChildProcess;
  return { child, kill, commands, unread: () => pending.length };
}
beforeEach(() => execMock.mockReset());

describe('identity-bound original Win32 process census', () => {
  it('rejects malformed identities and recycled parent relationships', () => {
    expect(captureWindowsProcessTree([root, tool, nested, stale], root.pid))
      .toEqual([root, tool, nested]);
    expect(() => captureWindowsProcessTree([tool], root.pid)).toThrow('root identity');
    expect(() => parseWindowsProcessCensus('[{"pid":401,"parentPid":1,"birth":""},{"pid":401,"parentPid":1,"birth":""}]'))
      .toThrow('Invalid Windows process identity');
  });

  it('skips Windows System Idle Process PID 0 without weakening malformed-entry checks', () => {
    const census = parseWindowsProcessCensus(JSON.stringify([
      { pid: 0, parentPid: 0, birth: '' }, root, tool,
    ]));
    expect(census).toEqual([root, tool]);
    expect(() => parseWindowsProcessCensus(JSON.stringify([{ pid: 0, parentPid: 0, birth: '' }])))
      .toThrow('Invalid Windows process census size');
    expect(() => parseWindowsProcessCensus(JSON.stringify([
      { pid: 0, parentPid: 0, birth: '' }, { pid: -1, parentPid: 0, birth: '' },
    ]))).toThrow('Invalid Windows process identity');
  });

  it('retains discovered late children and grandchildren after intermediate parents exit', () => {
    const seen = extendObservedWindowsProcessTree([root], [late, grandchild, unrelated]);
    expect(seen).toEqual([root, late, grandchild]);
    expect(windowsProcessTreeRetired(seen, [grandchild, unrelated])).toBe(false);
    expect(windowsProcessTreeRetired(seen, [unrelated])).toBe(true);
  });

  it('refuses an unobserved late grandchild and proves unrelated current parent ancestry', () => {
    const foreign = { pid: 900, parentPid: unrelated.pid, birth: '638987654322000000' };
    expect(unattributableWindowsProcessBirths(
      [root, unrelated], [unrelated, grandchild], [root]
    )).toEqual([grandchild]);
    expect(unattributableWindowsProcessBirths(
      [root, unrelated], [unrelated, foreign], [root]
    )).toEqual([]);
    const recycledParent = { ...unrelated, birth: '638987654322000001' };
    expect(unattributableWindowsProcessBirths(
      [root, unrelated], [recycledParent, foreign], [root]
    ).some(row => row.pid === foreign.pid)).toBe(true);
  });

  it('does not trust a younger baseline orphan without proven ancestry', async () => {
    const foreign = { pid: 900, parentPid: unrelated.pid, birth: '638987654322000000' };
    expect(unattributableWindowsProcessBirths(
      [root, grandchild, unrelated, foreign], [grandchild, foreign], [root]
    )).toEqual([grandchild]);
    const { child } = arrange([
      [root, grandchild, unrelated], [grandchild, unrelated], [grandchild, unrelated],
    ], new Error('raced descendant'));
    await expect(killWindowsProcessTreeAndWait(child)).rejects.toThrow('remains unconfirmed');
  });

  it('classifies only original births as alive, refusing surviving descendants', () => {
    expect(windowsProcessTreeRetired([root, tool, nested], [])).toBe(true);
    expect(windowsProcessTreeRetired([root, tool], [tool])).toBe(false);
    expect(windowsProcessTreeRetired([root], [{ ...root, birth: '638987654321999999' }])).toBe(true);
    expect(windowsProcessTreeRetired([root], [{ pid: 450, parentPid: root.pid, birth: '638987654321999999' }]))
      .toBe(false);
    expect(windowsProcessTreeRetired([root], [{ pid: 450, parentPid: root.pid, birth: '' }]))
      .toBe(false);
  });

  it('accepts a raced, nonzero taskkill only after all original PIDs retire', async () => {
    const {child,kill,commands,unread} = arrange([[root,tool,nested,unrelated], [unrelated]], new Error('raced descendant'));
    await expect(killWindowsProcessTreeAndWait(child)).resolves.toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
    expect(commands.filter(c => /taskkill\.exe$/i.test(c))).toHaveLength(1);
    expect(unread()).toBe(0);
  });

  it('uses handle fallback only if independently confirmed afterward', async () => {
    const {child,kill} = arrange([[root,tool,unrelated], [root,unrelated], [unrelated]], new Error('partial taskkill'));
    await expect(killWindowsProcessTreeAndWait(child)).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not lose a late grandchild when its intermediate parent exits between censuses', async () => {
    const {child,kill} = arrange([
      [root], [late, grandchild, unrelated], [grandchild, unrelated],
    ], new Error('raced descendant'));
    await expect(killWindowsProcessTreeAndWait(child)).rejects.toThrow('remains unconfirmed');
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('accepts retirement of a late child only after observing its later disappearance', async () => {
    const {child,kill} = arrange([
      [root,unrelated], [late, unrelated], [unrelated],
    ], new Error('raced descendant'));
    await expect(killWindowsProcessTreeAndWait(child)).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not turn a failed follow-up census into later verified retirement', async () => {
    const {child,kill} = arrange([
      [root], new Error('CIM became unavailable'), [unrelated],
    ], new Error('raced descendant'));
    await expect(killWindowsProcessTreeAndWait(child)).rejects.toThrow('remains unconfirmed');
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('rejects a survivor whose intermediate parent was never observed', async () => {
    const {child,kill} = arrange([
      [root,unrelated], [grandchild,unrelated], [grandchild,unrelated],
    ], new Error('raced descendant'));
    await expect(killWindowsProcessTreeAndWait(child)).rejects.toThrow('remains unconfirmed');
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not declare Stop confirmed with any surviving tool', async () => {
    const {child,kill} = arrange([[root,tool], [tool], [tool]], new Error('partial taskkill'));
    await expect(killWindowsProcessTreeAndWait(child)).rejects.toThrow('remains unconfirmed');
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('fails closed if CIM is unavailable and taskkill failed', async () => {
    const {child} = arrange([new Error('CIM unavailable')], new Error('Access denied'));
    await expect(killWindowsProcessTreeAndWait(child)).rejects.toThrow('unconfirmed');
  });

  it('retains successful native taskkill behavior when pre-census was unavailable', async () => {
    const {child} = arrange([new Error('CIM unavailable')], null);
    await expect(killWindowsProcessTreeAndWait(child)).resolves.toBeUndefined();
  });

  it('never signals an already-exited original root', async () => {
    const {child,commands} = arrange([], null);
    (child as ChildProcess & { exitCode: number }).exitCode = 0;
    await expect(killWindowsProcessTreeAndWait(child)).resolves.toBeUndefined();
    expect(commands).toHaveLength(0);
  });
});
