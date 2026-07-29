import type {
  RuntimeLocalProviderConfigureInput,
  RuntimeLocalProviderConfigureResponse,
  RuntimeLocalProviderPresetIdDto,
} from '../contracts';
import type { TeamsAPI } from '@shared/types/api';

export interface OpenCodeLocalModelSetupTarget {
  providerId: string;
  modelId: string;
  modelRoute: string;
  presetId: RuntimeLocalProviderPresetIdDto;
  baseUrl: string;
  privateNetworkApproved: boolean;
  configuredModelIds?: readonly string[];
}

export interface OpenCodeLocalModelSetupResult {
  status: 'ready' | 'needs_verification' | 'incompatible' | 'experimental' | 'error';
  message: string;
}

export interface OpenCodeLocalModelSetupDependencies {
  configureLocalProvider: (
    input: RuntimeLocalProviderConfigureInput
  ) => Promise<RuntimeLocalProviderConfigureResponse>;
  prepareProvisioning: TeamsAPI['prepareProvisioning'];
}

export async function addAndTestOpenCodeLocalModel({
  projectPath,
  target,
  dependencies,
  onConfigured,
}: {
  projectPath: string;
  target: OpenCodeLocalModelSetupTarget;
  dependencies: OpenCodeLocalModelSetupDependencies;
  onConfigured?: () => void | Promise<void>;
}): Promise<OpenCodeLocalModelSetupResult> {
  const normalizedProjectPath = projectPath.trim();
  if (!normalizedProjectPath) {
    return { status: 'error', message: 'Choose a project before adding this local model.' };
  }

  try {
    const modelIds = Array.from(new Set([...(target.configuredModelIds ?? []), target.modelId]));
    const configured = await dependencies.configureLocalProvider({
      runtimeId: 'opencode',
      scope: 'project',
      projectPath: normalizedProjectPath,
      presetId: target.presetId,
      baseUrl: target.baseUrl,
      providerId: target.providerId,
      defaultModelId: target.modelId,
      modelIds,
      preserveAvailableConfiguredModels: true,
      setAsDefault: false,
      allowPrivateNetwork: target.privateNetworkApproved,
    });
    if (configured.error || !configured.configuration) {
      return {
        status: 'error',
        message: configured.error?.message ?? 'Could not add this local model to the project.',
      };
    }

    try {
      await onConfigured?.();
    } catch {
      // The deep verification remains authoritative if the surrounding catalog refresh fails.
    }

    const readiness = await dependencies.prepareProvisioning(
      normalizedProjectPath,
      'opencode',
      ['opencode'],
      [target.modelRoute],
      false,
      'deep'
    );
    if (!readiness.ready) {
      const issue =
        readiness.issues?.find(
          (candidate) =>
            candidate.severity === 'blocking' &&
            candidate.scope === 'model' &&
            candidate.modelId === target.modelRoute
        ) ??
        readiness.issues?.find(
          (candidate) =>
            candidate.severity === 'blocking' &&
            (candidate.providerId === 'opencode' || candidate.scope === 'provider')
        );
      return {
        status: issue?.experimentalOverrideAvailable ? 'experimental' : 'incompatible',
        message:
          issue?.message ||
          readiness.message ||
          'The model was added, but it is not compatible with Agent Teams.',
      };
    }
    const readinessWarning =
      readiness.issues?.find(
        (candidate) =>
          candidate.severity === 'warning' &&
          (candidate.modelId === target.modelRoute || candidate.scope === 'provider')
      )?.message ?? readiness.warnings?.[0];

    if (readinessWarning) {
      return {
        status: 'needs_verification',
        message: readinessWarning,
      };
    }

    return {
      status: 'ready',
      message: readiness.message || 'Model verified for this project.',
    };
  } catch (error) {
    return {
      status: 'error',
      message:
        error instanceof Error && error.message.trim()
          ? error.message
          : 'Could not add and test this local model.',
    };
  }
}
