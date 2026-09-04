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

const diagnostic = vi.hoisted(() => vi.fn());

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    diagnostic,
  }),
}));

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

  /**
   * `opencode.jsonc` is one of the two paths this module probes, and a user's
   * own config carries what the extension promises: comments and a trailing
   * comma. Read as strict JSON the file parses to nothing, the provider the
   * members were running on is never narrowed to, and the runtime keeps the
   * model resident with no team left to serve.
   */
  it('reads a jsonc config with comments and a trailing comma', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-opencode-jsonc-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'opencode.jsonc');
    fs.writeFileSync(
      configPath,
      [
        '{',
        '  // the runtime this machine serves models from',
        '  "provider": {',
        '    "local-provider": { "options": { "baseURL": "http://127.0.0.1:9999/v1" } },',
        '  },',
        '}',
        '',
      ].join('\n')
    );

    expect([...resolveLocalProviderOrigins({ configPaths: [configPath] })]).toEqual([
      ['local-provider', 'http://127.0.0.1:9999'],
    ]);
  });

  it('reports a config it could not parse instead of skipping it in silence', () => {
    diagnostic.mockClear();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-opencode-broken-'));
    tempDirs.push(dir);
    const configPath = path.join(dir, 'opencode.jsonc');
    fs.writeFileSync(configPath, '{ "provider": [[[ ');

    expect([...resolveLocalProviderOrigins({ configPaths: [configPath] })]).toEqual([]);
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(String(diagnostic.mock.calls[0]?.[0])).toContain(
      'opencode_loopback_runtime_config_unreadable'
    );
  });

  it('says nothing about a config that is simply not there', () => {
    diagnostic.mockClear();

    expect([
      ...resolveLocalProviderOrigins({
        configPaths: [path.join(os.tmpdir(), 'at-opencode-absent', 'opencode.jsonc')],
      }),
    ]).toEqual([]);
    expect(diagnostic).not.toHaveBeenCalled();
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
   * A runtime with no release endpoint at all answers 404 there. It still knows
   * what it is holding, and it drops a model when a generate call carries
   * keep_alive 0, so the fallback asks it what is loaded and evicts each one.
   */
  it('evicts the loaded models of a runtime that has no release endpoint', async () => {
    const configPath = writeConfig({
      'local-provider': { options: { baseURL: 'http://127.0.0.1:9999/v1' } },
    });
    const calls: { url: string; body?: string }[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      if (url.endsWith('/api/models/unload')) return new Response('', { status: 404 });
      if (url.endsWith('/api/ps')) {
        return new Response(JSON.stringify({ models: [{ name: 'model-a' }] }), { status: 200 });
      }
      return okOnce();
    });

    const result = await releaseLoopbackRuntimeModels({
      configPaths: [configPath],
      fetchImpl,
      env: {},
      memberModels: ['local-provider/model-a'],
    });

    expect(calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:9999/api/models/unload',
      'http://127.0.0.1:9999/api/ps',
      'http://127.0.0.1:9999/api/generate',
    ]);
    expect(JSON.parse(calls[2]?.body ?? '{}')).toEqual({ model: 'model-a', keep_alive: 0 });
    expect(result.released).toEqual(['local-provider']);
    expect(result.diagnostics).toEqual(['local-provider: evicted model-a']);
  });

  /**
   * The narrowing the whole module is built on has to survive the last step.
   * A loopback runtime is a shared machine service, so what it holds beyond
   * what the stopped members were running belongs to another application, to
   * another session, or to a chat window the user has open right now.
   */
  it('evicts only the models the stopped members were running', async () => {
    const configPath = writeConfig({
      'local-provider': { options: { baseURL: 'http://127.0.0.1:9999/v1' } },
    });
    const evicted: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith('/api/models/unload')) return new Response('', { status: 404 });
      if (url.endsWith('/api/ps')) {
        return new Response(
          JSON.stringify({ models: [{ name: 'model-a' }, { name: 'somebody-elses-model' }] }),
          { status: 200 }
        );
      }
      evicted.push(
        String(
          (JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { model?: string })
            .model
        )
      );
      return okOnce();
    });

    const result = await releaseLoopbackRuntimeModels({
      configPaths: [configPath],
      fetchImpl,
      env: {},
      memberModels: ['local-provider/model-a'],
    });

    expect(evicted).toEqual(['model-a']);
    expect(result.released).toEqual(['local-provider']);
    expect(result.diagnostics).toEqual([
      'local-provider: evicted model-a',
      'local-provider: kept somebody-elses-model: no stopped member was running it',
    ]);
  });

  /**
   * The one case that does drop everything, and the reason the filter is a
   * `null` rather than an empty set: at app exit there is no team left to
   * attribute a reservation to, so every loaded model is this app's to release.
   */
  it('evicts every loaded model when there is no member to attribute one to', async () => {
    const configPath = writeConfig({
      'local-provider': { options: { baseURL: 'http://127.0.0.1:9999/v1' } },
    });
    const evicted: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith('/api/models/unload')) return new Response('', { status: 404 });
      if (url.endsWith('/api/ps')) {
        return new Response(
          JSON.stringify({ models: [{ name: 'model-a' }, { name: 'model-b' }] }),
          {
            status: 200,
          }
        );
      }
      evicted.push(
        String(
          (JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { model?: string })
            .model
        )
      );
      return okOnce();
    });

    await releaseLoopbackRuntimeModels({ configPaths: [configPath], fetchImpl, env: {} });

    expect(evicted).toEqual(['model-a', 'model-b']);
  });

  // The other side of that boundary. Only a 404 means "no such endpoint"; any
  // other error status is a runtime that has one and failed to serve it, and
  // asking it a second question in a different protocol would be guessing.
  it('never asks a runtime that answered with an error status what it has loaded', async () => {
    const configPath = writeConfig({
      'local-provider': { options: { baseURL: 'http://127.0.0.1:9999/v1' } },
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('', { status: 500 }));

    const result = await releaseLoopbackRuntimeModels({
      configPaths: [configPath],
      fetchImpl,
      env: {},
      memberModels: ['local-provider/model-a'],
    });

    expect(fetchImpl.mock.calls.map((call) => requestUrl(call[0]))).toEqual([
      'http://127.0.0.1:9999/api/models/unload',
    ]);
    expect(result.released).toEqual([]);
    expect(result.diagnostics).toEqual(['local-provider: release returned HTTP 500']);
  });

  it('reports a runtime that has neither a release endpoint nor a loaded-model list', async () => {
    const configPath = writeConfig({
      'local-provider': { options: { baseURL: 'http://127.0.0.1:9999/v1' } },
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('', { status: 404 }));

    const result = await releaseLoopbackRuntimeModels({
      configPaths: [configPath],
      fetchImpl,
      env: {},
      memberModels: ['local-provider/model-a'],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.released).toEqual([]);
    expect(result.diagnostics).toEqual([
      'local-provider: no release endpoint and no loaded-model list (HTTP 404)',
    ]);
  });

  it('holds a runtime released only when a model was actually evicted', async () => {
    const configPath = writeConfig({
      'local-provider': { options: { baseURL: 'http://127.0.0.1:9999/v1' } },
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.endsWith('/api/models/unload')) return new Response('', { status: 404 });
      if (url.endsWith('/api/ps')) {
        return new Response(JSON.stringify({ models: [{ model: 'model-a' }] }), { status: 200 });
      }
      return new Response('', { status: 503 });
    });

    const result = await releaseLoopbackRuntimeModels({
      configPaths: [configPath],
      fetchImpl,
      env: {},
      memberModels: ['local-provider/model-a'],
    });

    expect(result.released).toEqual([]);
    expect(result.diagnostics).toEqual(['local-provider: evicting model-a returned HTTP 503']);
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
