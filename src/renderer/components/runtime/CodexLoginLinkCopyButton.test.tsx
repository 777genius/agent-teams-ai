import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexLoginLinkCopyButton, CodexLoginUserCodeBadge } from './CodexLoginLinkCopyButton';

async function renderNode(
  node: React.ReactElement
): Promise<{ host: HTMLDivElement; cleanup: () => Promise<void> }> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  await act(async () => {
    root.render(node);
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

function stubClipboard(writeText: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('navigator', {
    ...navigator,
    clipboard: { writeText },
  });
}

describe('CodexLoginLinkCopyButton', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('renders nothing until an auth URL is available', async () => {
    const { host, cleanup } = await renderNode(<CodexLoginLinkCopyButton authUrl={null} />);

    expect(host.textContent).toBe('');

    await cleanup();
  });

  it('copies only the browser login URL when no user code is present', async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);
    const authUrl =
      'https://chatgpt.com/auth?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback';
    const { host, cleanup } = await renderNode(<CodexLoginLinkCopyButton authUrl={authUrl} />);

    await act(async () => {
      host.querySelector('button')?.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(authUrl);
    expect(host.textContent).toContain('Copied');

    await cleanup();
  });

  it('copies the device login URL and code together', async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);
    const { host, cleanup } = await renderNode(
      <CodexLoginLinkCopyButton
        authUrl="https://auth.openai.com/codex/device"
        userCode="ABCD-1234"
      />
    );

    await act(async () => {
      host.querySelector('button')?.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith('https://auth.openai.com/codex/device\nCode: ABCD-1234');
    expect(host.textContent).toContain('Copied');

    await cleanup();
  });

  it('shows copy failure when clipboard write fails', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('clipboard denied');
    });
    stubClipboard(writeText);
    const { host, cleanup } = await renderNode(
      <CodexLoginLinkCopyButton authUrl="https://chatgpt.com/auth" />
    );

    await act(async () => {
      host.querySelector('button')?.click();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Copy failed');

    await cleanup();
  });

  it('renders a user code badge only for device-code login state', async () => {
    const empty = await renderNode(<CodexLoginUserCodeBadge userCode={null} />);
    expect(empty.host.textContent).toBe('');
    await empty.cleanup();

    const filled = await renderNode(<CodexLoginUserCodeBadge userCode="ABCD-1234" />);
    expect(filled.host.textContent).toContain('Code');
    expect(filled.host.textContent).toContain('ABCD-1234');
    await filled.cleanup();
  });
});
