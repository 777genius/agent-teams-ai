import { captureOpenCodeMcpPolicyPlugin } from '../adapters/providers/openCodeMcpPolicy.js';
import { openCodeV2CapturedMcp } from '../adapters/providers/OpenCodeV2CapturedMcp.js';
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
        ? lead.mcpPolicyPlugin !== undefined ||
          (!(lead.protocolRevision === '2.1.4' && lead.embedded) &&
            (lead.capturedMcpServers !== undefined || lead.capturedMcpSource !== undefined ||
             lead.mcpCatalogSource !== undefined)) ||
          ('capturedMcpCatalog' in lead && lead.capturedMcpCatalog !== undefined)
        : lead.capturedMcpServers === undefined))
    throw new TeamLaunchError('hold', 'native-member-mcp-source-changed');
  const servers = lead.capturedMcpServers ?? {};
  if (target.provider === 'opencode' && target.nativeGeneration === 'v2') {
    if (target.mcpPolicyPlugin !== undefined ||
        (!(target.protocolRevision === '2.1.4' && target.embedded) &&
          (Object.keys(servers).length || lead.capturedMcpSource !== undefined ||
           target.capturedMcpServers !== undefined || target.capturedMcpSource !== undefined ||
           target.mcpCatalogSource !== undefined)) ||
        ('capturedMcpCatalog' in target && target.capturedMcpCatalog !== undefined))
      throw new TeamLaunchError('hold', 'native-member-mcp-source-changed');
    try { openCodeV2CapturedMcp(servers); }
    catch { throw new TeamLaunchError('hold', 'native-member-mcp-source-changed'); }
    if (!Object.keys(servers).length && lead.capturedMcpSource === undefined &&
        target.capturedMcpServers === undefined && target.capturedMcpSource === undefined &&
        target.mcpCatalogSource === undefined) return structuredClone(target);
  }
  const selected = target.provider === 'opencode' && target.nativeGeneration !== 'v2'
    ? captureOpenCodeMcpPolicyPlugin(target) : target;
  const { capturedMcpSource: _oldSource, ...base } = structuredClone(selected);
  return {
    ...base,
    capturedMcpServers: structuredClone(servers),
    ...(lead.capturedMcpSource
      ? { capturedMcpSource: structuredClone(lead.capturedMcpSource) }
      : {}),
  };
}
