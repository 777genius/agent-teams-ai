import type { TeamHostProfile } from './TeamHost.js';
import type { RuntimeMemberProfile } from './runtimeProfile.js';
import type { TeamOwner } from '../team/TeamOwner.js';
import type { DeliveryBinding } from '../team/contracts.js';
import type { OpenConfig } from '@agent-teams/provider-session-contracts';
import type { RuntimeBinding } from '../runtime/contracts.js';
import type { MemberProvider } from '../adapters/providers/MemberProvider.js';
import type { TeamMcpEndpoint } from '../mcp/contracts.js';

export interface HostedTeam {
  definition: TeamHostProfile['teams'][number];
  owner: TeamOwner;
  connection: ReturnType<TeamOwner['connect']>;
  /** Immutable product source of this native capture; absent only for initial descriptors. */
  configurationRevision?: string;
  launchId?: string;
  capture?: import('../contracts.js').JsonValue;
  operatorPrincipalId?: string;
}

export interface MemberEntry {
  profile: RuntimeMemberProfile;
  baseProfile: RuntimeMemberProfile;
  selection?: import('../team/ports.js').TeamRuntimeSelection;
  team: HostedTeam;
  delivery: DeliveryBinding;
  binding: RuntimeBinding;
  config: OpenConfig;
  settleWorkSync?: () => Promise<{ held: { commandId: string; code: 'hold' | 'forbidden' }[] }>;
  provider?: MemberProvider;
  endpoint?: TeamMcpEndpoint;
  endpointExpiresAtMs?: number;
}
