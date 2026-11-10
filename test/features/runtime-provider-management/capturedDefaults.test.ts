// @vitest-environment node
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createCapturedRuntimeProviderManagementClient } from '../../../src/features/runtime-provider-management/main/adapters/output/CapturedRuntimeProviderManagementClient';
import type { CapturedProviderManagement } from '../../../src/features/agent-backend/main';
import type { JsonValue } from '@agent-teams/legacy-agent-host/contracts';

async function fixture(configuredAuthless = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-captured-defaults-')));
  const projectRoot = join(root, 'project'),
    globalRoot = join(root, 'global');
  await mkdir(projectRoot);
  await mkdir(globalRoot);
  let current = true,
    probeOk = true,
    failRefresh = false,
    catalogs = 0;
  const calls: string[] = [];
  const requestedLimits: unknown[] = [];
  const target: CapturedProviderManagement = {
    targetId: 'a'.repeat(64),
    profileId: 'TEST-profile',
    configRevision: 'TEST-v1',
    preferences: { projectRoot, globalRoot },
    isCurrent: () => current,
    async request(operation, payload): Promise<JsonValue> {
      calls.push(operation);
      if (operation === 'probe.start') {
        requestedLimits.push(payload.limits);
        return {
          ok: true,
          value: {
            commandId: payload.commandId!,
            profileId: target.profileId,
            configRevision: target.configRevision,
            providerId: 'TEST-provider',
            modelId: 'TEST-provider/TEST-model',
            ...(payload.limits ? { limits: payload.limits } : {}),
            phase: 'completed',
            ok: probeOk,
            expiresAt: Date.now() + 10000,
          },
        };
      }
      if (operation !== 'catalog') throw new Error('Unexpected operation');
      catalogs++;
      if (failRefresh && catalogs > 2) throw new Error('TEST refresh unavailable');
      return {
        ok: true,
        value: {
          profileId: target.profileId,
          configRevision: target.configRevision,
          configuredDefaultModelId: 'TEST-provider/TEST-native',
          providers: [
            {
              providerId: 'TEST-provider',
              displayName: 'TEST Provider',
              source: 'config',
              connected: true,
              configured: true,
              configuredAuthless,
              defaultModelId: null,
              modelCount: 1,
              authMethods: ['api'],
              models: payload.providerId
                ? [
                    {
                      modelId: 'TEST-model',
                      displayName: 'TEST Model',
                      contextTokens: 8192,
                      outputTokens: 1024,
                      free: false,
                    },
                  ]
                : [],
            },
          ],
        },
      };
    },
  };
  const capture = vi.fn(async (_path: string | null) => target);
  const port = createCapturedRuntimeProviderManagementClient({ capture });
  return {
    root,
    target,
    port,
    capture,
    calls,
    requestedLimits,
    projectRoot,
    globalRoot,
    projectFile: join(projectRoot, 'agent-teams-runtime-preferences.json'),
    globalFile: join(globalRoot, 'global-runtime-preferences.json'),
    failProbe: () => {
      probeOk = false;
    },
    failRefresh: () => {
      failRefresh = true;
    },
    stale: () => {
      current = false;
    },
  };
}
const input = {
  runtimeId: 'opencode' as const,
  providerId: 'TEST-provider',
  modelId: 'TEST-provider/TEST-model',
  projectPath: '/TEST/project',
};

it('saves only after an actual probe and uses the same captured owner for preference publication and refresh', async () => {
  const f = await fixture();
  const result = await f.port.setDefaultModel(input);
  expect(result.view).toMatchObject({
    projectDefaultModel: input.modelId,
    defaultModel: input.modelId,
    defaultModelSource: 'project',
  });
  expect(f.calls).toContain('probe.start');
  expect(f.capture).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(f.projectFile, 'utf8')).defaultModelId).toBe(input.modelId);
  expect((await f.port.loadModels(input)).models?.models[0]?.default).toBe(true);
});

it('global default explicitly selects the global binding and project clear reveals inherited global value', async () => {
  const f = await fixture();
  expect(
    (await f.port.setDefaultModel({ ...input, scope: 'all_projects', probe: false })).view
      ?.allProjectsDefaultModel
  ).toBe(input.modelId);
  expect(f.capture).toHaveBeenCalledWith(null);
  await f.port.setDefaultModel({ ...input, probe: false });
  expect((await f.port.clearProjectDefaultModel(input)).view).toMatchObject({
    projectDefaultModel: null,
    defaultModel: input.modelId,
    defaultModelSource: 'all_projects',
  });
});

