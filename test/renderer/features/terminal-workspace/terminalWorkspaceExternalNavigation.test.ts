import {
  openTerminalPlatformRepository,
  TERMINAL_PLATFORM_REPOSITORY_URL,
} from '@features/terminal-workspace/renderer/adapters/terminalWorkspaceExternalNavigation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('terminal workspace external navigation', () => {
  let originalElectronApiDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalElectronApiDescriptor = Object.getOwnPropertyDescriptor(window, 'electronAPI');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalElectronApiDescriptor) {
      Object.defineProperty(window, 'electronAPI', originalElectronApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'electronAPI');
    }
  });

  it('uses the Electron external navigation bridge when available', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const browserOpen = vi.spyOn(window, 'open').mockReturnValue(null);
    setElectronApi({ openExternal });

    openTerminalPlatformRepository();

    expect(openExternal).toHaveBeenCalledWith(TERMINAL_PLATFORM_REPOSITORY_URL);
    expect(browserOpen).not.toHaveBeenCalled();
  });

  it('opens a browser popup synchronously when the Electron bridge is unavailable', () => {
    const browserOpen = vi.spyOn(window, 'open').mockReturnValue(null);
    setElectronApi(undefined);

    openTerminalPlatformRepository();

    expect(browserOpen).toHaveBeenCalledWith(
      TERMINAL_PLATFORM_REPOSITORY_URL,
      '_blank',
      'noopener,noreferrer'
    );
  });
});

function setElectronApi(
  value: Pick<NonNullable<typeof window.electronAPI>, 'openExternal'> | undefined
): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: value as typeof window.electronAPI,
  });
}
