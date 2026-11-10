import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isConfiguredAuthless } from '../dist/adapters/providers/openCodeConfiguredAuthless.js';
import { withOpenCodeModelLimits } from '../dist/adapters/providers/withOpenCodeModelLimits.js';
import type { OpenCodeManagementProfile } from '../src/management/profile.ts';

test('frozen authless routes accept literal loopback and named native integrations, not lookalike or remote URLs', () => {
  for (const baseURL of [
    'http://localhost:11434/v1',
    'http://127.42.0.1/v1',
    'http://[::1]/v1',
    'http://0.0.0.0:1234',
  ])
    assert.equal(
      isConfiguredAuthless({
        id: 'TEST-custom',
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL },
      }),
      true
    );
  for (const baseURL of [
    'http://127.1/v1',
    'http://2130706433/v1',
    'http://localhost.example/v1',
    'http://test@localhost/v1',
    'http://10.0.0.1/v1',
  ])
    assert.equal(
      isConfiguredAuthless({
        id: 'TEST-custom',
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL },
      }),
      false
    );
  assert.equal(isConfiguredAuthless({ id: 'ollama' }), true);
  assert.equal(
    isConfiguredAuthless({
      id: 'TEST-cloud',
      npm: '@ai-sdk/openai',
      options: { baseURL: 'http://localhost/v1' },
    }),
    false
  );
});

test('limit override changes only the chosen native model and leaves the captured launch profile untouched', () => {
  const config = {
    model: 'TEST-provider/TEST-model',
    provider: {
      'TEST-provider': {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: 'http://127.0.0.1:1234', apiKey: 'TEST-dummy' },
        models: {
          'TEST-model': { name: 'TEST name', limit: { context: 8192, output: 1024, input: 4096 } },
          'TEST-other': { name: 'TEST other' },
        },
      },
    },
  };
  const bytes = JSON.stringify(config);
  const profile: OpenCodeManagementProfile = {
    provider: 'opencode',
    profileId: 'TEST-profile',
    accountBinding: 'TEST-account',
    configRevision: 'TEST-v1',
    cwd: '/TEST',
    executable: { path: '/TEST/bin', sha256: 'a'.repeat(64) },
    endpoint: 'http://127.0.0.1:1234',
    timeoutMs: 1000,
    environment: { OPENCODE_CONFIG_CONTENT: bytes },
  };
  const limited = withOpenCodeModelLimits(profile, {
    providerId: 'TEST-provider',
    modelId: 'TEST-provider/TEST-model',
    limits: { contextTokens: 4096, outputTokens: 128 },
  });
  assert.equal(profile.environment.OPENCODE_CONFIG_CONTENT, bytes);
  assert.deepEqual(JSON.parse(limited.environment.OPENCODE_CONFIG_CONTENT!), {
    ...config,
    provider: {
      ...config.provider,
      'TEST-provider': {
        ...config.provider['TEST-provider'],
        models: {
          ...config.provider['TEST-provider'].models,
          'TEST-model': { name: 'TEST name', limit: { context: 4096, output: 128 } },
        },
      },
    },
  });
});
