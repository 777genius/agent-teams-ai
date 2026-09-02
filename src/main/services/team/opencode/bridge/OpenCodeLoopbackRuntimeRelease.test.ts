import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  releaseLoopbackRuntimeModels,
  resolveLocalProviderOrigins,
  RUNTIME_RELEASE_DISABLED_ENV,
  selectProvidersUsedByModels,
} from './OpenCodeLoopbackRuntimeRelease';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeConfig(providers: Record<string, unknown>, fileName = 'opencode.json'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-opencode-config-'));
  tempDirs.push(dir);
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, JSON.stringify({ provider: providers }));
  return file;
}

/** A home directory holding the config where the module looks for it by default. */
function writeHomeConfig(providers: Record<string, unknown>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'at-opencode-home-'));
  tempDirs.push(home);
  const configDir = path.join(home, '.config', 'opencode');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'opencode.json'), JSON.stringify({ provider: providers }));
  return home;
}

/** The URL a fetch call carried, whichever of the three shapes it took. */
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function okOnce(): Response {
  return new Response('{}', { status: 200 });
}

describe('resolveLocalProviderOrigins', () => {
  it('maps the loopback providers to origins and reads the default config path', () => {
    const home = writeHomeConfig({
      'local-provider': { options: { baseURL: 'http://127.0.0.1:9999/v1' } },
      'local-provider-b': { options: { baseURL: 'http://localhost:9998/v1/' } },
      'cursor-acp': {},
      broken: { options: { baseURL: 'not a url' } },
    });

    expect([...resolveLocalProviderOrigins({ homeDir: home })]).toEqual([
      ['local-provider', 'http://127.0.0.1:9999'],
      ['local-provider-b', 'http://localhost:9998'],
    ]);
  });

  /**
   * The one rule that separates "release the runtime this team reserved" from
   * "send an HTTP request to somebody else's server". A provider that is not on
   * the loopback interface never becomes an origin, so no later step can reach
   * it however the rest of the module changes.
   */
  it('never yields an origin for a provider that is not on the loopback interface', () => {
    const configPath = writeConfig({
      remote: { options: { baseURL: 'https://api.example.com/v1' } },
      'remote-lookalike': { options: { baseURL: 'https://localhost.example.com/v1' } },
      'remote-by-ip': { options: { baseURL: 'https://10.0.0.4:9999/v1' } },
    });

    expect([...resolveLocalProviderOrigins({ configPaths: [configPath] })]).toEqual([]);
  });
});

describe('selectProvidersUsedByModels', () => {
  it('keeps only the providers the members ran on', () => {
    const origins = new Map([
      ['local-provider', 'http://127.0.0.1:9999'],
      ['local-provider-b', 'http://127.0.0.1:9998'],
    ]);

    expect([
      ...selectProvidersUsedByModels(origins, ['local-provider/model-a', 'cursor-acp/auto', null]),
    ]).toEqual([['local-provider', 'http://127.0.0.1:9999']]);
    expect([...selectProvidersUsedByModels(origins, undefined)]).toHaveLength(2);
  });
});

