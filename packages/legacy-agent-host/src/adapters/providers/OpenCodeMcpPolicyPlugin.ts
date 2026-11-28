/** Bundled private native config hook. No filesystem writes, network access or public plugin API. */
export default async function HostMcpPolicyPlugin(_input: unknown) {
  const nonce = process.env.LEGACY_AGENT_HOST_MCP_POLICY_NONCE;
  const team = process.env.LEGACY_AGENT_HOST_MCP_TEAM_SERVER;
  const text = process.env.OPENCODE_CONFIG_CONTENT;
  if (!nonce || !/^[a-f0-9]{64}$/u.test(nonce) || !team || !text || text.length > 1024 * 1024)
    throw new Error('Captured MCP policy unavailable');
  const parsed: unknown = JSON.parse(text);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('mcp' in parsed) ||
    !parsed.mcp ||
    typeof parsed.mcp !== 'object' ||
    Array.isArray(parsed.mcp)
  )
    throw new Error('Captured MCP policy unavailable');
  const selected = structuredClone(parsed.mcp) as Record<string, unknown>;
  const endpoint = selected[team];
  if (
    !endpoint ||
    typeof endpoint !== 'object' ||
    !('headers' in endpoint) ||
    !endpoint.headers ||
    typeof endpoint.headers !== 'object' ||
    Array.isArray(endpoint.headers)
  )
    throw new Error('Captured MCP policy unavailable');
  Object.assign(endpoint.headers, { 'X-Legacy-Mcp-Policy': nonce });
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  };
  freeze(selected);
  return {
    async config(config: Record<string, unknown>): Promise<void> {
      Object.defineProperty(config, 'mcp', {
        value: selected,
        writable: false,
        configurable: false,
        enumerable: true,
      });
    },
  };
}
