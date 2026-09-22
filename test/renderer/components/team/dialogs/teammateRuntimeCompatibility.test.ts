import { analyzeTeammateRuntimeCompatibility } from '@renderer/components/team/dialogs/teammateRuntimeCompatibility';
import { describe, expect, it } from 'vitest';

import type { TmuxStatus } from '@features/tmux-installer/contracts';

function buildTmuxStatus(ready: boolean): TmuxStatus {
  return {
    platform: 'win32',
    nativeSupported: false,
    checkedAt: '2026-04-25T00:00:00.000Z',
    host: {
      available: false,
      version: null,
      binaryPath: null,
      error: null,
    },
    effective: {
      available: ready,
      location: ready ? 'wsl' : null,
      version: ready ? '3.4' : null,
      binaryPath: ready ? '/usr/bin/tmux' : null,
      runtimeReady: ready,
      detail: ready ? 'tmux is ready' : 'tmux is not available',
    },
    error: null,
    autoInstall: {
      supported: false,
      strategy: 'manual',
      packageManagerLabel: null,
      requiresTerminalInput: false,
      requiresAdmin: false,
      requiresRestart: false,
      mayOpenExternalWindow: false,
      reasonIfUnsupported: null,
      manualHints: [],
    },
    wsl: null,
    wslPreference: null,
  };
}

describe('analyzeTeammateRuntimeCompatibility', () => {
  it('allows same-provider non-Codex teammates without tmux', () => {
    const result = analyzeTeammateRuntimeCompatibility({
      leadProviderId: 'anthropic',
      members: [{ id: 'alice', name: 'alice', providerId: 'anthropic' }],
      tmuxStatus: buildTmuxStatus(false),
      tmuxStatusLoading: false,
      tmuxStatusError: null,
    });

    expect(result.blocksSubmission).toBe(false);
    expect(result.visible).toBe(false);
    expect(result.providerNoticeProviderId).toBeNull();
    expect(result.memberWarningById).toEqual({});
  });

  it('allows mixed-provider teammates through native process transport when tmux is unavailable', () => {
    const result = analyzeTeammateRuntimeCompatibility({
      leadProviderId: 'anthropic',
      members: [{ id: 'bob', name: 'bob', providerId: 'codex' }],
      tmuxStatus: buildTmuxStatus(false),
      tmuxStatusLoading: false,
      tmuxStatusError: null,
    });

    expect(result.blocksSubmission).toBe(false);
    expect(result.visible).toBe(false);
    expect(result.memberWarningById).toEqual({});
  });

  it('allows OpenCode secondary-lane teammates without tmux under a non-OpenCode lead', () => {
    const result = analyzeTeammateRuntimeCompatibility({
      leadProviderId: 'anthropic',
      members: [{ id: 'bob', name: 'bob', providerId: 'opencode' }],
      tmuxStatus: buildTmuxStatus(false),
      tmuxStatusLoading: false,
      tmuxStatusError: null,
    });

    expect(result.blocksSubmission).toBe(false);
    expect(result.visible).toBe(false);
    expect(result.memberWarningById).toEqual({});
  });

  it('blocks OpenCode-led mixed teams independently of tmux readiness', () => {
    const result = analyzeTeammateRuntimeCompatibility({
      leadProviderId: 'opencode',
      members: [{ id: 'bob', name: 'bob', providerId: 'anthropic' }],
      tmuxStatus: buildTmuxStatus(true),
      tmuxStatusLoading: false,
      tmuxStatusError: null,
    });

    expect(result.blocksSubmission).toBe(true);
    expect(result.providerNoticeProviderId).toBe('opencode');
    expect(result.title).toBe('OpenCode cannot lead mixed-provider teams');
    expect(result.message).toContain('mixed teams cannot use OpenCode as the lead');
    expect(result.message).toContain('Anthropic or Codex lead');
    expect(result.message).not.toContain('Gemini');
    expect(result.tmuxDetail).toBeNull();
    expect(result.memberWarningById.bob).toContain('OpenCode cannot be the team lead');
  });

  it('allows same-provider Codex native teammates through native process transport when tmux is unavailable', () => {
    const result = analyzeTeammateRuntimeCompatibility({
      leadProviderId: 'codex',
      leadProviderBackendId: 'codex-native',
      members: [{ id: 'jack', name: 'jack', providerId: 'codex' }],
      tmuxStatus: buildTmuxStatus(false),
      tmuxStatusLoading: false,
      tmuxStatusError: null,
    });

    expect(result.blocksSubmission).toBe(false);
    expect(result.visible).toBe(false);
    expect(result.memberWarningById).toEqual({});
  });

  it('allows separate-process teammate requirements when tmux is ready', () => {
    const result = analyzeTeammateRuntimeCompatibility({
      leadProviderId: 'anthropic',
      members: [{ id: 'bob', name: 'bob', providerId: 'codex' }],
      tmuxStatus: buildTmuxStatus(true),
      tmuxStatusLoading: false,
      tmuxStatusError: null,
    });

    expect(result.blocksSubmission).toBe(false);
    expect(result.visible).toBe(false);
  });

  it('ignores teammate runtime requirements for solo teams', () => {
    const result = analyzeTeammateRuntimeCompatibility({
      leadProviderId: 'codex',
      leadProviderBackendId: 'codex-native',
      members: [{ id: 'jack', name: 'jack', providerId: 'codex' }],
      soloTeam: true,
      tmuxStatus: buildTmuxStatus(false),
      tmuxStatusLoading: false,
      tmuxStatusError: null,
    });

    expect(result.blocksSubmission).toBe(false);
    expect(result.visible).toBe(false);
  });

  it('blocks explicit tmux teammate mode when tmux is unavailable', () => {
    const result = analyzeTeammateRuntimeCompatibility({
      leadProviderId: 'anthropic',
      members: [{ id: 'alice', name: 'alice', providerId: 'anthropic' }],
      extraCliArgs: '--teammate-mode tmux',
      tmuxStatus: buildTmuxStatus(false),
      tmuxStatusLoading: false,
      tmuxStatusError: null,
    });

    expect(result.blocksSubmission).toBe(true);
    expect(result.details).toContain('Custom CLI args force --teammate-mode tmux.');
    expect(result.message).toContain('native process transport');
  });

  it('blocks explicit in-process mode when a teammate requires a separate process', () => {
    const result = analyzeTeammateRuntimeCompatibility({
      leadProviderId: 'anthropic',
      members: [{ id: 'bob', name: 'bob', providerId: 'codex' }],
      extraCliArgs: '--teammate-mode=in-process',
      tmuxStatus: buildTmuxStatus(true),
      tmuxStatusLoading: false,
      tmuxStatusError: null,
    });

    expect(result.blocksSubmission).toBe(true);
    expect(result.title).toBe('This team cannot use in-process teammates');
    expect(result.details).toContain('Custom CLI args force --teammate-mode in-process.');
    expect(result.message).toContain('native process transport');
    expect(result.memberWarningById.bob).toContain('requires a separate process');
  });
});