describe('releaseLoopbackRuntimeModels', () => {
  it('releases the loopback providers the members used', async () => {
    const configPath = writeConfig({
      'local-provider': { options: { baseURL: 'http://127.0.0.1:9999/v1' } },
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => okOnce());

    const result = await releaseLoopbackRuntimeModels({
      configPaths: [configPath],
      fetchImpl,
      env: {},
      memberModels: ['local-provider/model-a'],
    });

    expect(fetchImpl.mock.calls.map((call) => requestUrl(call[0]))).toEqual([
      'http://127.0.0.1:9999/api/models/unload',
    ]);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(result).toEqual({
      attempted: ['http://127.0.0.1:9999/api/models/unload'],
      released: ['local-provider'],
      diagnostics: [],
    });
  });

  // Negative control for the loopback rule, at the level a reviewer cares
  // about: not "it is filtered out" but "nothing was sent anywhere".
  it('contacts nothing at all when the only configured provider is remote', async () => {
    const configPath = writeConfig({
      remote: { options: { baseURL: 'https://api.example.com/v1' } },
    });
    const fetchImpl = vi.fn<typeof fetch>();

    const result = await releaseLoopbackRuntimeModels({
      configPaths: [configPath],
      fetchImpl,
      env: {},
      memberModels: ['remote/model-a'],
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ attempted: [], released: [], diagnostics: [] });
  });

  // A second loopback provider in the same config is somebody else's: the team
  // that just stopped never ran on it, so it must not hear about this stop.
  it('leaves a configured loopback provider the team did not use untouched', async () => {
    const configPath = writeConfig({
      'local-provider': { options: { baseURL: 'http://127.0.0.1:9999/v1' } },
      'local-provider-b': { options: { baseURL: 'http://127.0.0.1:9998/v1' } },
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => okOnce());

    const result = await releaseLoopbackRuntimeModels({
      configPaths: [configPath],
      fetchImpl,
      env: {},
      memberModels: ['local-provider/model-a'],
    });

    expect(fetchImpl.mock.calls.map((call) => requestUrl(call[0]))).toEqual([
      'http://127.0.0.1:9999/api/models/unload',
    ]);
    expect(result.released).toEqual(['local-provider']);
  });

  it('contacts nothing when the members ran on no loopback provider at all', async () => {
    const configPath = writeConfig({
      'local-provider': { options: { baseURL: 'http://127.0.0.1:9999/v1' } },
      'local-provider-b': { options: { baseURL: 'http://127.0.0.1:9998/v1' } },
    });
    const fetchImpl = vi.fn<typeof fetch>();

    const result = await releaseLoopbackRuntimeModels({
      configPaths: [configPath],
      fetchImpl,
      env: {},
      memberModels: ['cursor-acp/auto'],
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.attempted).toEqual([]);
  });

  it(`sends nothing and returns an empty result under ${RUNTIME_RELEASE_DISABLED_ENV}=1`, async () => {
    const configPath = writeConfig({
      'local-provider': { options: { baseURL: 'http://127.0.0.1:9999/v1' } },
    });
    const fetchImpl = vi.fn<typeof fetch>();

    const result = await releaseLoopbackRuntimeModels({
      configPaths: [configPath],
      fetchImpl,
      env: { [RUNTIME_RELEASE_DISABLED_ENV]: '1' },
      memberModels: ['local-provider/model-a'],
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({ attempted: [], released: [], diagnostics: [] });
  });

  // The paired positive: the same input without the variable does call out, so
  // the empty result above is the opt-out and not a broken fixture.
  it('calls out for the same input when the opt-out variable is absent', async () => {
    const configPath = writeConfig({
      'local-provider': { options: { baseURL: 'http://127.0.0.1:9999/v1' } },
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => okOnce());

    const result = await releaseLoopbackRuntimeModels({
      configPaths: [configPath],
      fetchImpl,
      env: {},
      memberModels: ['local-provider/model-a'],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.released).toEqual(['local-provider']);
  });

  /**
   * Every way a loopback runtime can fail to answer ends the same way: a
   * diagnostic and a result the stop can carry. Nothing here may throw, because
   * the caller is a cleanup tail that has already done the work that mattered.
   */
  it('reports a throw, an error status and a timeout as diagnostics without raising', async () => {
    const configPath = writeConfig({
      'local-provider': { options: { baseURL: 'http://127.0.0.1:9999/v1' } },
      'local-provider-b': { options: { baseURL: 'http://127.0.0.1:9998/v1' } },
      'local-provider-c': { options: { baseURL: 'http://127.0.0.1:9997/v1' } },
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.startsWith('http://127.0.0.1:9999')) throw new Error('ECONNREFUSED');
      if (url.startsWith('http://127.0.0.1:9998')) return new Response('', { status: 500 });
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });

    const result = await releaseLoopbackRuntimeModels({
      configPaths: [configPath],
      fetchImpl,
      env: {},
      memberModels: ['local-provider/model-a', 'local-provider-b/model-a', 'local-provider-c/x'],
    });

    expect(result.released).toEqual([]);
    expect(result.attempted).toHaveLength(3);
    expect(result.diagnostics).toEqual([
      'local-provider: release failed: ECONNREFUSED',
      'local-provider-b: release returned HTTP 500',
      'local-provider-c: release failed: The operation was aborted due to timeout',
    ]);
  });
});
