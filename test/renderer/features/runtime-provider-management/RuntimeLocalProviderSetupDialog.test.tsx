import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listLocalProviders: vi.fn(),
  scanLocalProviders: vi.fn(),
  probeLocalProvider: vi.fn(),
  configureLocalProvider: vi.fn(),
  testModel: vi.fn(),
  prepareProvisioning: vi.fn(),
  selectFolders: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    runtimeProviderManagement: {
      listLocalProviders: mocks.listLocalProviders,
      scanLocalProviders: mocks.scanLocalProviders,
      probeLocalProvider: mocks.probeLocalProvider,
      configureLocalProvider: mocks.configureLocalProvider,
      testModel: mocks.testModel,
    },
    teams: {
      prepareProvisioning: mocks.prepareProvisioning,
    },
    config: {
      selectFolders: mocks.selectFolders,
    },
  },
}));

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) =>
    open ? React.createElement('div', null, children) : null,
  DialogContent: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
  DialogDescription: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
  DialogFooter: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
  DialogHeader: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
  DialogTitle: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
}));

import { RuntimeLocalProviderSetupDialog } from '../../../../src/features/runtime-provider-management/renderer/RuntimeLocalProviderSetupDialog';

const ollamaProbe = {
  preset: {
    id: 'ollama' as const,
    providerId: 'ollama',
    displayName: 'Ollama',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    description: 'Use local Ollama.',
    scannable: true,
  },
  providerId: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  state: 'available' as const,
  models: [{ id: 'qwen3:8b', displayName: 'qwen3:8b' }],
  latencyMs: 10,
  message: 'Connected. Found 1 model.',
};

