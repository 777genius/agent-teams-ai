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
  if (lead.capturedMcpServers === undefined || !capturedMcpSourceCurrent(lead))
    throw new TeamLaunchError('hold', 'native-member-mcp-source-changed');
  const selected = target.provider === 'opencode' ? captureOpenCodeMcpPolicyPlugin(target) : target;
  const { capturedMcpSource: _oldSource, ...base } = structuredClone(selected);
  return {
    ...base,
    capturedMcpServers: structuredClone(lead.capturedMcpServers),
    ...(lead.capturedMcpSource
      ? { capturedMcpSource: structuredClone(lead.capturedMcpSource) }
      : {}),
  };
}
