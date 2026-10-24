import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readCapturedMcpBytes } from '../../mcp-catalog/capturedFile.js';
import { capturedMcpServersSchema } from '../../mcp-catalog/capturedServer.js';
import type { OpenCodeMcpServerConfig } from '@agent-teams/provider-implementations/opencode';
import type { OpenCodeMemberProfile } from '../../composition/runtimeProfile.js';

export function verifyOpenCodeMcpPolicyPlugin(profile: OpenCodeMemberProfile): string {
  if (profile.protocolRevision !== '1.19.4') throw new Error('Captured MCP policy version unavailable');
  const selected = profile.mcpPolicyPlugin;
  if (!selected) throw new Error('Captured MCP policy unavailable');
  const bytes = readCapturedMcpBytes(selected.path, 64 * 1024);
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== selected.sha256)
    throw new Error('Captured MCP policy unavailable');
  return pathToFileURL(selected.path).href;
}

/** Trusted shipped artifact; explicit private pins remain supported. Called before recipeDigest. */
export function captureOpenCodeMcpPolicyPlugin(profile: OpenCodeMemberProfile): OpenCodeMemberProfile {
  if (profile.mcpPolicyPlugin) { verifyOpenCodeMcpPolicyPlugin(profile); return profile; }
  const path = fileURLToPath(new URL('./OpenCodeMcpPolicyPlugin.js', import.meta.url));
  const bytes = readCapturedMcpBytes(path, 64 * 1024);
  if (!bytes) throw new Error('Captured MCP policy unavailable');
  const captured = { ...profile, mcpPolicyPlugin: { path, sha256: createHash('sha256').update(bytes).digest('hex') } };
  verifyOpenCodeMcpPolicyPlugin(captured);
  return captured;
}

export function openCodeMcpServers(
  profile: OpenCodeMemberProfile
): Record<string, OpenCodeMcpServerConfig> {
  const result: Record<string, OpenCodeMcpServerConfig> = Object.create(null);
  for (const [name, server] of Object.entries(
    capturedMcpServersSchema.parse(profile.capturedMcpServers ?? {})
  ))
    result[name] =
      server.type === 'stdio'
        ? {
            type: 'local',
            command: [server.command, ...(server.args ?? [])],
            ...(server.env ? { environment: { ...server.env } } : {}),
            enabled: true,
          }
        : {
            type: 'remote',
            url: server.url,
            ...(server.headers ? { headers: { ...server.headers } } : {}),
            enabled: true,
          };
  return result;
}

/** Complete map comparison, never a selected-subset match; nonce proves the exact hook ran. */
export function exactOpenCodeMcpPolicy(effective: unknown, expected: unknown): boolean {
  return isDeepStrictEqual(effective, expected);
}

export function exactOpenCodeMcpStatus(
  status: Record<string, Record<string, unknown>>,
  expected: Record<string, unknown>
): boolean {
  return (
    isDeepStrictEqual(Object.keys(status).sort(), Object.keys(expected).sort()) &&
    Object.values(status).every((value) => value.status === 'connected')
  );
}
