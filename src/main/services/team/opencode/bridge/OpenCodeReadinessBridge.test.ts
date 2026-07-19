import { describe, expect, it, vi } from 'vitest';

import {
  OpenCodeReadinessBridge,
  type OpenCodeReadinessBridgeCommandExecutor,
  resolveOpenCodeLaunchTimeoutMs,
  resolveOpenCodeReadinessTimeoutMs,
} from './OpenCodeReadinessBridge';

import type { OpenCodeTeamLaunchReadiness } from '../readiness/OpenCodeTeamLaunchReadiness';

describe('resolveOpenCodeLaunchTimeoutMs', () => {
  it('keeps the standard launch timeout for regular OpenCode providers', () => {
    expect(resolveOpenCodeLaunchTimeoutMs({ selectedModel: 'openai/gpt-5.4', members: [] })).toBe(
      120_000
    );
  });

  it('scales the timeout for serial native subscription CLI members', () => {
    const members = [
      { name: 'one', role: 'developer', prompt: 'one' },
      { name: 'two', role: 'developer', prompt: 'two' },
    ];

    expect(resolveOpenCodeLaunchTimeoutMs({ selectedModel: 'cursor-acp/auto', members })).toBe(
      270_000
    );
    expect(resolveOpenCodeLaunchTimeoutMs({ selectedModel: 'kiro/auto', members })).toBe(270_000);
  });

  it('honors an explicit launch timeout override', () => {
    expect(
      resolveOpenCodeLaunchTimeoutMs({ selectedModel: 'cursor-acp/auto', members: [] }, 42_000)
    ).toBe(42_000);
  });

  it('uses one provider-independent readiness budget', () => {
    expect(resolveOpenCodeReadinessTimeoutMs('cursor-acp/auto')).toBe(300_000);
    expect(resolveOpenCodeReadinessTimeoutMs('kiro/auto')).toBe(300_000);
    expect(resolveOpenCodeReadinessTimeoutMs('ollama/gemma4:12b')).toBe(300_000);
    expect(resolveOpenCodeReadinessTimeoutMs('openai/gpt-5.4')).toBe(300_000);
    expect(resolveOpenCodeReadinessTimeoutMs('cursor-acp/auto', 42_000)).toBe(42_000);
  });
});

describe('OpenCodeReadinessBridge project identity', () => {
  it('retrieves a Windows readiness snapshot across path casing changes', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const runtime = {
      providerId: 'opencode' as const,
      binaryPath: 'C:\\runtime\\opencode.exe',
      binaryFingerprint: 'binary-1',
      version: '1.18.2',
      capabilitySnapshotId: 'capability-1',
    };
    const readiness: OpenCodeTeamLaunchReadiness = {
      state: 'ready',
      launchAllowed: true,
      modelId: 'ollama/gemma4:12b',
      availableModels: ['ollama/gemma4:12b'],
      opencodeVersion: '1.18.2',
      installMethod: 'unknown',
      binaryPath: runtime.binaryPath,
      hostHealthy: true,
      appMcpConnected: true,
      requiredToolsPresent: true,
      permissionBridgeReady: true,
      runtimeStoresReady: true,
      supportLevel: 'production_supported',
      missing: [],
      diagnostics: [],
      evidence: {
        capabilitiesReady: true,
        mcpToolProofRoute: '/experimental/tool/ids',
        observedMcpTools: [],
        runtimeStoreReadinessReason: 'runtime_store_manifest_valid',
      },
    };
    const executor = {
      execute: vi.fn(async () => ({
        ok: true as const,
        schemaVersion: 1 as const,
        requestId: 'request-1',
        command: 'opencode.readiness' as const,
        completedAt: '2026-07-17T00:00:00.000Z',
        durationMs: 1,
        runtime,
        diagnostics: [],
        data: readiness,
      })),
    } as unknown as OpenCodeReadinessBridgeCommandExecutor;

    try {
      const bridge = new OpenCodeReadinessBridge(executor);
      await bridge.checkOpenCodeTeamLaunchReadiness({
        projectPath: 'C:\\Users\\Test\\Todo',
        selectedModel: 'ollama/gemma4:12b',
        requireExecutionProbe: true,
      });

      expect(
        bridge.getLastOpenCodeRuntimeSnapshot('c:\\users\\test\\todo', 'ollama/gemma4:12b', true)
      ).toEqual(runtime);
      expect(bridge.getLastOpenCodeRuntimeSnapshot('c:\\users\\test\\todo')).toEqual(runtime);
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });
});
