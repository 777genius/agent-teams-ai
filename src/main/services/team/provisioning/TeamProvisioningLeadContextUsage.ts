import { getAnthropicDefaultTeamModel } from '@shared/utils/anthropicModelDefaults';
import { deriveContextMetrics, inferContextWindowTokens } from '@shared/utils/contextMetrics';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { LeadContextUsage, TeamChangeEvent } from '@shared/types';

export interface LeadContextUsageRequestLike {
  providerId?: string;
  model?: string;
  limitContext?: boolean;
}

export interface LeadContextUsageState {
  promptInputTokens: number | null;
  outputTokens: number | null;
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
  promptInputSource: LeadContextUsage['promptInputSource'];
}

export interface StoredLeadContextUsageState extends LeadContextUsageState {
  lastUsageMessageId: string | null;
  lastEmittedAt: number;
}

export interface LeadContextUsageRunLike {
  request: LeadContextUsageRequestLike;
  leadContextUsage: StoredLeadContextUsageState | null;
}

export interface LeadContextUsageEmissionRunLike extends LeadContextUsageRunLike {
  teamName: string;
  runId: string;
  provisioningComplete: boolean;
}

export interface LeadContextUsageAccessorRunLike extends LeadContextUsageRunLike {
  processKilled: boolean;
  cancelRequested: boolean;
}

export interface LeadContextUsageAccessorPorts<TRun extends LeadContextUsageAccessorRunLike> {
  getTrackedRunId(teamName: string): string | null;
  getRun(runId: string): TRun | undefined;
  nowIso(): string;
}

export interface LeadContextUsageEmissionPorts<TRun extends LeadContextUsageEmissionRunLike> {
  isCurrentTrackedRun(run: TRun): boolean;
  nowMs(): number;
  nowIso(): string;
  emitTeamChange(event: TeamChangeEvent): void;
}

export function getInitialLeadContextWindowTokensForRequest(
  request: LeadContextUsageRequestLike
): number | null {
  const providerId = normalizeOptionalTeamProviderId(request.providerId);
  const modelName =
    typeof request.model === 'string' && request.model.trim().length > 0
      ? request.model.trim()
      : providerId === 'anthropic'
        ? getAnthropicDefaultTeamModel(request.limitContext === true)
        : undefined;

  return inferContextWindowTokens({
    providerId,
    modelName,
    limitContext: request.limitContext === true,
  });
}

export function buildLeadContextUsagePayloadFromState(
  usage: LeadContextUsageState | null | undefined,
  updatedAt: string
): LeadContextUsage {
  if (!usage) {
    return {
      promptInputTokens: null,
      outputTokens: null,
      contextUsedTokens: null,
      contextWindowTokens: null,
      contextUsedPercent: null,
      promptInputSource: 'unavailable',
      updatedAt,
    };
  }

  const { contextUsedTokens, contextWindowTokens } = usage;
  const percentRaw =
    contextUsedTokens !== null && contextWindowTokens !== null && contextWindowTokens > 0
      ? Math.round((contextUsedTokens / contextWindowTokens) * 100)
      : null;

  return {
    promptInputTokens: usage.promptInputTokens,
    outputTokens: usage.outputTokens,
    contextUsedTokens: usage.contextUsedTokens,
    contextWindowTokens: usage.contextWindowTokens,
    contextUsedPercent: percentRaw === null ? null : Math.max(0, Math.min(100, percentRaw)),
    promptInputSource: usage.promptInputSource,
    updatedAt,
  };
}

export function getInitialLeadContextWindowTokensForRun(
  run: LeadContextUsageRunLike
): number | null {
  return getInitialLeadContextWindowTokensForRequest(run.request);
}

export function buildLeadContextUsagePayloadForRun(
  run: LeadContextUsageRunLike,
  nowIso: () => string = () => new Date().toISOString()
): LeadContextUsage {
  return buildLeadContextUsagePayloadFromState(run.leadContextUsage, nowIso());
}

export function emitLeadContextUsageForRun<TRun extends LeadContextUsageEmissionRunLike>(
  run: TRun,
  ports: LeadContextUsageEmissionPorts<TRun>,
  throttleMs: number
): boolean {
  if (!run.leadContextUsage || !run.provisioningComplete) {
    return false;
  }
  if (!ports.isCurrentTrackedRun(run)) {
    return false;
  }

  const now = ports.nowMs();
  if (now - run.leadContextUsage.lastEmittedAt < throttleMs) {
    return false;
  }

  run.leadContextUsage.lastEmittedAt = now;
  ports.emitTeamChange({
    type: 'lead-context',
    teamName: run.teamName,
    runId: run.runId,
    detail: JSON.stringify(buildLeadContextUsagePayloadForRun(run, ports.nowIso)),
  });
  return true;
}

export function getLeadContextUsageForTeam<TRun extends LeadContextUsageAccessorRunLike>(
  teamName: string,
  ports: LeadContextUsageAccessorPorts<TRun>
): { usage: LeadContextUsage | null; runId: string | null } {
  const runId = ports.getTrackedRunId(teamName);
  if (!runId) return { usage: null, runId: null };

  const run = ports.getRun(runId);
  if (!run?.leadContextUsage || run.processKilled || run.cancelRequested) {
    return { usage: null, runId: null };
  }

  return {
    usage: buildLeadContextUsagePayloadForRun(run, ports.nowIso),
    runId,
  };
}

export function updateLeadContextUsageFromUsageForRun(
  run: LeadContextUsageRunLike,
  usage: Record<string, unknown>,
  modelName: string | undefined
): void {
  run.leadContextUsage = deriveLeadContextUsageStateFromUsage({
    previousUsage: run.leadContextUsage,
    request: run.request,
    usage,
    modelName,
  });
}

export function deriveLeadContextUsageStateFromUsage(params: {
  previousUsage: StoredLeadContextUsageState | null | undefined;
  request: LeadContextUsageRequestLike;
  usage: Record<string, unknown>;
  modelName: string | undefined;
}): StoredLeadContextUsageState {
  const existingContextWindowTokens =
    params.previousUsage?.contextWindowTokens ??
    getInitialLeadContextWindowTokensForRequest(params.request);
  const metrics = deriveContextMetrics({
    usage: params.usage,
    providerId: normalizeOptionalTeamProviderId(params.request.providerId),
    modelName: params.modelName,
    contextWindowTokens: existingContextWindowTokens,
    limitContext: params.request.limitContext === true,
  });

  return {
    promptInputTokens: metrics.promptInputTokens,
    outputTokens: metrics.outputTokens,
    contextUsedTokens: metrics.contextUsedTokens,
    contextWindowTokens:
      metrics.contextWindowTokens ?? params.previousUsage?.contextWindowTokens ?? null,
    promptInputSource: metrics.promptInputSource,
    lastUsageMessageId: params.previousUsage?.lastUsageMessageId ?? null,
    lastEmittedAt: params.previousUsage?.lastEmittedAt ?? 0,
  };
}
