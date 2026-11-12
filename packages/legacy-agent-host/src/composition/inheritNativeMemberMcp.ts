import { captureOpenCodeMcpPolicyPlugin } from '../adapters/providers/openCodeMcpPolicy.js';
import { capturedMcpSourceCurrent } from '../mcp-catalog/capturedSource.js';
import { TeamLaunchError } from '../team-launch/contracts.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';

/** Inherit only the authenticated lead's frozen external allowlist and its original source locator.
 * Provider account, policy plugin and native census remain the target's own recipe. */
export function inheritNativeMemberMcp(
  target: RuntimeMemberProfile,
  lead: RuntimeMemberProfile
): RuntimeMemberProfile {
  const nativeLead = lead.provider === 'opencode' && lead.nativeGeneration === 'v2';
  if (!capturedMcpSourceCurrent(lead) ||
      (nativeLead
        ? lead.mcpPolicyPlugin !== undefined || lead.capturedMcpServers !== undefined ||
          lead.capturedMcpSource !== undefined || lead.mcpCatalogSource !== undefined ||
          ('capturedMcpCatalog' in lead && lead.capturedMcpCatalog !== undefined)
        : lead.capturedMcpServers === undefined))
    throw new TeamLaunchError('hold', 'native-member-mcp-source-changed');
  const servers = lead.capturedMcpServers ?? {};
  if (target.provider === 'opencode' && target.nativeGeneration === 'v2') {
    if (Object.keys(servers).length || lead.capturedMcpSource !== undefined ||
        target.mcpPolicyPlugin !== undefined || target.capturedMcpServers !== undefined ||
        target.capturedMcpSource !== undefined || target.mcpCatalogSource !== undefined ||
        ('capturedMcpCatalog' in target && target.capturedMcpCatalog !== undefined))
      throw new TeamLaunchError('hold', 'native-member-mcp-source-changed');
    return structuredClone(target);
  }
  const selected = target.provider === 'opencode' ? captureOpenCodeMcpPolicyPlugin(target) : target;
  const { capturedMcpSource: _oldSource, ...base } = structuredClone(selected);
  return {
    ...base,
    capturedMcpServers: structuredClone(servers),
    ...(lead.capturedMcpSource
      ? { capturedMcpSource: structuredClone(lead.capturedMcpSource) }
      : {}),
  };
}
