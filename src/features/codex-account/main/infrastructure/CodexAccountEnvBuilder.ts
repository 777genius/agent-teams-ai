import { buildRuntimeBaseEnv } from '@main/services/runtime/buildRuntimeBaseEnv';
import { getCachedShellEnv } from '@main/utils/shellEnv';

import type { CodexAccountEffectiveAuthMode } from '@features/codex-account/contracts';

const CODEX_API_KEY_ENV_VAR = 'CODEX_API_KEY';
const OPENAI_API_KEY_ENV_VAR = 'OPENAI_API_KEY';
const PROVIDER_ROUTING_ENV_KEYS = [
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_ENTRY_PROVIDER',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_GEMINI_BACKEND',
  'CLAUDE_CODE_CODEX_BACKEND',
] as const;

export class CodexAccountEnvBuilder {
  buildControlPlaneEnv(options: {
    binaryPath?: string | null;
    shellEnv?: NodeJS.ProcessEnv | null;
    env?: NodeJS.ProcessEnv;
  }): NodeJS.ProcessEnv {
    const { env } = buildRuntimeBaseEnv({
      binaryPath: options.binaryPath,
      shellEnv: options.shellEnv ?? getCachedShellEnv() ?? {},
      env: options.env,
    });

    for (const key of PROVIDER_ROUTING_ENV_KEYS) {
      delete env[key];
    }

    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    return env;
  }

  applyExecutionAuthPolicy(
    env: NodeJS.ProcessEnv,
    options: {
      effectiveAuthMode: CodexAccountEffectiveAuthMode;
      apiKeyValue?: string | null;
    }
  ): NodeJS.ProcessEnv {
    if (options.effectiveAuthMode === 'chatgpt') {
      delete env[OPENAI_API_KEY_ENV_VAR];
      delete env[CODEX_API_KEY_ENV_VAR];
      return env;
    }

    if (options.effectiveAuthMode === 'api_key' && options.apiKeyValue?.trim()) {
      env[OPENAI_API_KEY_ENV_VAR] = options.apiKeyValue.trim();
      env[CODEX_API_KEY_ENV_VAR] = options.apiKeyValue.trim();
      return env;
    }

    delete env[CODEX_API_KEY_ENV_VAR];
    if (typeof env[OPENAI_API_KEY_ENV_VAR] !== 'string' || !env[OPENAI_API_KEY_ENV_VAR]?.trim()) {
      delete env[OPENAI_API_KEY_ENV_VAR];
    }
    return env;
  }
}
