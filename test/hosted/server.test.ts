import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveHostedServerConfig, resolveHostedStaticRequest } from '../../src/hosted/server';

describe('hosted startup shell server', () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const path of cleanupPaths.splice(0)) {
      rmSync(path, { force: true, recursive: true });
    }
  });

  it('defaults to loopback and requires explicit opt-in for remote binds', () => {
    const defaultConfig = resolveHostedServerConfig({});
    expect(defaultConfig.host).toBe('127.0.0.1');
    expect(defaultConfig.port).toBe(3456);

    expect(() => resolveHostedServerConfig({ HOST: '0.0.0.0' })).toThrow(/HOSTED_ALLOW_REMOTE=1/);
    expect(() => resolveHostedServerConfig({ PORT: '3456abc' })).toThrow(
      /Invalid hosted server port/
    );
    expect(
      resolveHostedServerConfig({
        HOST: '0.0.0.0',
        HOSTED_ALLOW_REMOTE: '1',
        PORT: '4567',
      })
    ).toMatchObject({
      host: '0.0.0.0',
      port: 4567,
    });
  });

  it('resolves renderer assets and SPA fallback without exposing application APIs', () => {
    const rendererRoot = mkdtempSync(join(tmpdir(), 'agent-teams-hosted-'));
    cleanupPaths.push(rendererRoot);
    mkdirSync(join(rendererRoot, 'assets'));
    writeFileSync(join(rendererRoot, 'index.html'), '<html><body>hosted shell</body></html>');
    writeFileSync(join(rendererRoot, 'assets', 'app.js'), 'console.log("hosted");');

    expect(
      resolveHostedStaticRequest({ host: '127.0.0.1', port: 0, rendererRoot }, 'GET', '/')
    ).toMatchObject({
      filePath: join(rendererRoot, 'index.html'),
      statusCode: 200,
    });
    expect(
      resolveHostedStaticRequest({ host: '127.0.0.1', port: 0, rendererRoot }, 'GET', '/teams/demo')
    ).toMatchObject({
      filePath: join(rendererRoot, 'index.html'),
      statusCode: 200,
    });
    expect(
      resolveHostedStaticRequest(
        { host: '127.0.0.1', port: 0, rendererRoot },
        'GET',
        '/assets/app.js'
      )
    ).toMatchObject({
      contentType: 'text/javascript; charset=utf-8',
      filePath: join(rendererRoot, 'assets', 'app.js'),
      statusCode: 200,
    });
    expect(
      resolveHostedStaticRequest({ host: '127.0.0.1', port: 0, rendererRoot }, 'GET', '/api')
    ).toEqual({
      statusCode: 404,
    });
    expect(
      resolveHostedStaticRequest({ host: '127.0.0.1', port: 0, rendererRoot }, 'GET', '/api/health')
    ).toEqual({
      statusCode: 404,
    });
  });

  it('rejects path traversal and non-GET methods before file serving', () => {
    const rendererRoot = mkdtempSync(join(tmpdir(), 'agent-teams-hosted-'));
    cleanupPaths.push(rendererRoot);
    writeFileSync(join(rendererRoot, 'index.html'), '<html><body>hosted shell</body></html>');

    const missingAsset = resolveHostedStaticRequest(
      { host: '127.0.0.1', port: 0, rendererRoot },
      'GET',
      '/assets/missing.js'
    );
    const traversal = resolveHostedStaticRequest(
      { host: '127.0.0.1', port: 0, rendererRoot },
      'GET',
      '/%2e%2e/%2e%2e/package.json'
    );
    const post = resolveHostedStaticRequest(
      { host: '127.0.0.1', port: 0, rendererRoot },
      'POST',
      '/'
    );

    expect(missingAsset).toEqual({ statusCode: 404 });
    expect(traversal).toEqual({ statusCode: 404 });
    expect(post).toEqual({ statusCode: 405 });
  });
});
