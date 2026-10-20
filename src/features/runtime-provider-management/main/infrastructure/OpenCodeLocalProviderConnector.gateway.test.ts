import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenCodeLocalProviderConnector } from './OpenCodeLocalProviderConnector';

import type { RuntimeLocalProviderConfigureInput } from '../../contracts';

interface TestConfig {
  model?: string;
  small_model?: string;
  customRoute?: string;
  provider: Record<
    string,
    { options: { apiKey: string; baseURL?: string }; models?: Record<string, unknown> }
  >;
}

const target = { teamName: 'sandbox', memberName: 'builder', gatewayUsageRef: 'source-1' };
const providerId = (ref = target.gatewayUsageRef): string =>
  `gateway-sandbox-builder-${createHash('sha256')
    .update(JSON.stringify([target.teamName, target.memberName, ref]))
    .digest('hex')
    .slice(0, 12)}`;
const input = (ref = target.gatewayUsageRef): RuntimeLocalProviderConfigureInput => ({
  runtimeId: 'opencode',
  scope: 'global',
  presetId: 'custom',
  providerId: providerId(ref),
  baseUrl: 'https://gateway.example/v1',
  apiKey: 'test-gateway-secret',
  defaultModelId: 'test-model',
  modelIds: ['test-model'],
  setAsDefault: false,
  setAsSmallModel: false,
});

