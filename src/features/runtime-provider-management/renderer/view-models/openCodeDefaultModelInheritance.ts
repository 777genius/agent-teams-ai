import type {
  RuntimeProviderManagementViewDto,
  RuntimeProviderModelDto,
} from '@features/runtime-provider-management/contracts';

export const OPENROUTER_FREE_MODEL_ID = 'openrouter/openrouter/free';

export interface OpenCodeDefaultModelPresentation {
  readonly baseModelId: string | null;
  readonly baseDisplayName: string;
  readonly projectPath: string | null;
  readonly projectName: string | null;
  readonly projectOverrideModelId: string | null;
  readonly projectEffectiveModelId: string | null;
  readonly projectEffectiveDisplayName: string;
  readonly projectInherits: boolean;
  readonly effectiveSource: RuntimeProviderManagementViewDto['defaultModelSource'];
}

function displayModel(
  modelId: string | null,
  models: readonly RuntimeProviderModelDto[]
): string {
  if (!modelId) return 'OpenCode default';
  if (modelId === OPENROUTER_FREE_MODEL_ID) return 'Free Models Router';
  return models.find((model) => model.modelId === modelId)?.displayName ?? modelId;
}

export function presentOpenCodeDefaultModelInheritance(input: {
  readonly view: RuntimeProviderManagementViewDto | null;
  readonly projectPath: string | null;
  readonly projectName: string | null;
}): OpenCodeDefaultModelPresentation {
  const { view } = input;
  const models = view?.configuredModels ?? [];
  const baseModelId =
    view?.allProjectsDefaultModel ??
    (view?.defaultModelSource === 'project' ? null : (view?.defaultModel ?? null));
  const projectOverrideModelId = view?.projectDefaultModel ?? null;
  const projectEffectiveModelId = projectOverrideModelId ?? baseModelId ?? view?.defaultModel ?? null;
  return {
    baseModelId,
    baseDisplayName: displayModel(baseModelId, models),
    projectPath: input.projectPath,
    projectName: input.projectName,
    projectOverrideModelId,
    projectEffectiveModelId,
    projectEffectiveDisplayName: displayModel(projectEffectiveModelId, models),
    projectInherits: projectOverrideModelId === null,
    effectiveSource: view?.defaultModelSource ?? null,
  };
}

export function projectBaseDefaultMutation(
  view: RuntimeProviderManagementViewDto | null,
  modelId: string
): RuntimeProviderManagementViewDto | null {
  if (!view) return view;
  const projectOverride = view.projectDefaultModel;
  return {
    ...view,
    allProjectsDefaultModel: modelId,
    defaultModel: projectOverride ?? modelId,
    defaultModelSource: projectOverride ? 'project' : 'all_projects',
  };
}

export function projectClearedDefaultMutation(
  view: RuntimeProviderManagementViewDto | null
): RuntimeProviderManagementViewDto | null {
  if (!view) return view;
  const inherited = view.allProjectsDefaultModel ?? view.fallbackModel ?? null;
  return {
    ...view,
    projectDefaultModel: null,
    defaultModel: inherited,
    defaultModelSource: view.allProjectsDefaultModel ? 'all_projects' : inherited ? 'fallback' : null,
  };
}
