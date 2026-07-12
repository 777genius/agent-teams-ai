import { describe, expect, it, vi } from 'vitest';

import { CursorAgentCompanionService } from '../infrastructure/CursorAgentCompanionService';
import { KiroCliCompanionService } from '../infrastructure/KiroCliCompanionService';

import { createRuntimeProviderManagementFeature } from './createRuntimeProviderManagementFeature';

import type { RuntimeProviderManagementPort } from '../../core/application';

describe('createRuntimeProviderManagementFeature companion flow', () => {
  it('verifies kiro/auto through OpenCode before reporting connected', async () => {
    const testModel = vi.fn(async () => ({
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      result: {
        providerId: 'kiro',
        modelId: 'kiro/auto',
        ok: true,
        availability: 'available' as const,
        message: 'Kiro verification completed.',
        diagnostics: [],
      },
    }));
    const unsupported = vi.fn(async () => {
      throw new Error('not used');
    });
    const port: RuntimeProviderManagementPort = {
      loadView: unsupported,
      loadProviderDirectory: unsupported,
      loadSetupForm: unsupported,
      connectProvider: unsupported,
      connectWithApiKey: unsupported,
      forgetCredential: unsupported,
      loadModels: unsupported,
      testModel,
      setDefaultModel: unsupported,
      configureModelLimits: unsupported,
      submitOAuthCode: unsupported,
      cancelOAuth: unsupported,
      onOAuthProgress: () => () => {},
    };
    const progress: string[] = [];
    const companionService = new KiroCliCompanionService({
      platform: 'darwin',
      resolveBinary: async () => '/Users/test/.local/bin/kiro-cli',
      runCommand: async (_command, args) =>
        args[0] === 'whoami'
          ? { exitCode: 0, stdout: '{"account":"test"}', stderr: '' }
          : { exitCode: 0, stdout: 'kiro-cli 1.26.0', stderr: '' },
      emitProgress: (status) => progress.push(status.phase),
    });
    const feature = createRuntimeProviderManagementFeature({ port, companionService });

    const result = await feature.connectCompanion({
      companionId: 'kiro-cli',
      projectPath: '/tmp/agent-teams-kiro-test',
    });

    expect(testModel).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      providerId: 'kiro',
      modelId: 'kiro/auto',
      projectPath: '/tmp/agent-teams-kiro-test',
    });
    expect(progress).toContain('verifying-model');
    expect(result.phase).toBe('connected');
    expect(result.message).toContain('verified');
  });

  it('routes Cursor through cursor-acp/auto before reporting connected', async () => {
    const testModel = vi.fn(async () => ({
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      result: {
        providerId: 'cursor-acp',
        modelId: 'cursor-acp/auto',
        ok: true,
        availability: 'available' as const,
        message: 'Cursor verification completed.',
        diagnostics: [],
      },
    }));
    const unsupported = vi.fn(async () => {
      throw new Error('not used');
    });
    const port: RuntimeProviderManagementPort = {
      loadView: unsupported,
      loadProviderDirectory: unsupported,
      loadSetupForm: unsupported,
      connectProvider: unsupported,
      connectWithApiKey: unsupported,
      forgetCredential: unsupported,
      loadModels: unsupported,
      testModel,
      setDefaultModel: unsupported,
      configureModelLimits: unsupported,
      submitOAuthCode: unsupported,
      cancelOAuth: unsupported,
      onOAuthProgress: () => () => {},
    };
    const cursor = new CursorAgentCompanionService({
      platform: 'darwin',
      resolveBinary: async () => '/Users/test/.local/bin/cursor-agent',
      runCommand: async (_command, args) =>
        args[0] === 'status'
          ? { exitCode: 0, stdout: 'Logged in as test@example.com', stderr: '' }
          : { exitCode: 0, stdout: 'cursor-agent 2026.07.09', stderr: '' },
    });
    const feature = createRuntimeProviderManagementFeature({
      port,
      companionRegistry: new Map([
        [
          'cursor-agent',
          {
            service: cursor,
            verification: { providerId: 'cursor-acp', modelId: 'cursor-acp/auto' },
          },
        ],
      ]),
    });

    const result = await feature.connectCompanion({
      companionId: 'cursor-agent',
      projectPath: '/tmp/agent-teams-cursor-test',
    });

    expect(testModel).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      providerId: 'cursor-acp',
      modelId: 'cursor-acp/auto',
      projectPath: '/tmp/agent-teams-cursor-test',
    });
    expect(result.phase).toBe('connected');
    expect(result.message).toContain('verified');
  });
});
