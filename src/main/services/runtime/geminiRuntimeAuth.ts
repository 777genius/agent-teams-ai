import * as fs from 'fs';
import * as path from 'path';

export interface GeminiGlobalConfig {
  geminiBackendPreference?: 'auto' | 'api' | 'cli' | 'cli-sdk';
  geminiResolvedBackend?: 'api' | 'cli' | 'cli-sdk';
  geminiLastAuthMethod?: string;
  geminiProjectId?: string;
}

export interface GeminiRuntimeAuthState {
  authenticated: boolean;
  authMethod: string | null;
  resolvedBackend: 'auto' | 'api' | 'cli-sdk';
  projectId: string | null;
  statusMessage: string | null;
}

function normalizeGeminiBackend(
  value: string | null | undefined
): GeminiRuntimeAuthState['resolvedBackend'] {
  if (value === 'api') return 'api';
  if (value === 'cli' || value === 'cli-sdk') return 'cli-sdk';
  return 'auto';
}

function resolveEffectiveGeminiBackend(
  requestedBackend: GeminiRuntimeAuthState['resolvedBackend'],
  authMethod: string | null,
  hasGeminiApiKey: boolean,
  hasAdcWithProject: boolean
): Exclude<GeminiRuntimeAuthState['resolvedBackend'], 'auto'> | 'auto' {
  if (requestedBackend !== 'auto') {
    return requestedBackend;
  }
  if (hasGeminiApiKey || hasAdcWithProject) {
    return 'api';
  }
  if (authMethod === 'cli_oauth_personal') {
    return 'cli-sdk';
  }
  return 'auto';
}

export async function readGeminiGlobalConfig(
  env: NodeJS.ProcessEnv
): Promise<GeminiGlobalConfig | null> {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  const candidates = configDir
    ? [path.join(configDir, '.config.json')]
    : home
      ? [path.join(home, '.claude', '.config.json'), path.join(home, '.claude.json')]
      : [];

  for (const candidate of candidates) {
    try {
      const raw = await fs.promises.readFile(candidate, 'utf8');
      return JSON.parse(raw) as GeminiGlobalConfig;
    } catch {
      continue;
    }
  }

  return null;
}

export async function resolveGeminiRuntimeAuth(
  env: NodeJS.ProcessEnv
): Promise<GeminiRuntimeAuthState> {
  const config = await readGeminiGlobalConfig(env);
  const resolvedBackend = normalizeGeminiBackend(
    env.CLAUDE_CODE_GEMINI_BACKEND?.trim() ||
      config?.geminiResolvedBackend?.trim() ||
      config?.geminiBackendPreference?.trim()
  );
  const authMethod = config?.geminiLastAuthMethod?.trim() ?? null;
  const projectId =
    env.GOOGLE_CLOUD_PROJECT?.trim() ||
    env.GOOGLE_CLOUD_PROJECT_ID?.trim() ||
    env.GCLOUD_PROJECT?.trim() ||
    config?.geminiProjectId?.trim() ||
    null;
  const hasGeminiApiKey = Boolean(env.GEMINI_API_KEY?.trim());
  const hasAdcWithProject = Boolean(
    (authMethod === 'adc_authorized_user' || authMethod === 'adc_service_account') && projectId
  );
  const effectiveBackend = resolveEffectiveGeminiBackend(
    resolvedBackend,
    authMethod,
    hasGeminiApiKey,
    hasAdcWithProject
  );

  if (hasGeminiApiKey) {
    return {
      authenticated: true,
      authMethod: 'api_key',
      resolvedBackend: effectiveBackend,
      projectId,
      statusMessage: null,
    };
  }

  if (hasAdcWithProject) {
    return {
      authenticated: true,
      authMethod,
      resolvedBackend: effectiveBackend,
      projectId,
      statusMessage: null,
    };
  }

  if (authMethod === 'cli_oauth_personal' && effectiveBackend === 'cli-sdk') {
    return {
      authenticated: true,
      authMethod,
      resolvedBackend: 'cli-sdk',
      projectId,
      statusMessage: null,
    };
  }

  if (authMethod === 'cli_oauth_personal') {
    return {
      authenticated: false,
      authMethod,
      resolvedBackend: effectiveBackend,
      projectId,
      statusMessage:
        'Gemini CLI OAuth was detected, but the active Gemini backend is not set to CLI SDK.',
    };
  }

  return {
    authenticated: false,
    authMethod,
    resolvedBackend,
    projectId,
    statusMessage:
      'Gemini provider is not configured for runtime use. Set GEMINI_API_KEY or Google ADC credentials (plus GOOGLE_CLOUD_PROJECT when needed) and retry.',
  };
}
