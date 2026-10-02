import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { UpdateDialog } from '@renderer/components/common/UpdateDialog';
import { TabBarActions } from '@renderer/components/layout/TabBarActions';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@renderer/components/layout/MoreMenu', () => ({
  MoreMenu: () => null,
}));

describe('app update UI fixture-e2e', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    localStorage.clear();
    useStore.setState({
      updateStatus: 'idle',
      availableVersion: null,
      releaseNotes: null,
      downloadProgress: 0,
      updateError: null,
      updateOperation: null,
      showUpdateDialog: false,
      showUpdateBanner: false,
      dismissedUpdateVersion: null,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = '';
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('carries an available event through the header action and dialog actions', async () => {
    await renderUpdateUi();
    expect(host.textContent).not.toContain('updates.updateApp');

    await act(async () => {
      useStore.getState().handleUpdaterStatus({
        type: 'available',
        version: '999.0.0',
        releaseNotes: 'Fixture release notes',
      });
    });

    expect(host.textContent).toContain('updates.updateApp');
    expect(document.body.textContent).toContain('updateDialog.updateAvailable');
    expect(document.body.textContent).toContain('v999.0.0');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useStore.getState().showUpdateDialog).toBe(false);
    expect(localStorage.getItem('update:dismissed-version')).toBeNull();
    expect(host.textContent).toContain('updates.updateApp');

    await clickButton('updates.updateApp');
    expect(useStore.getState().showUpdateDialog).toBe(true);

    await act(async () => {
      useStore.getState().handleUpdaterStatus({
        type: 'error',
        error: 'Temporary update server failure',
      });
    });
    expect(useStore.getState().updateStatus).toBe('error');
    expect(useStore.getState().updateError).toBe('Temporary update server failure');
    expect(host.textContent).toContain('updates.updateFailed');
    expect(document.body.textContent).toContain('updateDialog.errorTitle');

    await clickButton('actions.close');
    expect(localStorage.getItem('update:dismissed-version')).toBeNull();

    await act(async () => {
      useStore.getState().handleUpdaterStatus({
        type: 'available',
        version: '999.0.0',
      });
    });
    expect(useStore.getState().showUpdateDialog).toBe(false);
    expect(host.textContent).toContain('updates.updateFailed');
  });

  it('keeps the header update action visible after the dialog is dismissed', async () => {
    await renderUpdateUi();
    await act(async () => {
      useStore.getState().handleUpdaterStatus({
        type: 'available',
        version: '999.0.0',
      });
      useStore.getState().dismissUpdateDialog();
    });

    expect(useStore.getState().showUpdateDialog).toBe(false);
    expect(host.textContent).toContain('updates.updateApp');

    await act(async () => {
      useStore.getState().handleUpdaterStatus({
        type: 'available',
        version: '999.0.0',
      });
    });
    expect(useStore.getState().showUpdateDialog).toBe(false);
    expect(host.textContent).toContain('updates.updateApp');

    await act(async () => {
      useStore.getState().handleUpdaterStatus({
        type: 'downloaded',
        version: '999.0.0',
      });
    });
    expect(host.textContent).toContain('updates.restartToUpdate');
    expect(host.textContent).not.toContain('v999.0.0');
  });

  it('shows signature recovery without a known version, opens the official site and stays reopenable', async () => {
    const openExternal = vi.fn().mockResolvedValue({ success: true });
    vi.stubGlobal('electronAPI', { openExternal });
    await renderUpdateUi();
    await act(async () => {
      useStore
        .getState()
        .handleUpdaterStatus({ type: 'error', error: 'The update is improperly signed' });
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="update-error"]')?.textContent).toContain(
      'updateDialog.recovery.signature'
    );
    expect(document.querySelector('[data-testid="update-error"]')?.textContent).toContain(
      'updateDialog.keepData'
    );
    expect(document.querySelector('[data-testid="update-retry"]')).toBeNull();
    expect(document.body.textContent).not.toContain('updateDialog.restartNow');
    await clickButton('updateDialog.manualDownload');
    expect(openExternal).toHaveBeenCalledWith('https://agentteams.live/#download');
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    );
    expect(useStore.getState().showUpdateDialog).toBe(false);
    expect(host.textContent).toContain('updates.updateFailed');
    await clickButton('updates.updateFailed');
    expect(document.querySelector('[data-testid="update-error"]')).not.toBeNull();
  });

  it('replaces restart actions with generic recovery and keeps technical details separate', async () => {
    await renderUpdateUi();
    await act(async () =>
      useStore.getState().handleUpdaterStatus({ type: 'downloaded', version: '999.0.0' })
    );
    await clickButton('updates.restartToUpdate');
    expect(document.body.textContent).toContain('updateDialog.restartNow');
    await act(async () =>
      useStore.getState().handleUpdaterStatus({ type: 'error', error: 'ENOSPC' })
    );
    expect(document.body.textContent).not.toContain('updateDialog.restartNow');
    expect(document.body.textContent).not.toContain('updates.restartToUpdate');
    expect(document.querySelector('[data-testid="update-error"]')?.textContent).toContain(
      'updateDialog.recovery.generic'
    );
    expect(document.querySelector('[data-testid="update-retry"]')).toBeNull();
    expect(document.querySelector('details pre')?.textContent).toBe('ENOSPC');
  });

  it('shows an actionable error if the external browser cannot be opened', async () => {
    vi.stubGlobal('electronAPI', {
      openExternal: vi.fn().mockRejectedValue(new Error('Unavailable')),
    });
    await renderUpdateUi();
    await act(async () =>
      useStore.getState().handleUpdaterStatus({ type: 'error', error: 'HTTP 503' })
    );
    expect(document.querySelector('[data-testid="update-retry"]')).not.toBeNull();
    await clickButton('updateDialog.manualDownload');
    expect(document.body.textContent).toContain('updateDialog.openLinkFailed');
    expect(document.body.textContent).toContain('https://agentteams.live/#download');
  });

  async function renderUpdateUi(): Promise<void> {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <TabBarActions />
          <UpdateDialog />
        </TooltipProvider>
      );
    });
  }

  async function clickButton(text: string): Promise<void> {
    const button = [...document.body.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === text && !candidate.querySelector('.sr-only')
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
  }
});
