import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  CodexRuntimeUpdateDialog,
  CodexRuntimeUpdateNotice,
} from '@features/codex-runtime-installer/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';

const staleStatus: CodexRuntimeStatus = {
  installed: true,
  binaryPath: '/usr/local/bin/codex',
  version: 'codex-cli 0.139.0',
  latestVersion: '0.144.1',
  updateAvailable: true,
  source: 'path',
  state: 'ready',
};

describe('Codex runtime update UI', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('reuses the same update action in the notice and dialog', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onInstall = vi.fn();

    await act(async () => {
      root.render(
        <>
          <CodexRuntimeUpdateNotice status={staleStatus} onUpdate={() => undefined} />
          <CodexRuntimeUpdateDialog
            open
            onOpenChange={() => undefined}
            status={staleStatus}
            loading={false}
            onInstall={onInstall}
          />
        </>
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="codex-runtime-update-notice"]')).not.toBeNull();
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Update available');
    expect(dialog?.textContent).toContain('v0.139.0 -> v0.144.1');

    const updateButton = Array.from(dialog?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('Update to v0.144.1')
    );
    await act(async () => {
      updateButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onInstall).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it('shows determinate download progress', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const downloadingStatus: CodexRuntimeStatus = {
      ...staleStatus,
      state: 'downloading',
      progress: {
        phase: 'downloading',
        percent: 42,
        downloadedBytes: 42,
        totalBytes: 100,
        detail: 'Downloading Codex 42%',
      },
    };

    await act(async () => {
      root.render(
        <CodexRuntimeUpdateDialog
          open
          onOpenChange={() => undefined}
          status={downloadingStatus}
          loading
          onInstall={() => undefined}
        />
      );
      await Promise.resolve();
    });

    const progress = document.body.querySelector('[role="progressbar"]');
    expect(progress?.getAttribute('aria-valuenow')).toBe('42');
    expect(document.body.textContent).toContain('Downloading Codex 42%');
    await act(async () => root.unmount());
  });
});
