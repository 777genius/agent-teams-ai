import '@features/localization/renderer/composition/createI18nextInstance';

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { buildExternalAgentPrompt } from '@features/external-agent-connection';
import { ExternalAgentPromptDialog } from '@features/external-agent-connection/renderer/ExternalAgentPromptDialog';
import { TEAM_TEMPLATES } from '@features/team-templates';
import { draftStorage } from '@renderer/services/draftStorage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ConnectionInfoV1,
  ExternalAgentConnectionApi,
  ExternalAgentRunSnapshot,
} from '@features/external-agent-connection/contracts';

vi.mock('@renderer/services/draftStorage', () => ({
  draftStorage: {
    loadDraft: vi.fn(async () => 'Create a review team for the sandbox'),
    saveDraft: vi.fn(async () => {}),
    deleteDraft: vi.fn(async () => {}),
  },
}));
vi.mock('@renderer/hooks/useEffectiveCliProviderStatus', () => ({
  useEffectiveCliProviderStatus: (providerId: string) => ({
    codexSnapshotPending: false,
    providerStatus: {
      providerId,
      supported: true,
      authenticated: true,
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      capabilities: { oneShot: true },
      connection: { codex: { launchAllowed: true } },
    },
  }),
}));
const runStore = vi.hoisted(() => ({
  fetchCliProviderStatus: vi.fn(async () => true),
  appConfig: { general: { multimodelEnabled: true } },
}));
vi.mock('@renderer/store', () => ({
  useStore: Object.assign((selector: (state: typeof runStore) => unknown) => selector(runStore), {
    getState: () => runStore,
  }),
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
    host.querySelector<HTMLDivElement>('[data-testid="external-agent-prompt-preview"]');
  const copy = async (testId = 'external-agent-prompt-copy') => {
    await act(async () =>
      host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click()
    );
  };
  const render = async (api: ExternalAgentConnectionApi, connection = snapshot()) => {
    await act(async () =>
      root.render(
        createElement(ExternalAgentPromptDialog, {
          api,
          runApi: api.directRun,
          connection,
          isLight: false,
          onSettings: vi.fn(),
        })
      )
    );
  };

  // RED when a restored oversized task enables a native run instead of explaining its limit.
  it('keeps an oversized restored request intact with inline validation and blocks native runs until corrected', async () => {
    const oversized = 'x'.repeat(20_001);
    vi.mocked(draftStorage.loadDraft).mockResolvedValueOnce(oversized);
    const runApi = {
      getAvailability: vi.fn(async () => ({ codex: true, anthropic: true })),
      getSnapshot: vi.fn(async () => null),
      start: vi.fn(),
      cancel: vi.fn(),
    };
    await render({
      getConnectionInfo: vi.fn(async () => snapshot()),
      retryConnection: vi.fn(),
      directRun: runApi,
    });
    const task = host.querySelector<HTMLTextAreaElement>('#external-agent-task')!;
    const validation = host.querySelector('#external-agent-task-error')!;
    expect(task.value).toBe(oversized);
    expect(task.hasAttribute('maxlength')).toBe(false);
    expect(task.getAttribute('aria-invalid')).toBe('true');
    expect(task.getAttribute('aria-describedby')).toContain(validation.id);
    expect(validation.getAttribute('role')).toBe('alert');
    expect(validation.textContent).toBe(
      'Native runs support requests up to 20000 characters. Shorten the request to run it.'
    );
    expect(preview()?.textContent).toContain(oversized);
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="external-agent-run-copy"]')!.disabled
    ).toBe(false);
    await copy('external-agent-run-copy');
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0]?.[0]).toContain(oversized);
    const buttons = ['codex', 'claude'].map(
      (provider) =>
        host.querySelector<HTMLButtonElement>(`[data-testid="external-agent-run-${provider}"]`)!
    );
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      await act(async () => button.click());
    }
    expect(runApi.start).not.toHaveBeenCalled();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        task,
        'x'.repeat(20_000)
      );
      task.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelector('#external-agent-task-error')).toBeNull();
    expect(task.getAttribute('aria-invalid')).toBe('false');
    for (const button of buttons) expect(button.disabled).toBe(false);
  });

  // RED when reopening loses the owned run or textarea edits change what the active run claims to execute.
  it('recovers the active native run, blocks duplicates and cancels its immutable task after edits and reopening', async () => {
    const running: ExternalAgentRunSnapshot = {
      runId: 'sandbox-owned-run',
      providerId: 'codex',
      context: snapshot().context,
      task: 'Original sandbox management request',
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      logs: '',
      error: null,
    };
    let current = running;
    const runApi = {
      getAvailability: vi.fn(async () => ({ codex: true, anthropic: true })),
      start: vi.fn(),
      getSnapshot: vi.fn(async () => current),
      cancel: vi.fn(async () => {
        current = { ...running, status: 'cancelled', finishedAt: new Date().toISOString() };
        return current;
      }),
    };
    const api = {
      getConnectionInfo: vi.fn(async () => snapshot()),
      retryConnection: vi.fn(),
      directRun: runApi,
    };
    await render(api);
    const actions = () =>
      host.querySelector<HTMLDivElement>('[data-testid="external-agent-run-actions"]')!;
    expect(actions().textContent).toContain('Original sandbox management request');
    expect(actions().querySelector('.animate-spin')).not.toBeNull();
    for (const provider of ['codex', 'claude']) {
      const button = host.querySelector<HTMLButtonElement>(
        `[data-testid="external-agent-run-${provider}"]`
      )!;
      expect(button.disabled).toBe(true);
      await act(async () => button.click());
    }
    const task = host.querySelector<HTMLTextAreaElement>('#external-agent-task')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        task,
        'Edited request for a later run'
      );
      task.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(actions().textContent).toContain('Original sandbox management request');
    expect(actions().textContent).not.toContain('Edited request for a later run');
    await act(async () => root.render(null));
    await render(api);
    expect(actions().textContent).toContain('Original sandbox management request');
    const cancel = Array.from(actions().querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Cancel run'
    )!;
    expect(cancel.disabled).toBe(false);
    await act(async () => cancel.click());
    expect(runApi.cancel).toHaveBeenCalledWith({ runId: 'sandbox-owned-run' });
    expect(runApi.start).not.toHaveBeenCalled();
    expect(actions().textContent).toContain('Cancelled');
    expect(actions().querySelector('.animate-spin')).toBeNull();
    const otherRoot = snapshot();
    otherRoot.context = {
      ...otherRoot.context,
      dataRootFingerprint: 'another-sandbox-root',
      connectionGeneration: 2,
    };
    await render(api, otherRoot);
    expect(actions().textContent).not.toContain('Original sandbox management request');
    expect(actions().textContent).not.toContain('Cancelled');
  });

  // RED when authenticated SDK readiness enables Run despite a missing standalone native CLI.
  it('keeps Run disabled until native availability is known and reports missing Claude despite authenticated dashboard authority', async () => {
    let finishAvailability!: (value: { codex: boolean; anthropic: boolean }) => void;
    const availability = new Promise<{ codex: boolean; anthropic: boolean }>((resolve) => {
      finishAvailability = resolve;
    });
    const runApi = {
      getAvailability: vi.fn(() => availability),
      getSnapshot: vi.fn(async () => null),
      start: vi.fn(),
      cancel: vi.fn(),
    };
    await render({
      getConnectionInfo: vi.fn(async () => snapshot()),
      retryConnection: vi.fn(),
      directRun: runApi,
    });
    const codex = host.querySelector<HTMLButtonElement>(
      '[data-testid="external-agent-run-codex"]'
    )!;
    const claude = host.querySelector<HTMLButtonElement>(
      '[data-testid="external-agent-run-claude"]'
    )!;
    expect(codex.disabled).toBe(true);
    expect(claude.disabled).toBe(true);
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="external-agent-run-copy"]')!.disabled
    ).toBe(false);
    await act(async () => finishAvailability({ codex: true, anthropic: false }));
    expect(codex.disabled).toBe(false);
    expect(claude.disabled).toBe(true);
    expect(host.textContent).toContain('Claude Code is unavailable.');
    await act(async () => claude.click());
    expect(runApi.start).not.toHaveBeenCalled();
    expect(runApi.getAvailability).toHaveBeenCalledOnce();
    await copy('external-agent-run-copy');
    expect(writeText).toHaveBeenCalledOnce();
  });

  // RED when the two copy entrypoints start separate writes or disagree about busy/copied state.
  it('shares busy and copied feedback between preview and run-area copy actions', async () => {
    let finishWrite!: () => void;
    writeText.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        })
    );
    const api = {
      getConnectionInfo: vi.fn(async () => snapshot()),
      retryConnection: vi.fn(),
      directRun: {
        getAvailability: vi.fn(async () => ({ codex: false, anthropic: false })),
        getSnapshot: vi.fn(async () => null),
        start: vi.fn(),
        cancel: vi.fn(),
      },
    };
    await render(api);
    const copyButtons = ['external-agent-prompt-copy', 'external-agent-run-copy'].map(
      (testId) => host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!
    );
    expect(copyButtons.every((button) => !button.disabled)).toBe(true);
    await copy('external-agent-run-copy');
    for (const button of copyButtons) {
      expect(button.disabled).toBe(true);
      expect(button.textContent).toBe('Copying...');
    }
    await copy();
    expect(api.getConnectionInfo).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledOnce();
    await act(async () => finishWrite());
    for (const button of copyButtons) {
      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe('Copied');
    }
    expect(writeText.mock.calls[0]?.[0]).toBe(preview()?.textContent);
    const task = host.querySelector<HTMLTextAreaElement>('#external-agent-task')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        task,
        'Another sandbox request'
      );
      task.dispatchEvent(new Event('input', { bubbles: true }));
    });
    for (const button of copyButtons) expect(button.textContent).toBe('Copy prompt for agent');
    expect(api.directRun.start).not.toHaveBeenCalled();
  });

  // RED when the final prompt requires reveal, follows the templates, or has a detached copy action.
  it('shows the selectable final prompt immediately after the request with its copy action before templates', async () => {
    await render({
      getConnectionInfo: vi.fn().mockResolvedValue(snapshot()),
      retryConnection: vi.fn(),
    });
    const task = host.querySelector<HTMLTextAreaElement>('#external-agent-task')!;
    const finalPrompt = preview();
    expect(finalPrompt).not.toBeNull();
    expect(finalPrompt?.tagName).toBe('DIV');
    expect(finalPrompt?.hasAttribute('contenteditable')).toBe(false);
    expect(finalPrompt?.getAttribute('role')).toBe('region');
    expect(finalPrompt?.tabIndex).toBe(0);
    expect(finalPrompt?.textContent).toContain('Create a review team for the sandbox');
    const promptSection = task.parentElement?.nextElementSibling;
    expect(promptSection?.contains(finalPrompt)).toBe(true);
    const label = promptSection?.querySelector('label');
    expect(finalPrompt?.getAttribute('aria-labelledby')).toBe(label?.id);
    expect(
      label?.parentElement?.querySelector('[data-testid="external-agent-prompt-copy"]')
    ).not.toBeNull();
    const templates = host.querySelector('section');
    expect(promptSection?.nextElementSibling).toBe(templates);
    expect(finalPrompt?.closest('[data-state="closed"]')).toBeNull();
  });

  // RED when rosters start expanded, repeat participant roles or replace read-only responsibilities.
  it('starts all eight template rosters collapsed and shows each role once with read-only responsibilities', async () => {
    await render({
      getConnectionInfo: vi.fn().mockResolvedValue(snapshot()),
      retryConnection: vi.fn(),
    });
    const templates = Array.from(host.querySelectorAll('[data-template-reference]'));
    expect(templates).toHaveLength(8);
    for (const template of templates) {
      expect(template.getAttribute('data-state')).toBe('closed');
      expect(template.querySelector('[data-role="template-participant"]')).toBeNull();
    }
    const header = templates[0].querySelector<HTMLButtonElement>('button')!;
    expect(header.getAttribute('aria-expanded')).toBe('false');
    await act(async () => header.click());
    expect(header.getAttribute('aria-expanded')).toBe('true');
    const participants = templates[0].querySelectorAll('[data-role="template-participant"]');
    expect(participants).toHaveLength(4);
    expect(participants[0].textContent).not.toContain('team-lead');
    expect(participants[0].textContent?.match(/Coordinator/g)).toHaveLength(1);
    const designer = participants[1];
    expect(designer.textContent?.match(/Product Designer/g)).toHaveLength(1);
    expect(designer.textContent).not.toContain('designer');
    expect(designer.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(designer.querySelector('input, textarea, select, [contenteditable="true"]')).toBeNull();
    const responsibilities = designer.querySelector<HTMLButtonElement>('button')!;
    expect(responsibilities.getAttribute('aria-label')).toBe(
      'Responsibilities for Product Designer'
    );
    expect(responsibilities.getAttribute('aria-expanded')).toBe('false');
    expect(designer.textContent).not.toContain('Turn user needs into clear flows');
    await act(async () => responsibilities.click());
    expect(responsibilities.getAttribute('aria-expanded')).toBe('true');
    expect(designer.textContent).toContain('Turn user needs into clear flows');
    expect(designer.querySelector('input, textarea, select, [contenteditable="true"]')).toBeNull();
    await act(async () => header.click());
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(templates[0].querySelector('[data-role="template-participant"]')).toBeNull();
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
      expect(preview()?.textContent).toContain('http://127.0.0.1:43001/mcp');
      await copy();
      expect(preview()?.textContent).toBe(
        'Enter a request to see the final prompt. A ready MCP connection is required.'
      );
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
    expect(preview()?.textContent).toContain('Create another team for this sandbox');
    const foreign = snapshot();
    foreign.context.dataRootFingerprint = 'another-root';
    await act(async () => finishRead(foreign));
    expect(preview()?.textContent).toBe(
      'Enter a request to see the final prompt. A ready MCP connection is required.'
    );
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
      directRun: {
        getAvailability: vi.fn(async () => ({ codex: false, anthropic: false })),
        getSnapshot: vi.fn(async () => null),
        start: vi.fn(),
        cancel: vi.fn(),
      },
    };
    await render(api);
    await copy('external-agent-run-copy');
    expect(preview()?.textContent).toBe(
      'Enter a request to see the final prompt. A ready MCP connection is required.'
    );
    writeText.mockRejectedValueOnce(new Error('Clipboard denied'));
    await copy('external-agent-run-copy');
    const freshPrompt = writeText.mock.calls[0]?.[0];
    expect(freshPrompt).toContain('http://127.0.0.1:43003/mcp');
    expect(preview()?.textContent).toBe(freshPrompt);
    expect(host.textContent).toContain(
      'Clipboard write failed. Select and copy the final prompt manually.'
    );
    for (const modifier of ['ctrlKey', 'metaKey']) {
      preview()!.focus();
      const shortcut = new KeyboardEvent('keydown', {
        key: 'a',
        [modifier]: true,
        bubbles: true,
        cancelable: true,
      });
      preview()!.dispatchEvent(shortcut);
      expect(shortcut.defaultPrevented).toBe(true);
      expect(window.getSelection()?.toString()).toBe(freshPrompt);
    }
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
    // RED if missing project selection blocks saving a new draft again.
    expect(prompt).toContain(
      'If the user has not supplied a project path, create and save the requested new draft with cwd omitted; do not ask for a project path before saving it.'
    );
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
