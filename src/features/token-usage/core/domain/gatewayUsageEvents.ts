import { teamIdForName } from '../../contracts';

import type { TokenUsageEventDto } from '../../contracts';

export interface GatewayBreakdownKey {
  id: string;
  label: string;
  teamName?: string;
  agentName?: string;
}

/** Daily gateway aggregates may be attributed without a matching runtime run. */
export function isGatewayAggregateEvent(event: TokenUsageEventDto): boolean {
  return (
    event.usageSourceKind === 'gateway_exact' &&
    Boolean(event.gatewayUsageRef) &&
    Boolean(event.gatewayDay) &&
    Boolean(event.teamName?.trim())
  );
}

export function gatewayTeamKey(event: TokenUsageEventDto): GatewayBreakdownKey {
  const teamId = teamIdForName(event.teamName);
  return { id: teamId, label: event.teamName ?? teamId, teamName: event.teamName };
}

export function gatewayAgentKey(event: TokenUsageEventDto): GatewayBreakdownKey {
  return {
    id:
      event.agentId ??
      JSON.stringify([teamIdForName(event.teamName), event.agentName ?? 'unknown']),
    label: event.agentName ?? event.agentId ?? 'Unknown agent',
    teamName: event.teamName,
    agentName: event.agentName,
  };
}

export function gatewayRuntimeKey(): GatewayBreakdownKey {
  return { id: 'unknown', label: 'unknown' };
}

export function gatewayModelKey(event: TokenUsageEventDto): GatewayBreakdownKey {
  const model = event.model ?? 'unknown-model';
  return { id: model, label: model };
}