it('probe failure, missing model, corrupt preferences and a stale context never publish a new default', async () => {
  const f = await fixture();
  f.failProbe();
  expect((await f.port.setDefaultModel(input)).error).toBeDefined();
  await expect(readFile(f.projectFile)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(
    (await f.port.setDefaultModel({ ...input, modelId: 'TEST-provider/TEST-missing' })).error?.code
  ).toBe('model-missing');
  const corrupted = await fixture();
  await writeFile(corrupted.projectFile, '{TEST-corrupt');
  expect((await corrupted.port.setDefaultModel(input)).error).toBeDefined();
  expect(corrupted.calls).not.toContain('probe.start');
  const stale = await fixture();
  stale.stale();
  expect((await stale.port.setDefaultModel(input)).error).toBeDefined();
  await expect(readFile(stale.projectFile)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('saved preferences remain visible with degraded status if the subsequent native refresh fails', async () => {
  const f = await fixture();
  f.failRefresh();
  const result = await f.port.setDefaultModel({ ...input, probe: false });
  expect(result.view).toMatchObject({
    defaultModel: input.modelId,
    runtime: { state: 'degraded' },
  });
  expect(result.view?.diagnostics[0]).toContain('saved');
  expect(JSON.parse(await readFile(f.projectFile, 'utf8')).defaultModelId).toBe(input.modelId);
});

it('authless defaults still probe when probe:false, and local limit updates persist only the exact tested values', async () => {
  const f = await fixture(true);
  await writeFile(
    f.projectFile,
    JSON.stringify({
      schemaVersion: 2,
      defaultModelId: input.modelId,
      custom: 'TEST-preserved',
      modelLimitOverrides: {
        [input.modelId]: { contextTokens: 8192, outputTokens: 1024, extra: 'TEST-preserved' },
      },
    })
  );
  expect((await f.port.setDefaultModel({ ...input, probe: false })).view).toBeDefined();
  expect(f.calls.filter((call) => call === 'probe.start')).toHaveLength(1);
  const result = await f.port.configureModelLimits({
    ...input,
    contextTokens: 4096,
    outputTokens: 128,
  });
  expect(result.result).toMatchObject({
    saved: true,
    verified: true,
    contextTokens: 4096,
    outputTokens: 128,
  });
  expect(JSON.parse(await readFile(f.projectFile, 'utf8'))).toMatchObject({
    defaultModelId: input.modelId,
    custom: 'TEST-preserved',
    modelLimitOverrides: {
      [input.modelId]: { contextTokens: 4096, outputTokens: 128, extra: 'TEST-preserved' },
    },
  });
  f.failProbe();
  expect(
    (await f.port.configureModelLimits({ ...input, contextTokens: 2048, outputTokens: 64 })).error
  ).toBeDefined();
  expect(
    JSON.parse(await readFile(f.projectFile, 'utf8')).modelLimitOverrides[input.modelId]
      .contextTokens
  ).toBe(4096);
});

it('limits reject invalid numbers, missing project or a non-local model without native inference or writes', async () => {
  const f = await fixture();
  for (const bad of [
    { contextTokens: 100, outputTokens: 101 },
    { contextTokens: Infinity, outputTokens: 1 },
    { contextTokens: 1000, outputTokens: 128, projectPath: null },
    { contextTokens: 1000, outputTokens: 128 },
  ]) {
    expect((await f.port.configureModelLimits({ ...input, ...bad })).error).toBeDefined();
  }
  expect(f.calls).not.toContain('probe.start');
  await expect(readFile(f.projectFile)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('ordinary model test and default verification consume saved limits from the same captured preference binding', async () => {
  const f = await fixture(true);
  const limits = { contextTokens: 4096, outputTokens: 128 };
  expect((await f.port.configureModelLimits({ ...input, ...limits })).result?.saved).toBe(true);
  expect((await f.port.testModel(input)).result?.ok).toBe(true);
  expect((await f.port.setDefaultModel(input)).view?.defaultModel).toBe(input.modelId);
  expect(f.requestedLimits).toEqual([limits, limits, limits]);
});
