import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
import { execFile } from 'child_process';
import {
  captureWindowsProcessTree,
  killWindowsProcessTreeAndWait,
  parseWindowsProcessCensus,
  windowsProcessTreeRetired,
  type WindowsProcessIdentity,
} from '@main/utils/windowsProcessTree';

const root: WindowsProcessIdentity = { pid: 401, parentPid: 100, birth: '638987654321000000' };
const tool: WindowsProcessIdentity = { pid: 402, parentPid: 401, birth: '638987654321001000' };
const nested: WindowsProcessIdentity = { pid: 403, parentPid: 402, birth: '638987654321002000' };
const stale: WindowsProcessIdentity = { pid: 404, parentPid: 401, birth: '638000000000000000' };
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
    const {child,kill,commands,unread} = arrange([[root,tool,nested], []], new Error('raced descendant'));
    await expect(killWindowsProcessTreeAndWait(child)).resolves.toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
    expect(commands.filter(c => /taskkill\.exe$/i.test(c))).toHaveLength(1);
    expect(unread()).toBe(0);
  });

  it('uses handle fallback only if independently confirmed afterward', async () => {
    const {child,kill} = arrange([[root,tool], [root], []], new Error('partial taskkill'));
    await expect(killWindowsProcessTreeAndWait(child)).resolves.toBeUndefined();
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
