// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import {
  releaseLoopbackRuntimesReservedByTeam,
  releaseSharedRuntimeResourcesAfterStop,
} from '@main/services/team/lifecycle/teamForceStopFlow';
import {
  releaseLoopbackRuntimeModels,
  releaseLoopbackRuntimesOnAppShutdown,
} from '@main/services/team/opencode/bridge/OpenCodeLoopbackRuntimeRelease';

const fixture = vi.hoisted(() => ({ teams: '' }));
vi.mock('@main/utils/pathDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/utils/pathDecoder')>()),
  getTeamsBasePath: () => fixture.teams,
}));
vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    diagnostic: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

afterEach(() => vi.restoreAllMocks());

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a test TCP endpoint');
  return `http://127.0.0.1:${address.port}`;
}

it('never unloads a global or historical reservation during automatic stop and shutdown', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'at-release-owned-test-'));
  const requests: string[] = [];
  const globalRuntime = createServer((req, res) => {
    requests.push(`global:${req.url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  const projectRuntime = createServer((req, res) => {
    requests.push(`project:${req.url}`);
    res.writeHead(200);
    res.end('{}');
  });
  try {
    const globalOrigin = await listen(globalRuntime);
    const projectOrigin = await listen(projectRuntime);
    const project = path.join(root, 'test-project');
    const configDir = path.join(root, '.config', 'opencode');
    fixture.teams = path.join(root, 'teams');
    await mkdir(configDir, { recursive: true });
    await mkdir(project);
    await mkdir(path.join(fixture.teams, 'historical-team'), { recursive: true });
    const config = (origin: string) =>
      JSON.stringify({ provider: { ollama: { options: { baseURL: `${origin}/v1` } } } });
    const globalConfig = path.join(configDir, 'opencode.json');
    await writeFile(globalConfig, config(globalOrigin));
    await writeFile(path.join(project, 'opencode.json'), config(projectOrigin));
    await writeFile(
      path.join(fixture.teams, 'historical-team', 'config.json'),
      JSON.stringify({
        projectPath: project,
        members: [{ name: 'lead', model: 'ollama/qwen3' }],
      })
    );
    vi.spyOn(os, 'homedir').mockReturnValue(root);
    const purgeHostStartupLocks = vi.fn(() =>
      Promise.resolve({
        scanned: 0,
        removed: 0,
        kept: 0,
        diagnostics: [],
        locksDir: path.join(root, 'locks'),
      })
    );
    await releaseSharedRuntimeResourcesAfterStop({
      teamName: 'historical-team',
      otherAliveTeams: [],
      purgeHostStartupLocks,
      releaseSharedLocalRuntime: () =>
        releaseLoopbackRuntimesReservedByTeam(fixture.teams, 'historical-team'),
    });
    await releaseLoopbackRuntimesOnAppShutdown();
    expect(purgeHostStartupLocks).toHaveBeenCalledOnce();
    expect(requests).toEqual([]);

    // Positive control: the real HTTP observer detects an explicit low-level
    // release. Neither fetch nor the release implementation is mocked.
    await releaseLoopbackRuntimeModels({
      configPaths: [globalConfig],
      memberModels: ['ollama/qwen3'],
      env: {},
    });
    expect(requests).toEqual(['global:/api/models/unload']);
  } finally {
    await Promise.all(
      [globalRuntime, projectRuntime].map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            if (!server.listening) return resolve();
            server.close((error) => (error ? reject(error) : resolve()));
          })
      )
    );
    await rm(root, { recursive: true, force: true });
  }
});
