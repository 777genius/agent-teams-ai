/* eslint-disable sonarjs/no-clear-text-protocols -- plain-HTTP LAN base URLs are the validation subject */
import { describe, expect, it } from 'vitest';

import {
  buildRuntimeLocalProviderModelRoute,
  isPrivateNetworkRuntimeLocalProviderUrl,
  normalizeRuntimeLocalProviderModelId,
  normalizeRuntimeLocalProviderTarget,
  RuntimeLocalProviderValidationError,
} from './runtimeLocalProvider';

describe('runtimeLocalProvider', () => {
  it('normalizes built-in presets to stable OpenCode provider routes', () => {
    expect(normalizeRuntimeLocalProviderTarget({ presetId: 'ollama' })).toMatchObject({
      providerId: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
    });
    expect(
      normalizeRuntimeLocalProviderTarget({
        presetId: 'lm-studio',
        baseUrl: 'http://localhost:1234/',
      })
    ).toMatchObject({ providerId: 'lmstudio', baseUrl: 'http://localhost:1234/v1' });
    expect(buildRuntimeLocalProviderModelRoute('atomic-chat', 'qwen3:8b')).toBe(
      'atomic-chat/qwen3:8b'
    );
  });

  it('allows a validated custom provider id on loopback only', () => {
    expect(
      normalizeRuntimeLocalProviderTarget({
        presetId: 'custom',
        providerId: 'my-local',
        baseUrl: 'https://127.0.0.2:9443/openai/v1/',
      })
    ).toMatchObject({
      providerId: 'my-local',
      baseUrl: 'https://127.0.0.2:9443/openai/v1',
    });

    expect(() =>
      normalizeRuntimeLocalProviderTarget({
        presetId: 'custom',
        providerId: 'My Local',
      })
    ).toThrow(RuntimeLocalProviderValidationError);
    expect(() =>
      normalizeRuntimeLocalProviderTarget({
        presetId: 'custom',
        providerId: 'local',
        baseUrl: 'http://example.com/v1',
      })
    ).toThrow('localhost or a private local-network address');
  });

  it('requires explicit opt-in for private local-network addresses', () => {
    expect(() =>
      normalizeRuntimeLocalProviderTarget({
        presetId: 'custom',
        providerId: 'homeserver',
        baseUrl: 'http://192.168.4.55:38016/v1',
      })
    ).toThrow('Enable local network access');

    expect(
      normalizeRuntimeLocalProviderTarget({
        presetId: 'custom',
        providerId: 'homeserver',
        baseUrl: 'http://192.168.4.55:38016/v1',
        allowPrivateNetwork: true,
      })
    ).toMatchObject({
      providerId: 'homeserver',
      baseUrl: 'http://192.168.4.55:38016/v1',
    });

    for (const privateBaseUrl of [
      'http://10.0.0.7:8080/v1',
      'http://172.16.0.2:8080/v1',
      'http://mini.local:1234/v1',
      'http://[fd12:3456::1]:8080/v1',
    ]) {
      expect(
        normalizeRuntimeLocalProviderTarget({
          presetId: 'custom',
          providerId: 'lan',
          baseUrl: privateBaseUrl,
          allowPrivateNetwork: true,
        }).baseUrl
      ).toBe(privateBaseUrl);
    }

    // Public hosts stay rejected even with the opt-in.
    expect(() =>
      normalizeRuntimeLocalProviderTarget({
        presetId: 'custom',
        providerId: 'local',
        baseUrl: 'http://example.com/v1',
        allowPrivateNetwork: true,
      })
    ).toThrow(RuntimeLocalProviderValidationError);
    expect(() =>
      normalizeRuntimeLocalProviderTarget({
        presetId: 'custom',
        providerId: 'local',
        baseUrl: 'http://8.8.8.8/v1',
        allowPrivateNetwork: true,
      })
    ).toThrow(RuntimeLocalProviderValidationError);
  });

  it('classifies private-network URLs for the setup UI', () => {
    expect(isPrivateNetworkRuntimeLocalProviderUrl('http://192.168.4.55:38016/v1')).toBe(true);
    expect(isPrivateNetworkRuntimeLocalProviderUrl('http://127.0.0.1:11434/v1')).toBe(false);
    expect(isPrivateNetworkRuntimeLocalProviderUrl('http://localhost:1234/v1')).toBe(false);
    expect(isPrivateNetworkRuntimeLocalProviderUrl('http://example.com/v1')).toBe(false);
    expect(isPrivateNetworkRuntimeLocalProviderUrl('not a url')).toBe(false);
  });
  /* eslint-enable sonarjs/no-clear-text-protocols */

  it('rejects unsafe model identifiers', () => {
    expect(normalizeRuntimeLocalProviderModelId(' qwen3:8b ')).toBe('qwen3:8b');
    expect(normalizeRuntimeLocalProviderModelId('bad\nmodel')).toBeNull();
    expect(normalizeRuntimeLocalProviderModelId('')).toBeNull();
  });
});
