import { execFile } from 'node:child_process';

import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';

const HEADERS_ENV = 'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_HEADERS_JSON';
const UPGRADE = 'Update the Agent Teams runtime to use authenticated MCP HTTP connections';

export function assertMcpHeaderCapabilityResponse(stdout: string): void {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error(UPGRADE);
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !('schemaVersion' in value) ||
    value.schemaVersion !== 1 ||
    !('mcpHttpAuthorizationHeaders' in value) ||
    value.mcpHttpAuthorizationHeaders !== true
  )
    throw new Error(UPGRADE);
}

/** Side-effect-free CLI capability query runs before launching an authenticated OpenCode consumer. */
export async function requireRuntimeMcpHeaderSupport(env: NodeJS.ProcessEnv): Promise<void> {
  if (!env[HEADERS_ENV]) return;
  const binary = await ClaudeBinaryResolver.resolve();
  if (!binary) throw new Error(UPGRADE);
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      binary,
      ['runtime', 'security-capabilities', '--json'],
      {
        env,
        timeout: 5_000,
        maxBuffer: 16_384,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, output) => (error ? reject(new Error(UPGRADE)) : resolve(output))
    );
  });
  assertMcpHeaderCapabilityResponse(stdout);
}
