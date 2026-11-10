import { teamIdForName } from '../../contracts';

import type { TokenUsageEventDto, TokenUsageRunDto } from '../../contracts';

export interface SnapshotBreakdownKey {
  id: string;
  label: string;
  teamName?: string;
  agentName?: string;
}

export function runAgentKey(run: TokenUsageRunDto): SnapshotBreakdownKey {
  return {
    id: run.agentId ?? JSON.stringify([teamIdForName(run.teamName), run.agentName ?? 'unknown']),
    label: run.agentName ?? run.agentId ?? 'Unknown agent',
    teamName: run.teamName,
    agentName: run.agentName,
  };
}

export function runRuntimeKey(run: TokenUsageRunDto): SnapshotBreakdownKey {
  return { id: run.runtimeKind, label: run.runtimeKind };
}

export function runModelKey(
  run: TokenUsageRunDto,
  events: readonly TokenUsageEventDto[] | undefined
): SnapshotBreakdownKey {
  const model = firstModeledEventModel(events) ?? run.model;
  return { id: model ?? 'unknown-model', label: model ?? 'Unknown model' };
}

export function firstModeledEventModel(
  events: readonly TokenUsageEventDto[] | undefined
): string | undefined {
  return events?.find((event) => event.model)?.model;
}

export function modeledEventModels(events: readonly TokenUsageEventDto[] | undefined): string[] {
  const models = new Set<string>();
  for (const event of events ?? []) {
    if (event.model) models.add(event.model);
  }
  return [...models];
}
