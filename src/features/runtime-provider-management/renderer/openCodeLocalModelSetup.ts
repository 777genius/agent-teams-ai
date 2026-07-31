import type {
  RuntimeLocalProviderConfigureInput,
  RuntimeLocalProviderConfigureResponse,
  RuntimeLocalProviderPresetIdDto,
  RuntimeProviderManagementModelTestResponse,
  RuntimeProviderManagementTestModelInput,
} from '../contracts';
import type { TeamsAPI } from '@shared/types/api';

export interface OpenCodeLocalModelSetupTarget {
  providerId: string;
  modelId: string;
  modelRoute: string;
  presetId: RuntimeLocalProviderPresetIdDto;
  baseUrl: string;
}

export interface OpenCodeLocalModelSetupResult {
  status: 'ready' | 'incompatible' | 'experimental' | 'error';
  message: string;
}

export interface OpenCodeLocalModelSetupDependencies {
  configureLocalProvider(
    input: RuntimeLocalProviderConfigureInput
  ): Promise<RuntimeLocalProviderConfigureResponse>;
  prepareProvisioning: TeamsAPI['prepareProvisioning'];
  testModel(
    input: RuntimeProviderManagementTestModelInput
  ): Promise<RuntimeProviderManagementModelTestResponse>;
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
    return {
      status: 'error',
      message: 'Choose a project before adding this local model.',
    };
  }

  try {
    const configured = await dependencies.configureLocalProvider({
      runtimeId: 'opencode',
      scope: 'project',
      projectPath: normalizedProjectPath,
      presetId: target.presetId,
      baseUrl: target.baseUrl,
      providerId: target.providerId,
      defaultModelId: target.modelId,
      setAsDefault: false,
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
      // Verification below remains authoritative even if the surrounding list refresh failed.
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

    const verification = await dependencies.testModel({
      runtimeId: 'opencode',
      projectPath: normalizedProjectPath,
      providerId: target.providerId,
      modelId: target.modelRoute,
    });
    if (verification.error || !verification.result?.ok) {
      return {
        status: 'incompatible',
        message:
          verification.error?.message ||
          verification.result?.message ||
          'OpenCode could not complete a model request.',
      };
    }

    return {
      status: 'ready',
      message: verification.result.message || 'Model verified for this project.',
    };
  } catch {
    return {
      status: 'error',
      message: 'Could not add and test this local model.',
    };
  }
}
