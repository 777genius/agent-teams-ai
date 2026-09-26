import { resolveLanguageName } from '@shared/utils/agentLanguage';

import { parseHostedRosterConfiguration } from '../../contracts/hostedRosterConfiguration';

/**
 * A hosted server has no operator desktop locale, and the plan must recompile to the same bytes,
 * so `system` resolves against a fixed locale. The draft editor preselects the browser language.
 */
const HOSTED_AGENT_SYSTEM_LOCALE = 'en';

/** Pure schema-2 encoder matching Owner TeamLifecycleLaunchPlan. No capability claim. */
export function compileHostedPromotionPlan(input: {
  readonly runtimeWorkspaceId: string;
  readonly originalTeamId: string;
  readonly admittedWorkspaceRoot: string;
  readonly configuration: unknown;
  readonly laneIds: readonly string[];
  /** The draft's agent language code; absent means `system`. */
  readonly agentLanguage?: string;
}): string {
  const identifier = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
  const configuration = parseHostedRosterConfiguration(input.configuration);
  if (
    !identifier(input.runtimeWorkspaceId) ||
    !identifier(input.originalTeamId) ||
    typeof input.admittedWorkspaceRoot !== 'string' ||
    !input.admittedWorkspaceRoot.startsWith('/') ||
    input.admittedWorkspaceRoot.includes('\0') ||
    input.admittedWorkspaceRoot.length > 4096 ||
    input.laneIds.length !== configuration.lanes.length ||
    new Set(input.laneIds).size !== input.laneIds.length ||
    input.laneIds.some((id) => !identifier(id))
  ) {
    throw new TypeError('promotion-plan-scope-invalid');
  }
  const lanes = configuration.lanes.map((lane, index) => {
    const provider = lane.provider;
    if (!['anthropic', 'codex', 'gemini', 'opencode'].includes(provider)) {
      throw new TypeError('promotion-plan-provider-unsupported');
    }
    return {
      laneId: input.laneIds[index],
      kind: lane.kind,
      provider,
      ...(lane.kind === 'opencode'
        ? {
            selectedModel: lane.selectedModel,
            ...(lane.effort === undefined ? {} : { effort: lane.effort }),
          }
        : {}),
      members: lane.members.map((member) => ({
        name: member.name,
        prompt: member.prompt,
        ...(member.model === undefined ? {} : { model: member.model }),
        ...(member.effort === undefined ? {} : { effort: member.effort }),
      })),
    };
  });
  const bytes = JSON.stringify({
    schemaVersion: 2,
    workspaceId: input.runtimeWorkspaceId,
    teamId: input.originalTeamId,
    workspaceRoot: input.admittedWorkspaceRoot,
    toolApprovalMode: configuration.toolApprovalMode,
    agentLanguage: resolveLanguageName(input.agentLanguage ?? 'system', HOSTED_AGENT_SYSTEM_LOCALE),
    lanes,
  });
  if (new TextEncoder().encode(bytes).length > 256 * 1024)
    throw new TypeError('promotion-plan-too-large');
  return bytes;
}
