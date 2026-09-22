export interface ClaudePreflightCommandCapabilities {
  bare: boolean;
  strictMcpConfig: boolean;
  mcpConfig: boolean;
  settingSources: boolean;
  inlineSettings: boolean;
  tools: boolean;
}

export type ClaudePreflightCommandResult =
  | { ok: true; args: string[]; omittedFlags: string[] }
  | { ok: false; code: 'preflight_unavailable_or_unprotected'; message: string };

export const DEFAULT_CLAUDE_PREFLIGHT_COMMAND_CAPABILITIES: ClaudePreflightCommandCapabilities = {
  bare: true,
  strictMcpConfig: true,
  mcpConfig: true,
  settingSources: true,
  inlineSettings: true,
  tools: true,
};

export function buildClaudeWorkspaceTrustPreflightArgs(input: {
  emptyMcpConfigPath: string;
  capabilities?: Partial<ClaudePreflightCommandCapabilities>;
}): ClaudePreflightCommandResult {
  const capabilities = {
    ...DEFAULT_CLAUDE_PREFLIGHT_COMMAND_CAPABILITIES,
    ...(input.capabilities ?? {}),
  };

  const requiredProtectedFlags: (keyof ClaudePreflightCommandCapabilities)[] = [
    'strictMcpConfig',
    'mcpConfig',
    'settingSources',
    'inlineSettings',
    'tools',
  ];
  const missing = requiredProtectedFlags.filter((flag) => !capabilities[flag]);
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'preflight_unavailable_or_unprotected',
      message: `Claude workspace trust preflight is unavailable because protected flags are missing: ${missing.join(
        ', '
      )}`,
    };
  }

  const args: string[] = [];
  const omittedFlags: string[] = [];
  if (capabilities.bare) {
    args.push('--bare');
  } else {
    omittedFlags.push('--bare');
  }

  args.push(
    '--strict-mcp-config',
    '--mcp-config',
    input.emptyMcpConfigPath,
    '--setting-sources',
    'user',
    '--settings',
    JSON.stringify({ disableAllHooks: true }),
    '--tools',
    ''
  );

  return { ok: true, args, omittedFlags };
}