describe('OpenCode gateway artifact ownership and retirement', () => {
  let home: string;
  let configPath: string;
  let connector: OpenCodeLocalProviderConnector;
  const fetchImpl = vi.fn<typeof fetch>();
  const approvalStore = { approve: vi.fn(), isApproved: vi.fn().mockResolvedValue(false) };

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'TEST-gateway-artifacts-'));
    configPath = path.join(home, '.config', 'opencode', 'opencode.json');
    fetchImpl
      .mockReset()
      .mockImplementation(
        async () => new Response(JSON.stringify({ data: [{ id: 'test-model' }] }))
      );
    approvalStore.approve.mockReset().mockResolvedValue(undefined);
    connector = new OpenCodeLocalProviderConnector({
      homePath: home,
      environment: {},
      fetchImpl,
      privateNetworkApprovalStore: approvalStore,
    });
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      '{\n // preserve user config\n "model":"other/large", "small_model":"other/small", "provider":{"other":{"models":{"large":{}}}}\n}\n'
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(home, { recursive: true, force: true });
  });

  const readConfig = async (): Promise<TestConfig> => parse(await fs.readFile(configPath, 'utf8'));
  const credentialPath = (reference: string): string => reference.slice('{file:'.length, -1);

  it('keeps immutable source artifacts, private credentials and user defaults across concurrent writes', async () => {
    const [first, second] = await Promise.all([
      connector.configureGatewayProvider(input(), target),
      connector.configureGatewayProvider(input('source-2'), {
        ...target,
        gatewayUsageRef: 'source-2',
      }),
    ]);
    expect(first.modelRoute).toBe(`${providerId()}/test-model`);
    expect(second.providerId).toBe(providerId('source-2'));
    const config = await readConfig();
    expect(config.model).toBe('other/large');
    expect(config.small_model).toBe('other/small');
    expect(config.provider.other).toEqual({ models: { large: {} } });
    const firstReference = config.provider[first.providerId].options.apiKey;
    expect(await fs.readFile(credentialPath(firstReference), 'utf8')).toBe('test-gateway-secret');
    expect(await fs.readFile(configPath, 'utf8')).not.toContain('test-gateway-secret');
    expect(await fs.readFile(configPath, 'utf8')).toContain('// preserve user config');
    await connector.configureGatewayProvider(input(), target);
    expect((await readConfig()).provider[first.providerId].options.apiKey).toBe(firstReference);
    await expect(
      connector.configureGatewayProvider({ ...input(), apiKey: 'changed-key' }, target)
    ).rejects.toMatchObject({ code: 'config-conflict' });
  });

  it('adds a new model route without changing the credential or deleting a live old route', async () => {
    await connector.configureGatewayProvider(input(), target);
    const reference = (await readConfig()).provider[providerId()].options.apiKey;
    fetchImpl.mockImplementation(
      async () => new Response(JSON.stringify({ data: [{ id: 'next-model' }] }))
    );
    const result = await connector.configureGatewayProvider(
      { ...input(), defaultModelId: 'next-model', modelIds: ['next-model'] },
      target
    );
    expect(result.modelRoute).toBe(`${providerId()}/next-model`);
    const provider = (await readConfig()).provider[providerId()];
    expect(provider.options.apiKey).toBe(reference);
    expect(provider.models).toEqual({ 'test-model': {}, 'next-model': {} });
    expect(await connector.retireGatewayProvider({ ...target, providerId: providerId() })).toEqual({
      retired: true,
    });
  });

  it('retire deletes only owned entry and credential and remains idempotent after restart', async () => {
    await connector.configureGatewayProvider(input(), target);
    const reference = (await readConfig()).provider[providerId()].options.apiKey;
    const retired = await connector.retireGatewayProvider({ ...target, providerId: providerId() });
    expect(retired).toEqual({ retired: true });
    expect((await readConfig()).provider[providerId()]).toBeUndefined();
    await expect(fs.stat(credentialPath(reference))).rejects.toMatchObject({ code: 'ENOENT' });
    const restarted = new OpenCodeLocalProviderConnector({
      homePath: home,
      environment: {},
      fetchImpl,
    });
    expect(await restarted.retireGatewayProvider({ ...target, providerId: providerId() })).toEqual({
      retired: true,
    });
    expect((await readConfig()).provider.other).toBeDefined();
  });

  it.each(['model', 'small_model', 'customRoute'] as const)(
    'holds artifacts referenced from %s and preserves foreign credential aliases',
    async (field) => {
      await connector.configureGatewayProvider(input(), target);
      const config = await readConfig();
      const reference = config.provider[providerId()].options.apiKey;
      config[field] = `${providerId()}/test-model`;
      await fs.writeFile(configPath, JSON.stringify(config));
      expect(
        await connector.retireGatewayProvider({ ...target, providerId: providerId() })
      ).toEqual({ retired: false });
      delete config[field];
      config.provider.other.options = {
        apiKey: `{file:~/.config/opencode/agent-teams-credentials/${path.basename(credentialPath(reference))}}`,
      };
      await fs.writeFile(configPath, JSON.stringify(config));
      expect(
        await connector.retireGatewayProvider({ ...target, providerId: providerId() })
      ).toEqual({ retired: false });
      expect(await fs.readFile(credentialPath(reference), 'utf8')).toBe('test-gateway-secret');
    }
  );

  it('rejects foreign entries and mismatched ownership without changing files', async () => {
    const config = await readConfig();
    config.provider[providerId()] = {
      options: { baseURL: 'https://foreign.example/v1', apiKey: 'foreign-key' },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    const before = await fs.readFile(configPath, 'utf8');
    await expect(connector.configureGatewayProvider(input(), target)).rejects.toMatchObject({
      code: 'config-conflict',
    });
    expect(await connector.retireGatewayProvider({ ...target, providerId: providerId() })).toEqual({
      retired: false,
    });
    expect(await fs.readFile(configPath, 'utf8')).toBe(before);
    await expect(
      connector.configureGatewayProvider(input(), { ...target, gatewayUsageRef: 'wrong-source' })
    ).rejects.toMatchObject({ code: 'config-conflict' });
  });

  it('keeps modified provider entries and does not let the ordinary editor mutate a gateway source', async () => {
    await connector.configureGatewayProvider(input(), target);
    const edited = await connector.configureLocalProvider({ ...input(), apiKey: 'replacement' });
    expect(edited.error?.code).toBe('config-conflict');
    const config = await readConfig();
    config.provider[providerId()].options.baseURL = 'https://foreign.example/v1';
    await fs.writeFile(configPath, JSON.stringify(config));
    expect(await connector.retireGatewayProvider({ ...target, providerId: providerId() })).toEqual({
      retired: false,
    });
  });

  it('resumes partial retirement after a credential unlink fails', async () => {
    await connector.configureGatewayProvider(input(), target);
    const reference = (await readConfig()).provider[providerId()].options.apiKey;
    const unlink = vi.spyOn(fs, 'unlink');
    unlink.mockRejectedValueOnce(Object.assign(new Error('test failure'), { code: 'EACCES' }));
    await expect(
      connector.retireGatewayProvider({ ...target, providerId: providerId() })
    ).rejects.toMatchObject({ code: 'EACCES' });
    expect((await readConfig()).provider[providerId()]).toBeUndefined();
    expect(await fs.stat(credentialPath(reference))).toBeDefined();
    unlink.mockRestore();
    expect(await connector.retireGatewayProvider({ ...target, providerId: providerId() })).toEqual({
      retired: true,
    });
  });

  it.skipIf(process.platform === 'win32')(
    'does not unlink a symlink credential or accept a foreign ownership marker',
    async () => {
      await connector.configureGatewayProvider(input(), target);
      const reference = (await readConfig()).provider[providerId()].options.apiKey;
      const credential = credentialPath(reference);
      const directory = path.dirname(credential);
      const markerPath = path.join(
        directory,
        (await fs.readdir(directory)).find((name) => name.endsWith('.owner.json'))!
      );
      const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
      await fs.writeFile(
        markerPath,
        JSON.stringify({ ...marker, gatewayUsageRef: 'foreign-source' })
      );
      expect(
        await connector.retireGatewayProvider({ ...target, providerId: providerId() })
      ).toEqual({
        retired: false,
      });
      await fs.writeFile(markerPath, JSON.stringify(marker));
      const foreignCredential = path.join(home, 'foreign.key');
      await fs.writeFile(foreignCredential, 'foreign-secret');
      await fs.unlink(credential);
      await fs.symlink(foreignCredential, credential);
      expect(
        await connector.retireGatewayProvider({ ...target, providerId: providerId() })
      ).toEqual({
        retired: false,
      });
      expect(await fs.readFile(foreignCredential, 'utf8')).toBe('foreign-secret');
      expect((await fs.lstat(credential)).isSymbolicLink()).toBe(true);
    }
  );

  it('requires saved private-network approval and persists approval for a permitted profile', async () => {
    await expect(
      connector.configureGatewayProvider(
        { ...input(), baseUrl: 'https://192.168.10.10/v1' },
        target
      )
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(fetchImpl).not.toHaveBeenCalled();
    await connector.configureGatewayProvider(
      { ...input(), baseUrl: 'https://192.168.10.10/v1', allowPrivateNetwork: true },
      target
    );
    expect(approvalStore.approve).toHaveBeenCalledWith({
      configPath: await fs.realpath(configPath),
      providerId: providerId(),
      baseUrl: 'https://192.168.10.10/v1',
    });
  });
});
