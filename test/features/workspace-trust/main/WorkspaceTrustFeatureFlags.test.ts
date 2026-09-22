import { describe, expect, it, vi } from 'vitest';

import { resolveWorkspaceTrustFeatureFlags } from '@features/workspace-trust/main';

describe('WorkspaceTrustFeatureFlags', () => {
  it('keeps workspace trust on by default without claiming file-lock support', () => {
    expect(resolveWorkspaceTrustFeatureFlags({} as NodeJS.ProcessEnv)).toEqual({
      enabled: true,
      claudePty: true,
      codexArgs: true,
      retry: false,
      fileLock: false,
    });
  });

  it('does not enable the reserved file lock flag through env yet', () => {
    expect(
      resolveWorkspaceTrustFeatureFlags({
        AGENT_TEAMS_WORKSPACE_TRUST_FILE_LOCK: 'true',
      } as NodeJS.ProcessEnv).fileLock
    ).toBe(false);
  });

  it('uses the plan-name preflight flag before the legacy feature flag', () => {
    expect(
      resolveWorkspaceTrustFeatureFlags({
        AGENT_TEAMS_WORKSPACE_TRUST_PREFLIGHT: 'false',
        AGENT_TEAMS_WORKSPACE_TRUST: 'true',
      } as NodeJS.ProcessEnv)
    ).toMatchObject({
      enabled: false,
      claudePty: false,
      codexArgs: false,
    });
  });

  it('uses the plan-name Codex settings flag before the legacy args alias', () => {
    expect(
      resolveWorkspaceTrustFeatureFlags({
        AGENT_TEAMS_WORKSPACE_TRUST_CODEX_SETTINGS: 'false',
        AGENT_TEAMS_WORKSPACE_TRUST_CODEX_ARGS: 'true',
      } as NodeJS.ProcessEnv).codexArgs
    ).toBe(false);
  });

  it('keeps malformed default-on flags enabled and malformed default-off retry disabled', () => {
    expect(
      resolveWorkspaceTrustFeatureFlags({
        AGENT_TEAMS_WORKSPACE_TRUST_PREFLIGHT: 'wat',
        AGENT_TEAMS_WORKSPACE_TRUST_CLAUDE_PTY: 'maybe',
        AGENT_TEAMS_WORKSPACE_TRUST_CODEX_SETTINGS: '???',
        AGENT_TEAMS_WORKSPACE_TRUST_RETRY: 'later',
      } as NodeJS.ProcessEnv)
    ).toEqual({
      enabled: true,
      claudePty: true,
      codexArgs: true,
      retry: false,
      fileLock: false,
    });
    expect(vi.mocked(console.warn).mock.calls.map((call) => call.join(' '))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('AGENT_TEAMS_WORKSPACE_TRUST_PREFLIGHT'),
        expect.stringContaining('AGENT_TEAMS_WORKSPACE_TRUST_CLAUDE_PTY'),
        expect.stringContaining('AGENT_TEAMS_WORKSPACE_TRUST_CODEX_SETTINGS'),
        expect.stringContaining('AGENT_TEAMS_WORKSPACE_TRUST_RETRY'),
      ])
    );
    vi.mocked(console.warn).mockClear();
  });

  it('keeps child capabilities off when the main preflight flag is disabled', () => {
    expect(
      resolveWorkspaceTrustFeatureFlags({
        AGENT_TEAMS_WORKSPACE_TRUST_PREFLIGHT: 'off',
        AGENT_TEAMS_WORKSPACE_TRUST_CLAUDE_PTY: 'on',
        AGENT_TEAMS_WORKSPACE_TRUST_CODEX_SETTINGS: 'on',
        AGENT_TEAMS_WORKSPACE_TRUST_RETRY: 'on',
      } as NodeJS.ProcessEnv)
    ).toEqual({
      enabled: false,
      claudePty: false,
      codexArgs: false,
      retry: false,
      fileLock: false,
    });
  });
});
