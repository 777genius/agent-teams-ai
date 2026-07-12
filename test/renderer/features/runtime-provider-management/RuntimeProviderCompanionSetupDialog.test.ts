import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RuntimeProviderCompanionSetupDialog } from '../../../../src/features/runtime-provider-management/renderer/ui/RuntimeProviderCompanionSetupDialog';

import type { RuntimeProviderCompanionStatusDto } from '../../../../src/features/runtime-provider-management/contracts';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

function status(
  overrides: Partial<RuntimeProviderCompanionStatusDto> = {}
): RuntimeProviderCompanionStatusDto {
  return {
    companionId: 'kiro-cli',
    displayName: 'Kiro CLI',
    phase: 'installing',
    installed: false,
    authenticated: false,
    binaryPath: null,
    version: null,
    percent: 42,
    message: 'Downloading the signed Kiro CLI package...',
    detail: 'Official installer',
    error: null,
    manualCommand: 'curl -fsSL https://cli.kiro.dev/install | bash',
    manualUrl: 'https://kiro.dev/downloads/',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('RuntimeProviderCompanionSetupDialog', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('shows live staged progress while automatic installation runs', async () => {
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderCompanionSetupDialog, {
          open: true,
          title: 'Amazon Q Developer / Kiro',
          description: 'Use Kiro through OpenCode.',
          status: status(),
          busy: true,
          onOpenChange: vi.fn(),
          onInstallAndConnect: vi.fn(),
          onConnect: vi.fn(),
          onCopyManualCommand: vi.fn(),
          onOpenManualGuide: vi.fn(),
        })
      );
    });

    const progressbar = document.body.querySelector('[role="progressbar"]');
    expect(progressbar?.getAttribute('aria-valuenow')).toBe('42');
    expect(document.body.textContent).toContain('Downloading the signed Kiro CLI package');
  });

  it('exposes a copyable official fallback after a safe installer stop', async () => {
    const onCopyManualCommand = vi.fn();
    const onOpenManualGuide = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderCompanionSetupDialog, {
          open: true,
          title: 'Amazon Q Developer / Kiro',
          description: 'Use Kiro through OpenCode.',
          status: status({
            phase: 'needs-manual-step',
            percent: null,
            message: 'Automatic installation could not finish',
            error: 'Installer format changed',
          }),
          busy: false,
          onOpenChange: vi.fn(),
          onInstallAndConnect: vi.fn(),
          onConnect: vi.fn(),
          onCopyManualCommand,
          onOpenManualGuide,
        })
      );
    });

    expect(document.body.textContent).toContain('curl -fsSL https://cli.kiro.dev/install | bash');
    const buttons = [...document.body.querySelectorAll('button')];
    act(() => buttons.find((button) => button.textContent?.includes('copyCommand'))?.click());
    act(() => buttons.find((button) => button.textContent?.includes('openKiroGuide'))?.click());
    expect(onCopyManualCommand).toHaveBeenCalledTimes(1);
    expect(onOpenManualGuide).toHaveBeenCalledTimes(1);
  });

  it('renders Cursor in the same provider-agnostic setup dialog', async () => {
    const onInstallAndConnect = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderCompanionSetupDialog, {
          open: true,
          title: 'Cursor',
          description: 'Use Cursor through the managed OpenCode Cursor plugin.',
          status: status({
            companionId: 'cursor-agent',
            displayName: 'Cursor Agent CLI',
            phase: 'missing',
            message: 'Cursor Agent CLI is required',
            manualCommand: 'curl https://cursor.com/install -fsS | bash',
            manualUrl: 'https://cursor.com/docs/cli/installation',
          }),
          busy: false,
          onOpenChange: vi.fn(),
          onInstallAndConnect,
          onConnect: vi.fn(),
          onCopyManualCommand: vi.fn(),
          onOpenManualGuide: vi.fn(),
        })
      );
    });

    expect(document.body.textContent).toContain('Cursor');
    expect(document.body.textContent).not.toContain('Connect Amazon Q Developer / Kiro');
    const install = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('installAndConnect')
    );
    act(() => install?.click());
    expect(onInstallAndConnect).toHaveBeenCalledTimes(1);
  });
});
