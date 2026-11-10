import * as agentTeamsControllerModule from 'agent-teams-controller';

import type { AgentActionMode } from '@shared/types';

const { protocols } = agentTeamsControllerModule;

export function buildActionModeProtocol(): string {
  return protocols.buildActionModeProtocol();
}

export function buildActionModeAgentBlock(mode: AgentActionMode | undefined): string {
  return protocols.buildActionModeAgentBlock(mode);
}

export function isAgentActionMode(value: unknown): value is AgentActionMode {
  return value === 'do' || value === 'ask' || value === 'delegate';
}