const setInputValue = (input: HTMLInputElement, value: string): void => {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const selectAvailabilityScope = async (
  host: HTMLElement,
  label: 'All projects' | 'Select project'
): Promise<void> => {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(
    (candidate) => candidate.textContent?.trim() === label
  );
  expect(button).toBeDefined();
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
};

describe('RuntimeLocalProviderSetupDialog', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.listLocalProviders.mockReset();
    mocks.scanLocalProviders.mockReset();
    mocks.probeLocalProvider.mockReset();
    mocks.configureLocalProvider.mockReset();
    mocks.testModel.mockReset();
    mocks.prepareProvisioning.mockReset();
    mocks.selectFolders.mockReset();
    mocks.selectFolders.mockResolvedValue([]);
    mocks.listLocalProviders.mockImplementation(async (input: { scope: 'global' | 'project' }) => ({
      schemaVersion: 1,
      runtimeId: 'opencode',
      scope: input.scope,
      projectPath: input.scope === 'project' ? '/tmp/sandbox' : undefined,
      configPath:
        input.scope === 'project'
          ? '/tmp/sandbox/opencode.json'
          : '/Users/test/.config/opencode/opencode.json',
      providers: [],
    }));
    mocks.scanLocalProviders.mockResolvedValue({
      schemaVersion: 1,
      runtimeId: 'opencode',
      probes: [ollamaProbe],
    });
    mocks.configureLocalProvider.mockResolvedValue({
      schemaVersion: 1,
      runtimeId: 'opencode',
      configuration: {
        providerId: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelIds: ['qwen3:8b'],
        defaultModelId: 'qwen3:8b',
        modelRoute: 'ollama/qwen3:8b',
        configPath: '/Users/test/.config/opencode/opencode.json',
        scope: 'global',
        setAsDefault: true,
      },
    });
    mocks.testModel.mockResolvedValue({
      schemaVersion: 1,
      runtimeId: 'opencode',
      result: {
        providerId: 'ollama',
        modelId: 'ollama/qwen3:8b',
        ok: true,
        availability: 'available',
        message: 'Model probe passed',
        diagnostics: [],
      },
    });
    mocks.prepareProvisioning.mockResolvedValue({
      ready: true,
      message: 'OpenCode model is ready for Agent Teams launch.',
      details: ['Agent Teams tool coordination and runtime capacity verified.'],
      warnings: [],
      issues: [],
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('keeps Scope neutral until a local server connection is verified', async () => {
    mocks.scanLocalProviders.mockResolvedValue({
      schemaVersion: 1,
      runtimeId: 'opencode',
      probes: [],
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <RuntimeLocalProviderSetupDialog
          open
          onOpenChange={vi.fn()}
          projectPath={null}
          projects={[]}
          onProjectPathChange={vi.fn()}
          onConfigured={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(host.textContent).toContain('No local server found automatically');
    });
    const progress = host.querySelector('[aria-label="Local model setup progress"]');
    expect(progress?.textContent).toContain('1Server2Scope3Model');
    expect(progress?.querySelector('[aria-label="Scope"]')).not.toBeNull();
    expect(progress?.querySelector('[aria-label="Scope complete"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('defaults to all projects, writes global config, and runs OpenCode verification', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onConfigured = vi.fn(async () => undefined);

    await act(async () => {
      root.render(
        <RuntimeLocalProviderSetupDialog
          open
          onOpenChange={vi.fn()}
          projectPath="/tmp/sandbox"
          projects={[]}
          onProjectPathChange={vi.fn()}
          onConfigured={onConfigured}
        />
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain('Ollama connected');
      expect(host.textContent).toContain('1 model found');
    });
    expect(host.querySelector('[data-layout="flat-workspace"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Local model setup progress"]')?.textContent).toContain(
      'ServerScopeModel'
    );
    const flatSteps = Array.from(
      host.querySelectorAll<HTMLElement>('[data-testid^="runtime-local-provider-step-"]')
    );
    expect(flatSteps).toHaveLength(3);
    expect(flatSteps.every((step) => !step.className.includes('rounded-lg'))).toBe(true);
    expect(host.textContent).toContain('All projects');
    expect(host.textContent).toContain('Select project');
    expect(host.textContent).toContain('~/.config/opencode/opencode.json');
    expect(host.textContent).toContain('We will update your global OpenCode config.');
    expect(host.textContent).toContain('Local model');
    expect(host.textContent).toContain(
      'This replaces the current global default and lightweight-task model.'
    );

    const configureButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save & verify')
    );
    expect(configureButton?.disabled).toBe(false);

    await act(async () => {
      configureButton?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain(
        'OpenCode ran qwen3:8b, and the Agent Teams launch preflight passed.'
      );
      expect(host.textContent).toContain(
        'Saved globally. Every project can use this provider unless its own config overrides it.'
      );
      expect(host.textContent).toContain('/Users/test/.config/opencode/opencode.json');
    });

    expect(mocks.configureLocalProvider).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      scope: 'global',
      projectPath: null,
      presetId: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      providerId: 'ollama',
      defaultModelId: 'qwen3:8b',
      setAsDefault: true,
    });
    expect(mocks.listLocalProviders).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      scope: 'global',
      projectPath: null,
    });
    expect(onConfigured).toHaveBeenCalledTimes(1);
    expect(mocks.testModel).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      projectPath: null,
      providerId: 'ollama',
      modelId: 'ollama/qwen3:8b',
    });
    expect(mocks.prepareProvisioning).toHaveBeenCalledWith(
      '/Users/test/.config/opencode',
      'opencode',
      ['opencode'],
      ['ollama/qwen3:8b'],
      false,
      'deep'
    );
  });

  it('replaces the empty scan status after a manual connection succeeds', async () => {
    mocks.scanLocalProviders.mockResolvedValue({
      schemaVersion: 1,
      runtimeId: 'opencode',
      probes: [],
    });
    mocks.probeLocalProvider.mockResolvedValue({
      schemaVersion: 1,
      runtimeId: 'opencode',
      probe: ollamaProbe,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <RuntimeLocalProviderSetupDialog
          open
          onOpenChange={vi.fn()}
          projectPath="/tmp/sandbox"
          projects={[]}
          onProjectPathChange={vi.fn()}
          onConfigured={vi.fn()}
        />
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain('No local server found automatically.');
    });

    const testButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Test connection'
    );
    await act(async () => {
      testButton?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain('Ollama connected');
      expect(host.textContent).toContain('1 model found');
      expect(host.textContent).not.toContain('No local server found automatically.');
    });
  });

  it('lets the user choose any project folder from the setup flow', async () => {
    mocks.selectFolders.mockResolvedValue(['/Users/test/local-model-project']);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onProjectPathChange = vi.fn();

    await act(async () => {
      root.render(
        <RuntimeLocalProviderSetupDialog
          open
          onOpenChange={vi.fn()}
          projectPath={null}
          projects={[]}
          onProjectPathChange={onProjectPathChange}
          onConfigured={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    await selectAvailabilityScope(host, 'Select project');

    const chooseFolderButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Choose folder'
    );
    await act(async () => {
      chooseFolderButton?.click();
      await Promise.resolve();
    });

    expect(mocks.selectFolders).toHaveBeenCalledTimes(1);
    expect(onProjectPathChange).toHaveBeenCalledWith('/Users/test/local-model-project');
  });

  it('searches recent projects by name or path before selecting one', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onProjectPathChange = vi.fn();

    await act(async () => {
      root.render(
        <RuntimeLocalProviderSetupDialog
          open
          onOpenChange={vi.fn()}
          projectPath={null}
          projects={[
            {
              id: 'agent-teams',
              name: 'Agent Teams',
              path: '/Users/test/dev/agent-teams',
              sessions: [],
              createdAt: 1,
            },
            {
              id: 'voice-notes',
              name: 'Voice Notes',
              path: '/Users/test/archive/voice-notes',
              sessions: [],
              createdAt: 1,
            },
          ]}
          onProjectPathChange={onProjectPathChange}
          onConfigured={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    await selectAvailabilityScope(host, 'Select project');

    const projectTrigger = host.querySelector<HTMLButtonElement>(
      '#runtime-local-provider-manager-project'
    );
    expect(projectTrigger?.getAttribute('role')).toBe('combobox');

    await act(async () => {
      projectTrigger?.click();
      await Promise.resolve();
    });

    const searchInput = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Search projects..."]'
    );
    expect(searchInput).not.toBeNull();

    await act(async () => {
      setInputValue(searchInput!, 'archive');
      await Promise.resolve();
    });

    const projectList = document.body.querySelector<HTMLElement>('[cmdk-list]');
    expect(projectList?.textContent).toContain('Voice Notes');
    expect(projectList?.textContent).toContain('/Users/test/archive/voice-notes');
    expect(projectList?.textContent).not.toContain('Agent Teams');

    const voiceNotesOption = Array.from(
      projectList?.querySelectorAll<HTMLElement>('[cmdk-item]') ?? []
    ).find((item) => item.textContent?.includes('Voice Notes'));
    await act(async () => {
      voiceNotesOption?.click();
      await Promise.resolve();
    });

    expect(onProjectPathChange).toHaveBeenCalledWith('/Users/test/archive/voice-notes');
  });

  it('shows all configured local providers and supports clear add and edit flows', async () => {
    mocks.listLocalProviders.mockResolvedValue({
      schemaVersion: 1,
      runtimeId: 'opencode',
      scope: 'global',
      configPath: '/Users/test/.config/opencode/opencode.json',
      providers: [
        {
          preset: ollamaProbe.preset,
          providerId: 'ollama',
          baseUrl: 'http://127.0.0.1:11434/v1',
          configuredModelIds: ['qwen3:8b'],
          defaultModelId: 'qwen3:8b',
          isDefault: true,
          state: 'available',
          liveModels: ollamaProbe.models,
          latencyMs: 10,
          message: 'Connected.',
        },
        {
          preset: {
            id: 'lm-studio' as const,
            providerId: 'lmstudio',
            displayName: 'LM Studio',
            defaultBaseUrl: 'http://127.0.0.1:1234/v1',
            description: 'Connect to LM Studio.',
            scannable: true,
          },
          providerId: 'lmstudio',
          baseUrl: 'http://127.0.0.1:1234/v1',
          configuredModelIds: ['gemma-3'],
          defaultModelId: 'gemma-3',
          isDefault: false,
          state: 'unavailable',
          liveModels: [],
          latencyMs: 8,
          message: 'Could not reach the local server.',
        },
      ],
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <RuntimeLocalProviderSetupDialog
          open
          onOpenChange={vi.fn()}
          projectPath="/tmp/sandbox"
          projects={[]}
          onProjectPathChange={vi.fn()}
          onConfigured={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(host.textContent).toContain('Local providers');
      expect(host.textContent).toContain('1 of 2 local providers running.');
      expect(host.textContent).toContain('Offline providers remain configured but cannot launch.');
      expect(host.textContent).toContain('Global default');
      expect(host.textContent).toContain('Offline');
      expect(host.textContent).toContain('1 configured model');
    });
    expect(host.querySelector('[data-testid="configured-local-provider-ollama"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="configured-local-provider-lmstudio"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="local-provider-logo-ollama"] img')).not.toBeNull();
    expect(host.querySelector('[data-testid="local-provider-logo-lm-studio"] img')).not.toBeNull();

    const editLmStudio = Array.from(host.querySelectorAll('button')).find(
      (button) =>
        button.textContent?.trim() === 'Edit' &&
        button.closest('[data-testid="configured-local-provider-lmstudio"]')
    );
    await act(async () => {
      editLmStudio?.click();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Edit LM Studio');
    expect(host.querySelector<HTMLInputElement>('#runtime-local-provider-url')?.value).toBe(
      'http://127.0.0.1:1234/v1'
    );
    expect(
      host.querySelector('#runtime-local-provider-project-default')?.getAttribute('data-state')
    ).toBe('unchecked');

    const backButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Back to providers')
    );
    await act(async () => {
      backButton?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.textContent).toContain('Configured providers'));

    const addButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Add provider'
    );
    await act(async () => {
      addButton?.click();
      await Promise.resolve();
    });
    expect(host.textContent).toContain('Add a local provider');
    expect(host.textContent).toContain('Atomic Chat');
    expect(
      host.querySelector('#runtime-local-provider-project-default')?.getAttribute('data-state')
    ).toBe('unchecked');

    const serverAppTrigger = host.querySelector<HTMLButtonElement>(
      '#runtime-local-provider-preset'
    );
    await act(async () => {
      serverAppTrigger?.click();
      await Promise.resolve();
    });
    for (const presetId of ['ollama', 'lm-studio', 'atomic-chat', 'llama.cpp']) {
      expect(
        document.body.querySelector(`[data-testid="local-provider-logo-${presetId}"] img`)
      ).not.toBeNull();
    }
    expect(
      document.body.querySelector('[data-testid="local-provider-logo-custom"] svg')
    ).not.toBeNull();
  });

  it('does not let a deleted project proceed to configuration', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onProjectPathChange = vi.fn();
    const deletedProjectPath = '/Users/test/deleted-project';

    await act(async () => {
      root.render(
        <RuntimeLocalProviderSetupDialog
          open
          onOpenChange={vi.fn()}
          projectPath={deletedProjectPath}
          projects={[
            {
              id: 'deleted-project',
              name: 'Deleted project',
              path: deletedProjectPath,
              sessions: [],
              createdAt: 1,
              filesystemState: 'deleted',
            },
          ]}
          onProjectPathChange={onProjectPathChange}
          onConfigured={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    await selectAvailabilityScope(host, 'Select project');

    await vi.waitFor(() => {
      expect(host.textContent).toContain('Ollama connected');
      expect(host.textContent).toContain('This project folder is no longer available.');
    });
    const saveButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save & verify')
    );
    expect(saveButton?.disabled).toBe(true);

    const projectTrigger = host.querySelector<HTMLButtonElement>('#runtime-local-provider-project');
    await act(async () => {
      projectTrigger?.click();
      await Promise.resolve();
    });
    const deletedOption = Array.from(
      document.body.querySelectorAll<HTMLElement>('[cmdk-item]')
    ).find((item) => item.textContent?.includes('Deleted project'));
    expect(deletedOption?.getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      deletedOption?.click();
      await Promise.resolve();
    });
    expect(onProjectPathChange).not.toHaveBeenCalled();
    expect(mocks.configureLocalProvider).not.toHaveBeenCalled();
  });

  it('accepts a restored project when the same folder is chosen explicitly', async () => {
    const deletedProjectPath = '/Users/test/restored-project';
    mocks.selectFolders.mockResolvedValue([deletedProjectPath]);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onProjectPathChange = vi.fn();

    await act(async () => {
      root.render(
        <RuntimeLocalProviderSetupDialog
          open
          onOpenChange={vi.fn()}
          projectPath={deletedProjectPath}
          projects={[
            {
              id: 'restored-project',
              name: 'Restored project',
              path: deletedProjectPath,
              sessions: [],
              createdAt: 1,
              filesystemState: 'deleted',
            },
          ]}
          onProjectPathChange={onProjectPathChange}
          onConfigured={vi.fn()}
        />
      );
      await Promise.resolve();
    });
    await selectAvailabilityScope(host, 'Select project');
    await vi.waitFor(() => {
      expect(host.textContent).toContain('This project folder is no longer available.');
    });

    const chooseFolderButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Choose folder'
    );
    await act(async () => {
      chooseFolderButton?.click();
      await Promise.resolve();
    });

    expect(onProjectPathChange).toHaveBeenCalledWith(deletedProjectPath);
    expect(host.textContent).not.toContain('This project folder is no longer available.');
    const saveButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save & verify')
    );
    expect(saveButton?.disabled).toBe(false);

    const projectTrigger = host.querySelector<HTMLButtonElement>('#runtime-local-provider-project');
    await act(async () => {
      projectTrigger?.click();
      await Promise.resolve();
    });
    const restoredOption = Array.from(
      document.body.querySelectorAll<HTMLElement>('[cmdk-item]')
    ).find((item) => item.textContent?.includes('Restored project'));
    expect(restoredOption?.getAttribute('aria-disabled')).toBe('false');
  });

  it('adds a secondary provider without changing project defaults when requested', async () => {
    mocks.configureLocalProvider.mockResolvedValueOnce({
      schemaVersion: 1,
      runtimeId: 'opencode',
      configuration: {
        providerId: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelIds: ['qwen3:8b'],
        defaultModelId: 'qwen3:8b',
        modelRoute: 'ollama/qwen3:8b',
        configPath: '/tmp/sandbox/opencode.json',
        scope: 'project',
        setAsDefault: false,
      },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <RuntimeLocalProviderSetupDialog
          open
          onOpenChange={vi.fn()}
          projectPath="/tmp/sandbox"
          projects={[]}
          onProjectPathChange={vi.fn()}
          onConfigured={vi.fn(async () => undefined)}
        />
      );
      await Promise.resolve();
    });
    await selectAvailabilityScope(host, 'Select project');
    await vi.waitFor(() => {
      expect(host.textContent).toContain('Ollama connected');
    });

    const defaultCheckbox = host.querySelector<HTMLElement>(
      '#runtime-local-provider-project-default'
    );
    await act(async () => {
      defaultCheckbox?.click();
      await Promise.resolve();
    });
    expect(host.textContent).toContain(
      'This provider will be added without changing the current project defaults.'
    );

    const saveButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save & verify')
    );
    await act(async () => {
      saveButton?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain('Existing project defaults were preserved.');
      expect(host.textContent).toContain(
        'OpenCode ran qwen3:8b, and the Agent Teams launch preflight passed.'
      );
    });
    expect(mocks.configureLocalProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'project',
        projectPath: '/tmp/sandbox',
        setAsDefault: false,
      })
    );
  });

  it('does not mark setup ready when the deep Agent Teams preflight blocks the model', async () => {
    mocks.prepareProvisioning.mockResolvedValueOnce({
      ready: false,
      message: 'OpenCode model preflight failed.',
      issues: [
        {
          providerId: 'opencode',
          modelId: 'ollama/qwen3:8b',
          scope: 'model',
          severity: 'blocking',
          code: 'local_context_too_small',
          message:
            'Ollama is running ollama/qwen3:8b with 4K context. Agent Teams requires at least 16K.',
        },
      ],
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <RuntimeLocalProviderSetupDialog
          open
          onOpenChange={vi.fn()}
          projectPath="/tmp/sandbox"
          projects={[]}
          onProjectPathChange={vi.fn()}
          onConfigured={vi.fn(async () => undefined)}
        />
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain('Ollama connected');
    });

    const saveButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save & verify')
    );
    await act(async () => {
      saveButton?.click();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(host.textContent).toContain('Setup saved, but the model check needs attention.');
      expect(host.textContent).toContain('Agent Teams requires at least 16K.');
      expect(host.textContent).not.toContain('Your local model is ready for Agent Teams.');
    });
    expect(mocks.testModel).not.toHaveBeenCalled();
  });

  it('does not claim execution verification passed while the request is still running', async () => {
    let resolveVerification: ((value: Awaited<ReturnType<typeof mocks.testModel>>) => void) | null =
      null;
    mocks.testModel.mockReturnValue(
      new Promise((resolve) => {
        resolveVerification = resolve;
      })
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <RuntimeLocalProviderSetupDialog
          open
          onOpenChange={vi.fn()}
          projectPath="/tmp/sandbox"
          projects={[]}
          onProjectPathChange={vi.fn()}
          onConfigured={vi.fn(async () => undefined)}
        />
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain('Ollama connected');
      expect(host.textContent).toContain('1 model found');
    });

    const configureButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save & verify')
    );
    await act(async () => {
      configureButton?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain(
        'Testing qwen3:8b tools and runtime capacity through OpenCode...'
      );
      expect(host.textContent).not.toContain(
        'OpenCode ran qwen3:8b, and the Agent Teams launch preflight passed.'
      );
    });

    await act(async () => {
      resolveVerification?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
        result: {
          providerId: 'ollama',
          modelId: 'ollama/qwen3:8b',
          ok: true,
          availability: 'available',
          message: 'Model probe passed',
          diagnostics: [],
        },
      });
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain(
        'OpenCode ran qwen3:8b, and the Agent Teams launch preflight passed.'
      );
    });
  });

  it('automatically retries once when the new provider has not reached the OpenCode catalog yet', async () => {
    mocks.testModel
      .mockResolvedValueOnce({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: {
          code: 'model-missing',
          message: 'Model is not in the catalog yet.',
          recoverable: true,
        },
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        runtimeId: 'opencode',
        result: {
          providerId: 'ollama',
          modelId: 'ollama/qwen3:8b',
          ok: true,
          availability: 'available',
          message: 'Model probe passed',
          diagnostics: [],
        },
      });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onConfigured = vi.fn(async () => undefined);

    await act(async () => {
      root.render(
        <RuntimeLocalProviderSetupDialog
          open
          onOpenChange={vi.fn()}
          projectPath="/tmp/sandbox"
          projects={[]}
          onProjectPathChange={vi.fn()}
          onConfigured={onConfigured}
        />
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(host.textContent).toContain('Ollama connected'));

    const saveButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save & verify')
    );
    await act(async () => {
      saveButton?.click();
      await new Promise((resolve) => window.setTimeout(resolve, 850));
    });

    await vi.waitFor(
      () => {
        expect(host.textContent).toContain('Your local model is ready for Agent Teams.');
        expect(host.textContent).not.toContain('needs attention');
      },
      { timeout: 3_000 }
    );
    expect(mocks.testModel).toHaveBeenCalledTimes(2);
    expect(onConfigured).toHaveBeenCalledTimes(2);
  });

  it('does not let a late automatic scan overwrite a manually entered server address', async () => {
    let resolveScan: ((value: unknown) => void) | null = null;
    mocks.scanLocalProviders.mockReturnValue(
      new Promise((resolve) => {
        resolveScan = resolve;
      })
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <RuntimeLocalProviderSetupDialog
          open
          onOpenChange={vi.fn()}
          projectPath="/tmp/sandbox"
          projects={[]}
          onProjectPathChange={vi.fn()}
          onConfigured={vi.fn()}
        />
      );
    });

    const addressInput = host.querySelector<HTMLInputElement>('#runtime-local-provider-url');
    expect(addressInput).not.toBeNull();
    await act(async () => {
      setInputValue(addressInput!, 'http://127.0.0.1:9999/v1');
      await Promise.resolve();
    });

    await act(async () => {
      resolveScan?.({ schemaVersion: 1, runtimeId: 'opencode', probes: [ollamaProbe] });
      await Promise.resolve();
    });

    expect(addressInput?.value).toBe('http://127.0.0.1:9999/v1');
    expect(host.textContent).not.toContain('Ollama connected');
  });

  it('explains how to recover when the server has no loaded models', async () => {
    mocks.scanLocalProviders.mockResolvedValue({
      schemaVersion: 1,
      runtimeId: 'opencode',
      probes: [
        {
          ...ollamaProbe,
          models: [],
          message: 'Connected, but the server did not report any loaded models.',
        },
      ],
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <RuntimeLocalProviderSetupDialog
          open
          onOpenChange={vi.fn()}
          projectPath="/tmp/sandbox"
          projects={[]}
          onProjectPathChange={vi.fn()}
          onConfigured={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(host.textContent).toContain('The server is running, but no models are loaded.');
      expect(host.textContent).toContain('at least one model has been pulled locally');
      expect(host.textContent).toContain('Load a model in Ollama, then refresh the model list.');
    });
    const saveButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save & verify')
    );
    expect(saveButton?.disabled).toBe(true);
    expect(
      Array.from(host.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === 'Refresh models'
      )
    ).toBe(true);
  });

  it('retries verification without writing the project config a second time', async () => {
    mocks.testModel
      .mockResolvedValueOnce({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: {
          code: 'model-test-failed',
          message:
            'Technical command timed out after 90000ms with /very/long/private/path and internal runtime diagnostics.',
          recoverable: true,
        },
      })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        runtimeId: 'opencode',
        result: {
          providerId: 'ollama',
          modelId: 'ollama/qwen3:8b',
          ok: true,
          availability: 'available',
          message: 'Model probe passed',
          diagnostics: [],
        },
      });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <RuntimeLocalProviderSetupDialog
          open
          onOpenChange={vi.fn()}
          projectPath="/tmp/sandbox"
          projects={[]}
          onProjectPathChange={vi.fn()}
          onConfigured={vi.fn(async () => undefined)}
        />
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain('Ollama connected');
      expect(host.textContent).toContain('1 model found');
    });

    const saveButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save & verify')
    );
    await act(async () => {
      saveButton?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain('Setup saved, but the model check needs attention.');
      expect(host.textContent).toContain(
        'OpenCode could not get a response from Ollama. Make sure the server and selected model are running, then retry.'
      );
      expect(host.textContent).not.toContain('/very/long/private/path');
    });

    const retryButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Retry verification'
    );
    expect(retryButton).toBeDefined();
    await act(async () => {
      retryButton?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain('Your local model is ready for Agent Teams.');
      expect(host.textContent).toContain(
        'OpenCode ran qwen3:8b, and the Agent Teams launch preflight passed.'
      );
    });
    expect(mocks.configureLocalProvider).toHaveBeenCalledTimes(1);
    expect(mocks.testModel).toHaveBeenCalledTimes(2);
  });

  it('allows closing while a safe connection probe is still running', async () => {
    mocks.scanLocalProviders.mockResolvedValue({
      schemaVersion: 1,
      runtimeId: 'opencode',
      probes: [],
    });
    let resolveProbe: ((value: unknown) => void) | null = null;
    mocks.probeLocalProvider.mockReturnValue(
      new Promise((resolve) => {
        resolveProbe = resolve;
      })
    );
    const onOpenChange = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <RuntimeLocalProviderSetupDialog
          open
          onOpenChange={onOpenChange}
          projectPath="/tmp/sandbox"
          projects={[]}
          onProjectPathChange={vi.fn()}
          onConfigured={vi.fn()}
        />
      );
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain('No local server found automatically.');
    });

    const testButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Test connection'
    );
    await act(async () => {
      testButton?.click();
      await Promise.resolve();
    });
    const cancelButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Cancel'
    );
    expect(cancelButton?.disabled).toBe(false);
    await act(async () => {
      cancelButton?.click();
      await Promise.resolve();
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);

    await act(async () => {
      resolveProbe?.({ schemaVersion: 1, runtimeId: 'opencode', probe: ollamaProbe });
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain('Ollama connected');
  });
});
