import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  scanLocalProviders: vi.fn(),
  probeLocalProvider: vi.fn(),
  configureLocalProvider: vi.fn(),
  testModel: vi.fn(),
  selectFolders: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    runtimeProviderManagement: {
      scanLocalProviders: mocks.scanLocalProviders,
      probeLocalProvider: mocks.probeLocalProvider,
      configureLocalProvider: mocks.configureLocalProvider,
      testModel: mocks.testModel,
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

describe('RuntimeLocalProviderSetupDialog', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.scanLocalProviders.mockReset();
    mocks.probeLocalProvider.mockReset();
    mocks.configureLocalProvider.mockReset();
    mocks.testModel.mockReset();
    mocks.selectFolders.mockReset();
    mocks.selectFolders.mockResolvedValue([]);
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
        configPath: '/tmp/sandbox/opencode.json',
        setAsProjectDefault: true,
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
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('auto-detects a server, writes project config, and runs OpenCode verification', async () => {
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
      expect(host.textContent).toContain('Connected to Ollama');
    });
    expect(host.textContent).toContain('Project that will use this model');
    expect(host.textContent).toContain('/tmp/sandbox/opencode.json');
    expect(host.textContent).toContain("Other projects and global settings won't change.");
    expect(host.textContent).toContain('No manual editing is needed.');
    expect(host.textContent).toContain('Local model');

    const configureButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save setup and verify')
    );
    expect(configureButton?.disabled).toBe(false);

    await act(async () => {
      configureButton?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain('OpenCode successfully ran qwen3:8b.');
    });

    expect(mocks.configureLocalProvider).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      projectPath: '/tmp/sandbox',
      presetId: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      providerId: 'ollama',
      defaultModelId: 'qwen3:8b',
      setAsProjectDefault: true,
    });
    expect(onConfigured).toHaveBeenCalledTimes(1);
    expect(mocks.testModel).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      projectPath: '/tmp/sandbox',
      providerId: 'ollama',
      modelId: 'ollama/qwen3:8b',
    });
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
      expect(host.textContent).toContain('Connected to Ollama');
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
      expect(host.textContent).toContain('Connected to Ollama');
    });

    const configureButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Save setup and verify')
    );
    await act(async () => {
      configureButton?.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain('Testing qwen3:8b through OpenCode...');
      expect(host.textContent).not.toContain('OpenCode successfully ran qwen3:8b.');
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
      expect(host.textContent).toContain('OpenCode successfully ran qwen3:8b.');
    });
  });
});
