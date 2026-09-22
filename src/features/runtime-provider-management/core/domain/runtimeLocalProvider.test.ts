/* eslint-disable sonarjs/no-clear-text-protocols -- plain-HTTP LAN base URLs are the validation subject */
import { describe, expect, it } from 'vitest';

import {
  buildRuntimeLocalProviderModelRoute,
  isPrivateNetworkRuntimeLocalProviderUrl,
  isRuntimeLocalProviderLoopbackUrl,
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

  it('allows loopback and trusted remote HTTPS URLs for custom providers', () => {
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
    expect(
      normalizeRuntimeLocalProviderTarget({
        presetId: 'custom',
        providerId: 'omniroute',
        baseUrl: 'https://models.example.com/openai/v1/',
      })
    ).toMatchObject({
      providerId: 'omniroute',
      baseUrl: 'https://models.example.com/openai/v1',
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
    ).toThrow('must use HTTPS');
    expect(() =>
      normalizeRuntimeLocalProviderTarget({
        presetId: 'ollama',
        baseUrl: 'https://models.example.com/v1',
      })
    ).toThrow('Choose Custom OpenAI-compatible server');
    expect(() =>
      normalizeRuntimeLocalProviderTarget({
        presetId: 'ollama',
        baseUrl: 'https://192.168.4.55/v1',
        allowPrivateNetwork: true,
      })
    ).toThrow('Choose Custom OpenAI-compatible server');
    expect(() =>
      normalizeRuntimeLocalProviderTarget({
        presetId: 'custom',
        providerId: 'omniroute',
        baseUrl: 'https://0.0.0.0/v1',
      })
    ).toThrow('reachable host');
    expect(() =>
      normalizeRuntimeLocalProviderTarget({
        presetId: 'custom',
        providerId: 'omniroute',
        baseUrl: 'https://[ff02::1]/v1',
      })
    ).toThrow('reachable host');
  });

  it('requires explicit opt-in for every supported private and link-local range', () => {
    for (const privateBaseUrl of [
      'http://192.168.4.55:38016/v1',
      'https://192.168.4.56:38016/v1',
      'http://10.0.0.7:8080/v1',
      'http://172.16.0.2:8080/v1',
      'http://169.254.20.3:8080/v1',
      'http://mini.local:1234/v1',
      'http://[fc00::1]:8080/v1',
      'http://[fd12:3456::1]:8080/v1',
      'http://[fe80::1]:8080/v1',
      'http://[fe90::1]:8080/v1',
      'http://[febf::1]:8080/v1',
    ]) {
      expect(() =>
        normalizeRuntimeLocalProviderTarget({
          presetId: 'custom',
          providerId: 'lan',
          baseUrl: privateBaseUrl,
        })
      ).toThrow('Enable local network access');
      expect(
        normalizeRuntimeLocalProviderTarget({
          presetId: 'custom',
          providerId: 'lan',
          baseUrl: privateBaseUrl,
          allowPrivateNetwork: true,
        }).baseUrl
      ).toBe(privateBaseUrl);
    }

    // Private-network consent does not weaken the HTTPS requirement for public hosts.
    expect(() =>
      normalizeRuntimeLocalProviderTarget({
        presetId: 'custom',
        providerId: 'local',
        baseUrl: 'http://example.com/v1',
        allowPrivateNetwork: true,
      })
    ).toThrow('must use HTTPS');
    expect(() =>
      normalizeRuntimeLocalProviderTarget({
        presetId: 'custom',
        providerId: 'local',
        baseUrl: 'http://8.8.8.8/v1',
        allowPrivateNetwork: true,
      })
    ).toThrow('must use HTTPS');
  });

  it('classifies private-network URLs for the setup UI', () => {
    expect(isPrivateNetworkRuntimeLocalProviderUrl('http://192.168.4.55:38016/v1')).toBe(true);
    expect(isPrivateNetworkRuntimeLocalProviderUrl('https://[fd12:3456::1]/v1')).toBe(true);
    expect(isPrivateNetworkRuntimeLocalProviderUrl('http://127.0.0.1:11434/v1')).toBe(false);
    expect(isPrivateNetworkRuntimeLocalProviderUrl('http://localhost:1234/v1')).toBe(false);
    expect(isPrivateNetworkRuntimeLocalProviderUrl('http://example.com/v1')).toBe(false);
    expect(isPrivateNetworkRuntimeLocalProviderUrl('not a url')).toBe(false);
    expect(isRuntimeLocalProviderLoopbackUrl('http://127.0.0.2:11434/v1')).toBe(true);
    expect(isRuntimeLocalProviderLoopbackUrl('http://[::1]:11434/v1')).toBe(true);
    expect(isRuntimeLocalProviderLoopbackUrl('https://models.example.com/v1')).toBe(false);
  });
  /* eslint-enable sonarjs/no-clear-text-protocols */

  it('rejects unsafe model identifiers', () => {
    expect(normalizeRuntimeLocalProviderModelId(' qwen3:8b ')).toBe('qwen3:8b');
    expect(normalizeRuntimeLocalProviderModelId('bad\nmodel')).toBeNull();
    expect(normalizeRuntimeLocalProviderModelId('')).toBeNull();
  });
});
