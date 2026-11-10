import { expect, it, vi } from 'vitest';

import { installMockElectronAPI } from '../../mocks/electronAPI';

it('imports the complete renderer store before transport installation and resolves the API only on invocation', async () => {
  const original = Object.getOwnPropertyDescriptor(window, 'electronAPI');
  const openEventSource = vi.fn(() => {
    throw new Error('Store composition must not open an HTTP event stream');
  });
  vi.stubGlobal('EventSource', openEventSource);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: undefined });
  try {
    const { useStore } = await import('../../../src/renderer/store');
    expect(typeof useStore.getState().restartMember).toBe('function');
    expect(openEventSource).not.toHaveBeenCalled();

    // Existing consumers may install a partial native API after importing UI.
    // Its absent teams capability must not break unrelated store composition.
    const native = installMockElectronAPI();
    native.getProjects.mockResolvedValue([]);
    await useStore.getState().fetchProjects();
    expect(native.getProjects).toHaveBeenCalledOnce();
    expect(openEventSource).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    if (original) Object.defineProperty(window, 'electronAPI', original);
    else Reflect.deleteProperty(window, 'electronAPI');
  }
});
