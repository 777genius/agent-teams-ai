import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ExternalAgentConnectionSettings } from '@features/external-agent-connection/renderer';
import '@features/localization/renderer/composition/createI18nextInstance';
import { describe, expect, it, vi } from 'vitest';

import type { ConnectionInfoV1 } from '@features/external-agent-connection/contracts';

const state = vi.hoisted(() => ({ info: null as ConnectionInfoV1 | null }));
vi.mock('@features/external-agent-connection/renderer/useConnectionInfo', () => ({
  useConnectionInfo: () => ({ info: state.info, error: null, retrying: false, retry: vi.fn() }),
}));

function snapshot(): ConnectionInfoV1 {
  return {
    schemaVersion: 1,
    context: {
      appInstanceId: 'sandbox-app',
      dataRootFingerprint: 'sandbox-root',
      connectionGeneration: 1,
    },
    appVersion: 'test',
    profileFingerprint: 'sandbox',
    observedAt: '2026-10-07T12:00:00.000Z',
    mcp: {
      status: 'ready',
      transport: 'httpStream',
      url: 'http://127.0.0.1:43001/mcp',
      generation: 1,
    },
    control: { status: 'ready' },
    cdp: {
      status: 'restart-required',
      httpOrigin: null,
      browserWsUrl: null,
      rendererTargetId: null,
      rendererWsUrl: null,
      targetGeneration: 0,
    },
    capabilities: { draftCreation: true, rendererControl: false },
    errorCode: null,
    reason: null,
    recovery: null,
  };
}

function render(cdpEnabled: boolean, local = true): string {
  return renderToStaticMarkup(
    createElement(ExternalAgentConnectionSettings, {
      api: { getConnectionInfo: vi.fn(), retryConnection: vi.fn() },
      local,
      cdpEnabled,
      saving: false,
      onCdpEnabledChange: vi.fn(),
    })
  );
}

describe('external connection settings live access', () => {
  it('does not advertise CDP endpoints before enabling has taken effect', () => {
    state.info = snapshot();
    const html = render(true);
    expect(html).toContain('Restart the app to apply the saved setting.');
    expect(html).toContain('renderer CDP: restart required');
    expect(html).toContain('http://127.0.0.1:43001/mcp');
    expect(html).not.toContain('Browser WebSocket');
    expect(html).not.toContain('Renderer access is still open');
  });

  it('keeps actual endpoints visible and warns that disabling has not revoked access', () => {
    state.info = snapshot();
    state.info.cdp = {
      status: 'restart-required',
      httpOrigin: 'http://127.0.0.1:43002',
      browserWsUrl: 'ws://127.0.0.1:43002/devtools/browser/sandbox',
      rendererTargetId: 'sandbox-renderer',
      rendererWsUrl: 'ws://127.0.0.1:43002/devtools/page/sandbox-renderer',
      targetGeneration: 1,
    };
    const html = render(false);
    expect(html).toContain('Renderer access is still open until restart.');
    expect(html).toContain('ws://127.0.0.1:43002/devtools/page/sandbox-renderer');
    expect(html).toContain('Allow full renderer access (CDP)');
    expect(html).toContain('aria-checked="false"');
  });

  it('does not expose stale local endpoints or retry controls in a remote context', () => {
    state.info = snapshot();
    const html = render(false, false);
    expect(html).toContain('local desktop app context only');
    expect(html).not.toContain('http://127.0.0.1:43001/mcp');
    expect(html).not.toContain('Retry connection');
    expect(html).not.toContain('role="switch"');
  });
});
