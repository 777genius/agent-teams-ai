// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { CodexAccountEnvBuilder } from '@features/codex-account/main/infrastructure/CodexAccountEnvBuilder';

describe('CodexAccountEnvBuilder', () => {
  it('strips provider-routing flags and API keys from the control-plane env', () => {
    const builder = new CodexAccountEnvBuilder();

    const env = builder.buildControlPlaneEnv({
      env: {
        HOME: '/Users/tester',
        USERPROFILE: '/Users/tester',
        OPENAI_API_KEY: 'openai-key',
        CODEX_API_KEY: 'codex-key',
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
        CLAUDE_CODE_CODEX_BACKEND: 'codex-native',
      },
      shellEnv: {
        PATH: '/usr/local/bin',
      },
    });

    expect(env.HOME).toBe('/Users/tester');
    expect(env.USERPROFILE).toBe('/Users/tester');
    expect(env.PATH).toBe('/usr/local/bin');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
    expect(env.CLAUDE_CODE_CODEX_BACKEND).toBeUndefined();
  });

  it('removes API keys from execution env when ChatGPT mode is selected', () => {
    const builder = new CodexAccountEnvBuilder();

    const env = builder.applyExecutionAuthPolicy(
      {
        OPENAI_API_KEY: 'openai-key',
        CODEX_API_KEY: 'codex-key',
      },
      {
        effectiveAuthMode: 'chatgpt',
      }
    );

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
  });

  it('injects both OPENAI_API_KEY and CODEX_API_KEY in API-key mode', () => {
    const builder = new CodexAccountEnvBuilder();

    const env = builder.applyExecutionAuthPolicy(
      {},
      {
        effectiveAuthMode: 'api_key',
        apiKeyValue: 'stored-key',
      }
    );

    expect(env.OPENAI_API_KEY).toBe('stored-key');
    expect(env.CODEX_API_KEY).toBe('stored-key');
  });
});
