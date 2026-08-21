import type { RuntimeLocalProviderConfigurationDto } from '../contracts';

interface LocalModelReadiness {
  readonly message?: string;
  readonly issues?: readonly {
    readonly severity: string;
    readonly modelId?: string;
    readonly scope?: string;
    readonly message: string;
  }[];
}

export const LOCAL_PROVIDER_MODEL_TEST_REQUEST_GROUP_ID = 'runtime-local-provider-setup:model-test';

export const getProjectName = (projectPath: string): string =>
  projectPath.split(/[/\\]/).filter(Boolean).pop() ?? projectPath;

export function getLocalModelVerificationCwd(
  configuration: RuntimeLocalProviderConfigurationDto,
  targetProjectPath: string | null
): string {
  const projectPath = targetProjectPath?.trim();
  if (projectPath) return projectPath;
  const configPath = configuration.configPath.trim();
  const separatorIndex = Math.max(configPath.lastIndexOf('/'), configPath.lastIndexOf('\\'));
  return separatorIndex > 0 ? configPath.slice(0, separatorIndex) : configPath;
}

export function getLocalModelReadinessError(
  readiness: LocalModelReadiness,
  modelRoute: string
): string {
  const modelIssue = readiness.issues?.find(
    (issue) =>
      issue.severity === 'blocking' && (issue.modelId === modelRoute || issue.scope === 'provider')
  );
  return (
    modelIssue?.message ||
    readiness.message ||
    'The model is configured, but it is not ready for Agent Teams launch.'
  );
}
