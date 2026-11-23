import '@features/localization/renderer/composition/createI18nextInstance';

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ExternalAgentConnectionSettings } from '@features/external-agent-connection/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ConnectionInfoV1,
  ExternalAgentConnectionApi,
} from '@features/external-agent-connection/contracts';

const state = vi.hoisted(() => ({ info: null as ConnectionInfoV1 | null, retry: vi.fn() }));
vi.mock('@features/external-agent-connection/renderer/useConnectionInfo', () => ({
  useConnectionInfo: () => ({ info: state.info, error: null, retrying: false, retry: state.retry }),
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
      status: 'ready',
      httpOrigin: 'http://127.0.0.1:43002',
      browserWsUrl: 'ws://127.0.0.1:43002/devtools/browser/sandbox',
      rendererTargetId: 'sandbox-renderer',
      rendererWsUrl: 'ws://127.0.0.1:43002/devtools/page/sandbox-renderer',
      targetGeneration: 1,
    },
    capabilities: { draftCreation: true, rendererControl: true },
    errorCode: null,
    reason: null,
    recovery: null,
  };
}

describe('external agent setup', () => {
  let host: HTMLDivElement;
  let root: Root;
  let api: ExternalAgentConnectionApi;
  const writeText = vi.fn().mockResolvedValue(undefined);
  const openTeams = vi.fn();
  const onCdpEnabledChange = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    state.info = snapshot();
    api = { getConnectionInfo: vi.fn(async () => snapshot()), retryConnection: vi.fn() };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  async function render(cdpEnabled = true, local = true) {
    await act(async () =>
      root.render(
        <ExternalAgentConnectionSettings
          api={api}
          local={local}
          cdpEnabled={cdpEnabled}
          saving={false}
          onCdpEnabledChange={onCdpEnabledChange}
          onOpenTeams={openTeams}
        />
      )
    );
  }
  async function selectTab(label: string) {
    const tab = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (item) => item.textContent?.trim() === label || item.textContent?.startsWith(label)
    );
    expect(tab, `tab ${label}`).toBeDefined();
    await act(async () =>
      tab!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    );
  }
  async function click(label: string) {
    const button = Array.from(host.querySelectorAll('button')).find((item) =>
      item.textContent?.includes(label)
    );
    expect(button, `button ${label}`).toBeDefined();
    await act(async () => button!.click());
  }

  it('guides registration and copies a freshly discovered endpoint without claiming an agent is connected', async () => {
    await render(true);
    expect(host.textContent).toContain('MCP server is ready');
    expect(host.textContent).toContain('does not confirm that an agent is connected');
    expect(host.textContent).not.toContain('codex mcp add');
    await selectTab('Set up manually');
    expect(host.textContent).toContain('codex mcp add');
    expect(host.textContent).toContain('Interface access is ready');
    expect(host.textContent).not.toContain('Browser WebSocket');
    await click('Copy command');
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('http://127.0.0.1:43001/mcp'));
    expect(host.textContent).toContain('Complete the setup in your agent');
    await click('What happens next?');
    await click('Open Teams');
    expect(openTeams).toHaveBeenCalledOnce();
  });

  it('copies a fresh setup prompt that verifies discovery and asks for a confirmation', async () => {
    await render();
    await click('Copy connection prompt');
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('app_show_connection_confirmation')
    );
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('app_get_connection_info'));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('sandbox-app'));
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('ws://127.0.0.1:43002/devtools/page/sandbox-renderer')
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('__AGENT_TEAMS_CONNECTION_CONTEXT__')
    );
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('cdpVerified=true'));
  });

  it('requires enabled, ready CDP before copying the combined prompt', async () => {
    state.info!.cdp.status = 'disabled';
    state.info!.cdp.httpOrigin = null;
    state.info!.cdp.browserWsUrl = null;
    state.info!.cdp.rendererTargetId = null;
    state.info!.cdp.rendererWsUrl = null;
    state.info!.capabilities.rendererControl = false;
    await render(false);
    const button = [...host.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('Copy connection prompt')
    );
    expect(button?.disabled).toBe(true);
    expect(host.textContent).toContain('Enable this to connect both MCP and the interface');
    const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    await act(async () => toggle!.click());
    expect(onCdpEnabledChange).toHaveBeenCalledWith(true);
  });

  it('uses the current renderer target when it changes before copying', async () => {
    const changed = snapshot();
    changed.cdp.rendererTargetId = 'replacement-target';
    changed.cdp.rendererWsUrl = 'ws://127.0.0.1:43002/devtools/page/replacement-target';
    changed.cdp.targetGeneration = 2;
    vi.mocked(api.getConnectionInfo).mockResolvedValue(changed);
    await render();
    await click('Copy connection prompt');
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('replacement-target'));
    expect(writeText).toHaveBeenCalledWith(expect.not.stringContaining('/page/sandbox-renderer'));
  });

  it('refuses to copy if renderer access becomes unavailable during refresh', async () => {
    const changed = snapshot();
    changed.cdp.status = 'disabled';
    changed.capabilities.rendererControl = false;
    vi.mocked(api.getConnectionInfo).mockResolvedValue(changed);
    await render();
    await click('Copy connection prompt');
    expect(writeText).not.toHaveBeenCalled();
    expect(host.textContent).toContain('connection changed or became unavailable');
  });

  it('rejects a pending copy after the displayed app root changes', async () => {
    let resolveLive!: (info: ConnectionInfoV1) => void;
    const pending = new Promise<ConnectionInfoV1>((resolve) => {
      resolveLive = resolve;
    });
    vi.mocked(api.getConnectionInfo).mockReturnValue(pending);
    await render();
    await click('Copy connection prompt');
    const changed = snapshot();
    changed.context.dataRootFingerprint = 'replacement-root';
    state.info = changed;
    await render();
    await act(async () => resolveLive(snapshot()));
    expect(writeText).not.toHaveBeenCalled();
    expect(host.textContent).toContain('connection changed or became unavailable');
  });

  it('shows only the chosen setup method', async () => {
    await render();
    expect(host.textContent).toContain('Copy connection prompt');
    expect(host.textContent).not.toContain('codex mcp add');
    await selectTab('Set up manually');
    expect(host.textContent).toContain('codex mcp add');
    expect(host.textContent).not.toContain('Copy connection prompt');
    await selectTab('With a prompt');
    expect(host.textContent).toContain('Copy connection prompt');
    expect(host.textContent).not.toContain('codex mcp add');
  });

  it('offers the Claude command and a Streamable HTTP address for other clients', async () => {
    await render();
    await selectTab('Set up manually');
    await selectTab('Claude Code');
    expect(host.textContent).toContain('claude mcp add --transport http --scope user');
    await click('Copy command');
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('claude mcp add'));
    await selectTab('Other MCP client');
    expect(host.textContent).toContain('Streamable HTTP');
    await click('Copy address');
    expect(writeText).toHaveBeenLastCalledWith('http://127.0.0.1:43001/mcp');
  });

  it('does not advise copying a stale address when live discovery fails', async () => {
    vi.mocked(api.getConnectionInfo).mockRejectedValue(new Error('offline'));
    await render();
    await click('Copy connection prompt');
    expect(writeText).not.toHaveBeenCalled();
    expect(host.textContent).toContain('connection changed or became unavailable');
  });

  it('refuses to copy if the active app or root changed', async () => {
    const different = snapshot();
    different.context.dataRootFingerprint = 'other-root';
    vi.mocked(api.getConnectionInfo).mockResolvedValue(different);
    await render();
    await click('Copy connection prompt');
    expect(writeText).not.toHaveBeenCalled();
    expect(host.textContent).toContain('connection changed or became unavailable');
  });

  it('explains the disabled bridge without offering an ineffective retry', async () => {
    state.info!.mcp.status = 'error';
    state.info!.mcp.url = null;
    state.info!.errorCode = 'MCP_HTTP_DISABLED';
    await render();
    expect(host.textContent).toContain('CLAUDE_TEAM_OPENCODE_MCP_HTTP');
    expect(host.textContent).toContain('restart the app');
    expect(host.textContent).not.toContain('Retry connection');
    expect(host.textContent).not.toContain('codex mcp add');
  });

  it('warns when CDP remains open until restart and exposes diagnostics only when expanded', async () => {
    state.info!.cdp = {
      status: 'restart-required',
      httpOrigin: 'http://127.0.0.1:43002',
      browserWsUrl: 'ws://127.0.0.1:43002/devtools/browser/sandbox',
      rendererTargetId: 'sandbox-renderer',
      rendererWsUrl: 'ws://127.0.0.1:43002/devtools/page/sandbox-renderer',
      targetGeneration: 1,
    };
    await render(false);
    expect(host.textContent).not.toContain('sandbox-renderer');
    await click('Advanced: UI access and diagnostics');
    expect(host.textContent).toContain('Interface access is currently open.');
    expect(host.textContent).toContain('sandbox-renderer');
    expect(host.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
  });

  it('hides local setup and controls in a remote context', async () => {
    await render(false, false);
    expect(host.textContent).toContain('local desktop app context');
    expect(host.textContent).not.toContain('http://127.0.0.1:43001/mcp');
    expect(host.textContent).not.toContain('Retry connection');
    expect(host.querySelector('[role="switch"]')).toBeNull();
  });
});
