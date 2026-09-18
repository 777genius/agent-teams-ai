import { isRuntimeLocalProviderLoopbackUrl } from '../core/domain';

import type {
  RuntimeLocalProviderListEntryDto,
  RuntimeLocalProviderPresetIdDto,
  RuntimeProviderManagementErrorCodeDto,
} from '../contracts';

export const LOCAL_TEAMMATE_REQUIREMENTS = {
  title: 'Minimum for teammates',
  size: 'Smallest working size: a 7B coding model that can call tools. Example: qwen2.5-coder:7b. Anything under 3B is blocked.',
  context:
    'Need at least 16K context (32K is better). Ollama starts at 4K — raise it to 32K before launch, or teammates will fail.',
  tiny: '0.5B and 1.5B can only start as an experiment. They will not write files, use tools, or talk to the team.',
} as const;

export const SERVER_START_GUIDANCE: Record<RuntimeLocalProviderPresetIdDto, string> = {
  ollama:
    'Start Ollama and pull at least qwen2.5-coder:7b (or another 7B+ tool-calling coder) with 16K+ context. Ollama starts at 4K — raise context to 32K before launch.',
  'lm-studio':
    'In LM Studio, load a 7B+ tool-calling coder with at least 16K context, open Developer > Local Server, and start the server.',
  'atomic-chat':
    'Open Atomic Chat, load a 7B+ tool-calling coder with at least 16K context, and start its local API server.',
  'llama.cpp':
    'Start llama-server with a 7B+ tool-calling coder loaded and at least 16K context. The default port for this setup is 8080.',
  custom:
    'Start an OpenAI-compatible API with a working /v1/models endpoint and a 7B+ tool-calling model at 16K+ context. Public remote endpoints must use HTTPS; private-network HTTP requires explicit approval.',
};

export function getEndpointAvailabilitySummary(total: number, available: number): string {
  if (total === 0) return '';
  if (available === 0) {
    return `${total} endpoint${total === 1 ? '' : 's'} configured, but unavailable. Check the server before launching a team.`;
  }
  if (available === total) {
    return `${available} endpoint${available === 1 ? '' : 's'} configured and available for model selection.`;
  }
  return `${available} of ${total} endpoints available. Unavailable endpoints remain configured but cannot launch.`;
}

export function getProjectConfigPath(projectPath: string): string {
  const separator = projectPath.includes('\\') && !projectPath.includes('/') ? '\\' : '/';
  return `${projectPath.replace(/[/\\]+$/, '')}${separator}opencode.json`;
}

export function splitConfigPath(configPath: string): { directory: string; filename: string } {
  const separatorIndex = Math.max(configPath.lastIndexOf('/'), configPath.lastIndexOf('\\'));
  return separatorIndex < 0
    ? { directory: '', filename: configPath }
    : {
        directory: configPath.slice(0, separatorIndex + 1),
        filename: configPath.slice(separatorIndex + 1),
      };
}

export function hasConfiguredProviderApiKey(
  providers: readonly RuntimeLocalProviderListEntryDto[],
  providerId: string | null
): boolean {
  return Boolean(
    providerId && providers.find((entry) => entry.providerId === providerId)?.hasConfiguredApiKey
  );
}

export function getEndpointStatusLabel(entry: RuntimeLocalProviderListEntryDto): string {
  if (entry.state !== 'available') return 'Unavailable';
  return !isRuntimeLocalProviderLoopbackUrl(entry.baseUrl) || entry.hasConfiguredApiKey
    ? 'Configured'
    : 'Running';
}

export function getFriendlyVerificationError(
  errorCode: RuntimeProviderManagementErrorCodeDto,
  serverName: string
): string {
  switch (errorCode) {
    case 'runtime-missing':
      return 'OpenCode is not available yet. Install or repair OpenCode, then retry verification.';
    case 'runtime-misconfigured':
    case 'runtime-unhealthy':
      return 'OpenCode is not ready to run this model. Reopen provider settings, check the OpenCode status, then retry.';
    case 'provider-missing':
      return `${serverName} is saved, but OpenCode could not load this provider. Reopen provider settings, then retry.`;
    case 'auth-required':
    case 'auth-failed':
      return `${serverName} rejected the request. Check the endpoint access or API key settings, then retry.`;
    case 'model-missing':
      return `The selected model is no longer available on ${serverName}. Refresh the model list and choose another, then retry.`;
    case 'model-test-failed':
      return `OpenCode could not get a response from ${serverName}. Make sure the server and selected model are running, then retry.`;
    default:
      return 'OpenCode could not verify the model endpoint. Check the server, then retry.';
  }
}
