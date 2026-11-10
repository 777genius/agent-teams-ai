import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { CodexModelCatalogFallbackNotice } from '@renderer/components/team/dialogs/CodexModelCatalogFallbackNotice';
import { isCodexModelCatalogFallbackActive } from '@renderer/utils/codexModelCatalogFallback';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';
import type { CliProviderModelCatalog } from '@shared/types';

const fallbackCatalog: CliProviderModelCatalog = {
  schemaVersion: 1,
  providerId: 'codex',
  source: 'static-fallback',
  status: 'degraded',
  fetchedAt: '2026-07-10T00:00:00.000Z',
  staleAt: '2026-07-10T00:10:00.000Z',
  defaultModelId: 'gpt-5.6-sol',
  defaultLaunchModel: 'gpt-5.6-sol',
  models: [],
  diagnostics: {
    configReadState: 'skipped',
    appServerState: 'degraded',
    message: 'model/list timed out',
    code: null,
  },
};

const currentRuntimeStatus: CodexRuntimeStatus = {
  installed: true,
  binaryPath: '/usr/local/bin/codex',
  version: 'codex-cli 0.144.1',
  latestVersion: '0.144.1',
  updateAvailable: false,
  source: 'path',
  state: 'ready',
};

describe('CodexModelCatalogFallbackNotice', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows fallback context even when Codex is already current', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <CodexModelCatalogFallbackNotice
          catalog={fallbackCatalog}
          runtimeStatus={currentRuntimeStatus}
          onUpdate={() => undefined}
        />
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Live Codex models unavailable');
    expect(host.textContent).toContain('Showing a fallback model list');
    expect(host.querySelector('button')).toBeNull();

    await act(async () => root.unmount());
  });

  it('offers the shared update action when a newer Codex is available', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onUpdate = vi.fn();

    await act(async () => {
      root.render(
        <CodexModelCatalogFallbackNotice
          catalog={fallbackCatalog}
          runtimeStatus={{
            ...currentRuntimeStatus,
            version: 'codex-cli 0.139.0',
            updateAvailable: true,
          }}
          onUpdate={onUpdate}
        />
      );
      await Promise.resolve();
    });

    const updateButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Update to v0.144.1')
    );
    await act(async () => {
      updateButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onUpdate).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it('does not warn for healthy app-server or intentional ready static catalogs', async () => {
    expect(isCodexModelCatalogFallbackActive({ ...fallbackCatalog, source: 'app-server' })).toBe(
      false
    );
    expect(isCodexModelCatalogFallbackActive({ ...fallbackCatalog, status: 'ready' })).toBe(false);

    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <CodexModelCatalogFallbackNotice
          catalog={{ ...fallbackCatalog, status: 'ready' }}
          runtimeStatus={currentRuntimeStatus}
          onUpdate={() => undefined}
        />
      );
      await Promise.resolve();
    });
    expect(host.textContent).toBe('');

    await act(async () => {
      root.render(
        <CodexModelCatalogFallbackNotice
          catalog={{ ...fallbackCatalog, source: 'app-server', status: 'ready' }}
          runtimeStatus={currentRuntimeStatus}
          onUpdate={() => undefined}
        />
      );
      await Promise.resolve();
    });
    expect(host.textContent).toBe('');

    await act(async () => root.unmount());
  });
});
