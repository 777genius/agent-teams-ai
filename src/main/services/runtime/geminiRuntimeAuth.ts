import * as fs from 'fs';
import * as path from 'path';

export type GeminiGlobalConfig = {
  geminiBackendPreference?: 'auto' | 'api' | 'cli';
  geminiResolvedBackend?: 'api' | 'cli';
  geminiLastAuthMethod?: string;
  geminiProjectId?: string;
};

export type GeminiRuntimeAuthState = {
  authenticated: boolean;
  authMethod: string | null;
  resolvedBackend: 'auto' | 'api' | 'cli';
  projectId: string | null;
  statusMessage: string | null;
};

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
  const resolvedBackend =
    env.CLAUDE_CODE_GEMINI_BACKEND?.trim() ||
    config?.geminiResolvedBackend?.trim() ||
    config?.geminiBackendPreference?.trim() ||
    'auto';
  const authMethod = config?.geminiLastAuthMethod?.trim() ?? null;
  const projectId =
    env.GOOGLE_CLOUD_PROJECT?.trim() ||
    env.GOOGLE_CLOUD_PROJECT_ID?.trim() ||
    env.GCLOUD_PROJECT?.trim() ||
    config?.geminiProjectId?.trim() ||
    null;
  const hasGeminiApiKey = Boolean(env.GEMINI_API_KEY?.trim());

  if (hasGeminiApiKey) {
    return {
      authenticated: true,
      authMethod: 'api_key',
      resolvedBackend:
        resolvedBackend === 'api' || resolvedBackend === 'cli' ? resolvedBackend : 'auto',
      projectId,
      statusMessage: null,
    };
  }

  if ((authMethod === 'adc_authorized_user' || authMethod === 'adc_service_account') && projectId) {
    return {
      authenticated: true,
      authMethod,
      resolvedBackend:
        resolvedBackend === 'api' || resolvedBackend === 'cli' ? resolvedBackend : 'auto',
      projectId,
      statusMessage: null,
    };
  }

  if (authMethod === 'cli_oauth_personal' && resolvedBackend === 'cli') {
    return {
      authenticated: true,
      authMethod,
      resolvedBackend: 'cli',
      projectId,
      statusMessage: null,
    };
  }

  if (authMethod === 'cli_oauth_personal') {
    return {
      authenticated: false,
      authMethod,
      resolvedBackend:
        resolvedBackend === 'api' || resolvedBackend === 'cli' ? resolvedBackend : 'auto',
      projectId,
      statusMessage:
        'Gemini CLI OAuth was detected, but the active Gemini backend is not set to cli.',
    };
  }

  return {
    authenticated: false,
    authMethod,
    resolvedBackend:
      resolvedBackend === 'api' || resolvedBackend === 'cli' ? resolvedBackend : 'auto',
    projectId,
    statusMessage:
      'Gemini provider is not configured for runtime use. Set GEMINI_API_KEY or Google ADC credentials (plus GOOGLE_CLOUD_PROJECT when needed) and retry.',
  };
}
