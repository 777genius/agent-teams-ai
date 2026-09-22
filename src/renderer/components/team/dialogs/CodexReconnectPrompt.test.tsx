import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexReconnectPrompt } from './CodexReconnectPrompt';

const apiMock = vi.hoisted(() => ({
  openExternal: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: apiMock,
}));

async function renderPrompt(
  props: React.ComponentProps<typeof CodexReconnectPrompt>
): Promise<{ host: HTMLDivElement; cleanup: () => Promise<void> }> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  await act(async () => {
    root.render(<CodexReconnectPrompt {...props} />);
    await Promise.resolve();
  });

  return {
    host,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
    },
  };
}

function getButton(host: HTMLElement, label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label)
  );
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

describe('CodexReconnectPrompt', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('offers browser login and device-code fallback before a link exists', async () => {
    const onReconnect = vi.fn();
    const onDeviceCodeReconnect = vi.fn();
    const { host, cleanup } = await renderPrompt({
      authUrl: null,
      userCode: null,
      reconnectBusy: false,
      onReconnect,
      onDeviceCodeReconnect,
    });

    await act(async () => {
      getButton(host, 'Generate link').click();
      getButton(host, 'Use code').click();
      await Promise.resolve();
    });

    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(onDeviceCodeReconnect).toHaveBeenCalledTimes(1);
    expect(apiMock.openExternal).not.toHaveBeenCalled();

    await cleanup();
  });

  it('opens the generated browser link without starting another login', async () => {
    const onReconnect = vi.fn();
    const onDeviceCodeReconnect = vi.fn();
    const authUrl =
      'https://chatgpt.com/auth?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback';
    const { host, cleanup } = await renderPrompt({
      authUrl,
      userCode: null,
      reconnectBusy: false,
      onReconnect,
      onDeviceCodeReconnect,
    });

    expect(host.textContent).not.toContain('Use code');

    await act(async () => {
      getButton(host, 'Open login').click();
      await Promise.resolve();
    });

    expect(apiMock.openExternal).toHaveBeenCalledWith(authUrl);
    expect(onReconnect).not.toHaveBeenCalled();
    expect(onDeviceCodeReconnect).not.toHaveBeenCalled();

    await cleanup();
  });

  it('shows the code badge for a pending device-code login', async () => {
    const { host, cleanup } = await renderPrompt({
      authUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
      reconnectBusy: false,
      onReconnect: vi.fn(),
      onDeviceCodeReconnect: vi.fn(),
    });

    expect(host.textContent).toContain('Code');
    expect(host.textContent).toContain('ABCD-1234');
    expect(host.textContent).toContain('Copy link + code');

    await cleanup();
  });
});
