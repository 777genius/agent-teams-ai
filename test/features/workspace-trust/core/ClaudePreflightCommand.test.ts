import { describe, expect, it } from 'vitest';

import { buildClaudeWorkspaceTrustPreflightArgs } from '@features/workspace-trust/core/application';

describe('ClaudePreflightCommand', () => {
  it('builds the protected modern Claude workspace trust command args', () => {
    const result = buildClaudeWorkspaceTrustPreflightArgs({
      emptyMcpConfigPath: '/tmp/empty-mcp.json',
    });

    expect(result).toEqual({
      ok: true,
      args: [
        '--bare',
        '--strict-mcp-config',
        '--mcp-config',
        '/tmp/empty-mcp.json',
        '--setting-sources',
        'user',
        '--settings',
        '{"disableAllHooks":true}',
        '--tools',
        '',
      ],
      omittedFlags: [],
    });
  });

  it('allows the strict protected fallback without bare but never falls back to plain Claude', () => {
    const result = buildClaudeWorkspaceTrustPreflightArgs({
      emptyMcpConfigPath: '/tmp/empty-mcp.json',
      capabilities: { bare: false },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.args).not.toContain('--bare');
      expect(result.args).toContain('--strict-mcp-config');
      expect(result.args).toContain('--setting-sources');
      expect(result.omittedFlags).toEqual(['--bare']);
    }
  });

  it('returns a soft unavailable result when protected flags are missing', () => {
    const result = buildClaudeWorkspaceTrustPreflightArgs({
      emptyMcpConfigPath: '/tmp/empty-mcp.json',
      capabilities: { strictMcpConfig: false },
    });

    expect(result).toEqual({
      ok: false,
      code: 'preflight_unavailable_or_unprotected',
      message:
        'Claude workspace trust preflight is unavailable because protected flags are missing: strictMcpConfig',
    });
  });

  it('does not build a command when hook and tool isolation flags are unavailable', () => {
    const result = buildClaudeWorkspaceTrustPreflightArgs({
      emptyMcpConfigPath: '/tmp/empty-mcp.json',
      capabilities: {
        settingSources: false,
        inlineSettings: false,
        tools: false,
      },
    });

    expect(result).toEqual({
      ok: false,
      code: 'preflight_unavailable_or_unprotected',
      message:
        'Claude workspace trust preflight is unavailable because protected flags are missing: settingSources, inlineSettings, tools',
    });
  });
});
