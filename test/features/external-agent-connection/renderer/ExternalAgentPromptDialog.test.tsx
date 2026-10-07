import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { ExternalAgentPromptDialog } from '@features/external-agent-connection/renderer/ExternalAgentPromptDialog';
import '@features/localization/renderer/composition/createI18nextInstance';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ConnectionInfoV1,
  ExternalAgentConnectionApi,
} from '@features/external-agent-connection/contracts';

vi.mock('@renderer/services/draftStorage', () => ({
  draftStorage: {
    loadDraft: vi.fn(async () => 'Create a review team for the sandbox'),
    saveDraft: vi.fn(async () => {}),
    deleteDraft: vi.fn(async () => {}),
  },
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
      status: 'disabled',
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

describe('external prompt freshness and clipboard fallback', () => {
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  let root: ReturnType<typeof createRoot>;
  let host: HTMLDivElement;
  let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
    else Reflect.deleteProperty(navigator, 'clipboard');
    vi.unstubAllGlobals();
  });
  const preview = () =>
    host.querySelector<HTMLTextAreaElement>('[data-testid="external-agent-prompt-preview"]');
  const copy = async () => {
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="external-agent-prompt-copy"]')!.click()
    );
  };
  const render = async (api: ExternalAgentConnectionApi) => {
    await act(async () =>
      root.render(
        createElement(ExternalAgentPromptDialog, {
          api,
          connection: snapshot(),
          isLight: false,
          onSettings: vi.fn(),
        })
      )
    );
  };

  // RED when freshness failure leaves the previously visible endpoint selectable.
  it.each(['app changed', 'root changed', 'MCP stopped', 'read failed'] as const)(
    'withdraws the old selectable prompt after %s instead of offering clipboard fallback',
    async (failure) => {
      const live = snapshot();
      if (failure === 'app changed') live.context.appInstanceId = 'another-app';
      if (failure === 'root changed') live.context.dataRootFingerprint = 'another-root';
      if (failure === 'MCP stopped') live.mcp.status = 'stopped';
      const getConnectionInfo =
        failure === 'read failed'
          ? vi.fn().mockRejectedValue(new Error('Discovery failed'))
          : vi.fn().mockResolvedValue(live);
      await render({ getConnectionInfo, retryConnection: vi.fn() });
      const reveal = Array.from(host.querySelectorAll('button')).find(
        (button) => button.textContent === 'View final prompt'
      )!;
      await act(async () => reveal.click());
      expect(preview()?.value).toContain('http://127.0.0.1:43001/mcp');
      await copy();
      expect(preview()?.value ?? '').toBe('');
      expect(reveal.disabled).toBe(true);
      expect(writeText).not.toHaveBeenCalled();
    }
  );

  // RED when a valid fresh snapshot cannot recover preview after discovery failure,
  // or when clipboard failure fails to offer the exact freshly generated prompt.
  it('recovers with the fresh selectable prompt on clipboard failure, then copies it successfully', async () => {
    const live = snapshot();
    live.observedAt = '2026-10-07T12:00:01.000Z';
    live.mcp.url = 'http://127.0.0.1:43003/mcp';
    live.mcp.generation = 2;
    live.context.connectionGeneration = 2;
    const api = {
      getConnectionInfo: vi
        .fn()
        .mockRejectedValueOnce(new Error('Discovery failed'))
        .mockResolvedValue(live),
      retryConnection: vi.fn(),
    };
    await render(api);
    await copy();
    expect(preview()?.value ?? '').toBe('');
    writeText.mockRejectedValueOnce(new Error('Clipboard denied'));
    await copy();
    const freshPrompt = writeText.mock.calls[0]?.[0];
    expect(freshPrompt).toContain('http://127.0.0.1:43003/mcp');
    expect(preview()?.value).toBe(freshPrompt);
    expect(host.textContent).toContain(
      'Clipboard write failed. Select and copy the final prompt manually.'
    );
    await copy();
    expect(writeText).toHaveBeenLastCalledWith(freshPrompt);
    expect(host.textContent).toContain('Copied');
  });
});
