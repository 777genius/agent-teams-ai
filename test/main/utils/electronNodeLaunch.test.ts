// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const owners = vi.hoisted(() => ({ selected: vi.fn(), capture: vi.fn(), validate: vi.fn() }));
vi.mock('@main/utils/linuxChildLaunchSelection', () => ({
  hasSelectedLinuxChildLaunch: owners.selected,
}));
vi.mock('@main/utils/linuxNodeExecArtifact', () => ({
  captureLinuxNodeExecArtifact: owners.capture,
  validateLinuxNodeExecArtifact: owners.validate,
}));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/TEST/app' } }));

const descriptors = [
  { object: process, property: 'platform' },
  { object: process, property: 'type' },
  { object: process.versions, property: 'electron' },
].map(({ object, property }) => ({
  object, property, descriptor: Object.getOwnPropertyDescriptor(object, property),
}));

describe('Electron Node launch allocation ownership', () => {
  beforeEach(() => {
    vi.resetModules(); vi.resetAllMocks();
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    Object.defineProperty(process, 'type', { configurable: true, value: 'browser' });
    Object.defineProperty(process.versions, 'electron', { configurable: true, value: 'TEST' });
    owners.selected.mockReturnValue(true);
    owners.capture.mockReturnValue(Object.freeze({ path: '/TEST/node-exec' }));
  });
  afterEach(() => {
    for (const { object, property, descriptor } of descriptors) {
      if (descriptor) Object.defineProperty(object, property, descriptor);
      else Reflect.deleteProperty(object, property);
    }
    vi.resetModules();
  });

  it('keeps the direct three-pipe recipe as the default even when a generic helper exists', async () => {
    const { resolveElectronNodeLaunch } = await import('@main/utils/electronNodeLaunch');
    const selected = await resolveElectronNodeLaunch('/TEST/node', ['entry', 'one argument']);
    expect(selected).toEqual({ command: '/TEST/node-exec', args: ['--', '/TEST/node', 'entry', 'one argument'] });
    await resolveElectronNodeLaunch('/TEST/node', ['--version']);
    expect(owners.selected).not.toHaveBeenCalled();
    expect(owners.capture).toHaveBeenCalledTimes(1);
    expect(owners.validate).toHaveBeenCalledTimes(2);
  });

  it('leaves exactly one stage to the selected generic allocator without a second artifact check', async () => {
    const { resolveElectronNodeLaunch } = await import('@main/utils/electronNodeLaunch');
    const args = ['entry', 'one argument'];
    const selected = await resolveElectronNodeLaunch('/TEST/node', args, 'generic');
    expect(selected).toEqual({ command: '/TEST/node', args });
    expect(selected.args).not.toBe(args);
    expect(owners.selected).toHaveBeenCalledTimes(1);
    expect(owners.capture).not.toHaveBeenCalled();
    expect(owners.validate).not.toHaveBeenCalled();
  });

  it('retains the original pinned Node stage when the immutable generic selection is absent', async () => {
    owners.selected.mockReturnValue(false);
    const { resolveElectronNodeLaunch } = await import('@main/utils/electronNodeLaunch');
    expect(await resolveElectronNodeLaunch('/TEST/node', ['entry'], 'generic'))
      .toEqual({ command: '/TEST/node-exec', args: ['--', '/TEST/node', 'entry'] });
    expect(owners.capture).toHaveBeenCalledTimes(1);
    expect(owners.validate).toHaveBeenCalledTimes(1);
  });

  it('propagates the original selected-helper refusal without falling back to the Node stage', async () => {
    const refusal = new Error('TEST original immutable selection refusal');
    owners.selected.mockImplementation(() => { throw refusal; });
    const { resolveElectronNodeLaunch } = await import('@main/utils/electronNodeLaunch');
    await expect(resolveElectronNodeLaunch('/TEST/node', ['entry'], 'generic')).rejects.toBe(refusal);
    expect(owners.capture).not.toHaveBeenCalled();
    expect(owners.validate).not.toHaveBeenCalled();
  });

  it('rejects invalid Node arguments before either launch owner is selected', async () => {
    const { resolveElectronNodeLaunch } = await import('@main/utils/electronNodeLaunch');
    await expect(resolveElectronNodeLaunch('relative-node', [], 'generic')).rejects.toThrow('Invalid selected Node');
    await expect(resolveElectronNodeLaunch('/TEST/node', ['bad\0argument'], 'generic')).rejects.toThrow('Invalid selected Node');
    expect(owners.selected).not.toHaveBeenCalled();
    expect(owners.capture).not.toHaveBeenCalled();
  });

  it('preserves non-Electron launches without consulting either Linux stage', async () => {
    Reflect.deleteProperty(process.versions, 'electron');
    const { resolveElectronNodeLaunch } = await import('@main/utils/electronNodeLaunch');
    expect(await resolveElectronNodeLaunch('/TEST/node', ['entry'], 'generic'))
      .toEqual({ command: '/TEST/node', args: ['entry'] });
    expect(owners.selected).not.toHaveBeenCalled();
    expect(owners.capture).not.toHaveBeenCalled();
  });
});
