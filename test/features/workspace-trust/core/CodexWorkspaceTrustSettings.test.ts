import { describe, expect, it } from 'vitest';

import {
  buildCodexTrustedProjectConfigOverride,
  buildCodexTrustedProjectConfigOverrides,
  buildCodexWorkspaceTrustSettings,
  buildCodexWorkspaceTrustSettingsArgs,
  isCodexWorkspaceTrustConfigOverride,
  readCodexWorkspaceTrustConfigOverridesFromSettings,
} from '@features/workspace-trust/core/domain';

describe('CodexWorkspaceTrustSettings', () => {
  it('builds repeatable dotted project overrides with TOML basic string escaping', () => {
    const override = buildCodexTrustedProjectConfigOverride('/tmp/Project "Q"[1]');

    expect(override).toBe('projects."/tmp/Project \\"Q\\"[1]".trust_level="trusted"');
    expect(override).not.toContain('projects={');
    expect(isCodexWorkspaceTrustConfigOverride(override)).toBe(true);
  });

  it('normalizes and dedupes path keys before building override values', () => {
    const overrides = buildCodexTrustedProjectConfigOverrides(
      ['C:\\Repo With Space\\quote"name', 'c:/repo with space/quote"name/'],
      { platform: 'win32' }
    );

    expect(overrides).toEqual([
      'projects."C:/Repo With Space/quote\\"name".trust_level="trusted"',
      'projects."c:/repo with space/quote\\"name".trust_level="trusted"',
    ]);
  });

  it('builds app-owned inline settings and rejects malformed override payloads', () => {
    const valid = 'projects."/tmp/project".trust_level="trusted"';
    const settings = buildCodexWorkspaceTrustSettings([
      valid,
      valid,
      'projects."/tmp/project".trust_level="untrusted"',
      'forced_login_method="chatgpt"',
      'projects={}',
      'projects."/tmp/other".trust_level="trusted"\nforced_login_method="api"',
    ]);

    expect(settings).toEqual({
      codex: {
        agent_teams_workspace_trust: {
          config_overrides: [valid],
        },
      },
    });
    expect(readCodexWorkspaceTrustConfigOverridesFromSettings(settings)).toEqual([valid]);
  });

  it('returns no settings args when no safe overrides exist', () => {
    expect(buildCodexWorkspaceTrustSettingsArgs(['projects={bad=true}'])).toEqual([]);
  });
});
