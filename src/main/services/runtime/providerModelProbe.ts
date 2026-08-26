import { randomBytes } from 'crypto';

import type {
  CliProviderId,
  EffortLevel,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';

const PROVIDER_MODEL_PROBE_TIMEOUT_MS = 60_000;
const PROVIDER_MODEL_PROBE_CODEX_TIMEOUT_MS = 60_000;
const PROVIDER_MODEL_PROBE_GEMINI_TIMEOUT_MS = 15_000;
const PROVIDER_MODEL_PROBE_RESPONSE_SCHEMA = 'agent-teams-provider-probe-response-v1';
const PROVIDER_MODEL_PROBE_EXECUTION_SCHEMA = 'agent-teams-provider-execution-v1';

type SupportedProviderId = CliProviderId | TeamProviderId;

function resolveProbeProviderId(providerId: SupportedProviderId | undefined): SupportedProviderId {
  return providerId === 'codex' || providerId === 'gemini' ? providerId : 'anthropic';
}

export interface ProviderModelProbeResponse {
  schema: typeof PROVIDER_MODEL_PROBE_RESPONSE_SCHEMA;
  nonce: string;
}

/** Metadata supplied by a trusted process or CLI transport, never model output. */
export interface ProviderModelProbeExecutionMetadata {
  schema: typeof PROVIDER_MODEL_PROBE_EXECUTION_SCHEMA;
  nonce: string;
  providerId: TeamProviderId;
  providerBackendId: TeamProviderBackendId | null;
  model: string;
  effort: EffortLevel | null;
}

export function createProviderModelProbeNonce(): string {
  return randomBytes(32).toString('hex');
}

export function getProviderModelProbePrompt(nonce = 'NONCE'): string {
  return [
    'Return one JSON object as the entire model response, with no markdown or commentary.',
    `Use schema ${PROVIDER_MODEL_PROBE_RESPONSE_SCHEMA}.`,
    `Set nonce to ${nonce}.`,
    'Do not report provider, backend, model, or effort; those are accepted only from trusted runtime transport metadata.',
  ].join(' ');
}

export function parseProviderModelProbeResponse(
  output: string,
  expectedNonce: string
): ProviderModelProbeResponse | null {
  const trimmed = output.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isUnknownRecord(value)) return null;
  if (
    value.schema !== PROVIDER_MODEL_PROBE_RESPONSE_SCHEMA ||
    value.nonce !== expectedNonce
  ) {
    return null;
  }
  return {
    schema: PROVIDER_MODEL_PROBE_RESPONSE_SCHEMA,
    nonce: expectedNonce,
  };
}

export function isProviderModelProbeSuccessOutput(output: string, expectedNonce: string): boolean {
  return parseProviderModelProbeResponse(output, expectedNonce) !== null;
}

export function validateProviderModelProbeExecutionMetadata(
  value: unknown,
  expectedNonce: string
): ProviderModelProbeExecutionMetadata | null {
  if (!isUnknownRecord(value)) return null;
  if (
    value.schema !== PROVIDER_MODEL_PROBE_EXECUTION_SCHEMA ||
    value.nonce !== expectedNonce ||
    !isTeamProviderId(value.providerId) ||
    !isNullableTeamProviderBackendId(value.providerBackendId) ||
    typeof value.model !== 'string' ||
    !value.model.trim() ||
    !isNullableEffort(value.effort)
  ) {
    return null;
  }
  return {
    schema: PROVIDER_MODEL_PROBE_EXECUTION_SCHEMA,
    nonce: expectedNonce,
    providerId: value.providerId,
    providerBackendId: value.providerBackendId,
    model: value.model.trim(),
    effort: value.effort,
  };
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

export function buildProviderModelProbeArgs(modelId: string, nonce?: string): string[] {
  return [
    '-p',
    getProviderModelProbePrompt(nonce),
    '--output-format',
    'text',
    '--model',
    modelId,
    '--max-turns',
    '1',
    '--no-session-persistence',
  ];
}

export function buildCodexExecModelProbeArgs(modelId: string, nonce?: string): string[] {
  return [
    'exec',
    '--ignore-user-config',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '--model',
    modelId,
    getProviderModelProbePrompt(nonce),
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
  options: { modelOverride?: string | null; nonce?: string } = {}
): string[] {
  return buildProviderModelProbeArgs(getProviderPreflightModel(providerId, options), options.nonce);
}

export function bindProviderModelProbeNonce(args: readonly string[], nonce: string): string[] {
  const unboundPrompt = getProviderModelProbePrompt();
  return args.map((arg) => (arg === unboundPrompt ? getProviderModelProbePrompt(nonce) : arg));
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTeamProviderId(value: unknown): value is TeamProviderId {
  return value === 'anthropic' || value === 'codex' || value === 'gemini' || value === 'opencode';
}

function isNullableTeamProviderBackendId(value: unknown): value is TeamProviderBackendId | null {
  return (
    value === null ||
    value === 'auto' ||
    value === 'adapter' ||
    value === 'api' ||
    value === 'cli-sdk' ||
    value === 'codex-native' ||
    value === 'opencode-cli'
  );
}

function isNullableEffort(value: unknown): value is EffortLevel | null {
  return (
    value === null ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'minimal' ||
    value === 'none' ||
    value === 'ultra'
  );
}
