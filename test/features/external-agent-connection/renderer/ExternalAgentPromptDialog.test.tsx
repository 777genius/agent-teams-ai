import '@features/localization/renderer/composition/createI18nextInstance';

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { buildExternalAgentPrompt } from '@features/external-agent-connection';
import { ExternalAgentPromptDialog } from '@features/external-agent-connection/renderer/ExternalAgentPromptDialog';
import { TEAM_TEMPLATES } from '@features/team-templates';
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

  // RED when the final prompt requires reveal, follows the templates, or has a detached copy action.
  it('shows the selectable final prompt immediately after the request with its copy action before templates', async () => {
    await render({
      getConnectionInfo: vi.fn().mockResolvedValue(snapshot()),
      retryConnection: vi.fn(),
    });
    const task = host.querySelector<HTMLTextAreaElement>('#external-agent-task')!;
    const finalPrompt = preview();
    expect(finalPrompt).not.toBeNull();
    expect(finalPrompt?.readOnly).toBe(true);
    expect(finalPrompt?.value).toContain('Create a review team for the sandbox');
    const promptSection = task.parentElement?.nextElementSibling;
    expect(promptSection?.contains(finalPrompt)).toBe(true);
    const label = promptSection?.querySelector('label');
    expect(label?.htmlFor).toBe(finalPrompt?.id);
    expect(
      label?.parentElement?.querySelector('[data-testid="external-agent-prompt-copy"]')
    ).not.toBeNull();
    const templates = host.querySelector('section');
    expect(promptSection?.nextElementSibling).toBe(templates);
    expect(finalPrompt?.closest('[data-state="closed"]')).toBeNull();
  });

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
      expect(preview()?.value).toContain('http://127.0.0.1:43001/mcp');
      await copy();
      expect(preview()?.value ?? '').toBe('');
      expect(writeText).not.toHaveBeenCalled();
    }
  );

  // RED when editing the task bypasses connection invalidation for a pending read.
  it('withdraws a foreign-root prompt even if the task was edited during discovery', async () => {
    let finishRead!: (info: ConnectionInfoV1) => void;
    const pendingRead = new Promise<ConnectionInfoV1>((resolve) => {
      finishRead = resolve;
    });
    await render({
      getConnectionInfo: vi.fn().mockReturnValue(pendingRead),
      retryConnection: vi.fn(),
    });
    await copy();
    const task = host.querySelector<HTMLTextAreaElement>('#external-agent-task')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        task,
        'Create another team for this sandbox'
      );
      task.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(preview()?.value).toContain('Create another team for this sandbox');
    const foreign = snapshot();
    foreign.context.dataRootFingerprint = 'another-root';
    await act(async () => finishRead(foreign));
    expect(preview()?.value ?? '').toBe('');
    expect(task.value).toBe('Create another team for this sandbox');
    expect(writeText).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain(
      'The app or data root changed. Refresh the connection before copying.'
    );
  });

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

// RED if a legacy create caller gains edit powers, or manage copy promises unwired tools.
describe('external prompt operation intent', () => {
  it('keeps create callers creation-only even when management tools are wired', () => {
    const connection = snapshot();
    connection.capabilities.configurationEdit = true;
    connection.capabilities.reversibleTrash = true;
    const prompt = buildExternalAgentPrompt({
      task: 'Create a test team',
      template: TEAM_TEMPLATES[0],
      connection,
      includeCdp: false,
    });
    expect(prompt).toContain('Configuration editing is unavailable');
    expect(prompt).toContain('Trash is unavailable');
    expect(prompt).not.toContain('Use team_update');
    expect(prompt).not.toContain('Use team_trash');
  });
  it('advertises independently wired manage tools with fresh revision and no runtime bypass', () => {
    const connection = snapshot();
    connection.capabilities.configurationEdit = true;
    const prompt = buildExternalAgentPrompt({
      task: 'Edit a test team',
      templates: TEAM_TEMPLATES,
      intent: 'manage',
      connection,
      includeCdp: false,
    });
    expect(prompt).toContain('Use team_update with exactly one group');
    expect(prompt).toContain('configurationRevision as expectedRevision');
    expect(prompt).toContain('Never launch, stop, permanently delete or automatically restore');
    expect(prompt).toContain('never blindly retry a write');
    expect(prompt).not.toContain('Use team_trash');
    connection.capabilities.reversibleTrash = true;
    expect(
      buildExternalAgentPrompt({
        task: 'Trash a test team',
        templates: TEAM_TEMPLATES,
        intent: 'manage',
        connection,
        includeCdp: false,
      })
    ).toContain('Use team_trash for reversible trash only');
  });
});
