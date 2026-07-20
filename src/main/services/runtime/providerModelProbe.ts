import type { CliProviderId, TeamProviderId } from '@shared/types';

const PROVIDER_MODEL_PROBE_TIMEOUT_MS = 60_000;
const PROVIDER_MODEL_PROBE_CODEX_TIMEOUT_MS = 60_000;
const PROVIDER_MODEL_PROBE_GEMINI_TIMEOUT_MS = 15_000;
const PROVIDER_MODEL_PROBE_PROMPT = 'Output only the single word PONG.';

type SupportedProviderId = CliProviderId | TeamProviderId;

function resolveProbeProviderId(providerId: SupportedProviderId | undefined): SupportedProviderId {
  return providerId === 'codex' || providerId === 'gemini' ? providerId : 'anthropic';
}

export function getProviderModelProbePrompt(): string {
  return PROVIDER_MODEL_PROBE_PROMPT;
}

export function getProviderModelProbeExpectedOutput(): string {
  return 'PONG';
}

export function isProviderModelProbeSuccessOutput(output: string): boolean {
  return new RegExp(`\\b${getProviderModelProbeExpectedOutput()}\\b`, 'i').test(output.trim());
}

export function classifyProviderModelProbeFailure(message: string): 'unavailable' | 'unknown' {
  const lower = message.toLowerCase();

  if (
    lower.includes('model is not supported') ||
    lower.includes('model not supported') ||
    lower.includes('unsupported model') ||
    lower.includes('model is not available') ||
    lower.includes('model not available') ||
    lower.includes('model unavailable') ||
    lower.includes('model not found') ||
    lower.includes('unknown model') ||
    lower.includes('invalid model')
  ) {
    return 'unavailable';
  }

  return 'unknown';
}

export function isProviderModelProbeTimeoutMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('timeout running:') ||
    lower.includes('timed out') ||
    lower.includes('etimedout') ||
    lower.includes('did not complete')
  );
}

export function normalizeProviderModelProbeFailureReason(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return 'Model verification failed';
  }

  if (
    /The '[^']+' model is not supported when using Codex with a ChatGPT account\./i.test(trimmed)
  ) {
    return 'Not available on this Codex native runtime';
  }
  if (/The requested model is not available for your account\./i.test(trimmed)) {
    return 'Not available for this account';
  }
  if (isProviderModelProbeTimeoutMessage(trimmed)) {
    return 'Model verification timed out';
  }

  return trimmed;
}

export function buildProviderModelProbeArgs(modelId: string): string[] {
  return [
    '-p',
    getProviderModelProbePrompt(),
    '--output-format',
    'text',
    '--model',
    modelId,
    '--max-turns',
    '1',
    '--no-session-persistence',
  ];
}

export function buildCodexExecModelProbeArgs(modelId: string): string[] {
  return [
    'exec',
    '--ignore-user-config',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '--model',
    modelId,
    getProviderModelProbePrompt(),
  ];
}

export function getProviderModelProbeTimeoutMs(
  providerId: SupportedProviderId | undefined
): number {
  switch (resolveProbeProviderId(providerId)) {
    case 'codex':
      return PROVIDER_MODEL_PROBE_CODEX_TIMEOUT_MS;
    case 'gemini':
      return PROVIDER_MODEL_PROBE_GEMINI_TIMEOUT_MS;
    case 'anthropic':
    default:
      return PROVIDER_MODEL_PROBE_TIMEOUT_MS;
  }
}

export function getProviderPreflightModel(
  providerId: TeamProviderId | undefined,
  options: { modelOverride?: string | null } = {}
): string {
  const modelOverride = options.modelOverride?.trim();
  if (modelOverride) {
    return modelOverride;
  }

  switch (resolveProbeProviderId(providerId)) {
    case 'codex':
      return 'gpt-5.6-sol';
    case 'gemini':
      return 'gemini-2.5-flash-lite';
    case 'anthropic':
    default:
      return 'haiku';
  }
}

export function buildProviderPreflightPingArgs(
  providerId: TeamProviderId | undefined,
  options: { modelOverride?: string | null } = {}
): string[] {
  return buildProviderModelProbeArgs(getProviderPreflightModel(providerId, options));
}
