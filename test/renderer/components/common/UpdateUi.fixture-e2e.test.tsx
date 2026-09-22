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
    expect(host.textContent).toContain('updateDialog.updateAvailable');
    expect(host.textContent).toContain('v999.0.0');

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
    expect(useStore.getState().updateStatus).toBe('available');
    expect(useStore.getState().updateError).toBe('Temporary update server failure');
    expect(host.textContent).toContain('updates.updateApp');

    await clickButton('updateDialog.later');
    expect(localStorage.getItem('update:dismissed-version')).toBe('999.0.0');

    await act(async () => {
      useStore.getState().handleUpdaterStatus({
        type: 'available',
        version: '999.0.0',
      });
    });
    expect(useStore.getState().showUpdateDialog).toBe(false);
    expect(host.textContent).toContain('updates.updateApp');
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
    const button = [...host.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === text
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
  }
});
