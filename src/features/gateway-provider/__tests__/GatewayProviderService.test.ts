import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { GatewayCredentialStore } from '../main/adapters/output/GatewayCredentialStore';
import { GatewayProviderService } from '../main/application/GatewayProviderService';
import { JsonGatewayProviderStore } from '../main/infrastructure/JsonGatewayProviderStore';

import type { ApiKeyEntry } from '@shared/types/extensions/apikey';

class FakeApiKeys {
  private sequence = 0;
  readonly records = new Map<string, string>();

  async save(input: { value: string }): Promise<ApiKeyEntry> {
    const id = `key-${++this.sequence}`;
    this.records.set(id, input.value);
    return {
      id,
      name: id,
      envVarName: 'GATEWAY_API_KEY',
      maskedValue: '***',
      scope: 'user',
      createdAt: new Date().toISOString(),
    };
  }

  async readValueById(id: string): Promise<string | null> {
    return this.records.get(id) ?? null;
  }
}

async function createService(): Promise<{
  service: GatewayProviderService;
  apiKeys: FakeApiKeys;
  store: JsonGatewayProviderStore;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-service-'));
  const store = new JsonGatewayProviderStore(join(dir, 'store.json'));
  const apiKeys = new FakeApiKeys();
  const service = new GatewayProviderService({
    store,
    credentials: new GatewayCredentialStore(apiKeys),
    clock: { now: () => new Date('2026-10-19T12:00:00.000Z') },
    probeModels: async () => ['claude-sonnet-4-5'],
    readUsageDay: async () => [],
  });
  return { service, apiKeys, store };
}

describe('GatewayProviderService', () => {
  it('retires all deleted-team bindings while retaining history, credentials and other teams', async () => {
    const { service, store, apiKeys } = await createService();
    const profile = await service.saveProfile({
      displayName: 'Deleted team',
      baseUrl: 'http://127.0.0.1:8080',
    });
    const otherProfile = await service.saveProfile({
      displayName: 'Other team',
      baseUrl: 'http://127.0.0.1:8080',
    });
    const first = await service.bindMember({
      teamName: 'deleted',
      memberName: 'alice',
      profileId: profile.id,
      apiKey: 'deleted-alice-key',
    });
    await service.bindMember({
      teamName: 'deleted',
      memberName: 'bob',
      profileId: profile.id,
      apiKey: 'deleted-bob-key',
    });
    await service.bindMember({
      teamName: 'survivor',
      memberName: 'alice',
      profileId: otherProfile.id,
      apiKey: 'survivor-alice-key',
    });
    await service.markRuntimeArtifactActive(first.gatewayUsageRef);
    await service.unbindTeam(' deleted ');
    const retired = await store.read();
    expect(retired.bindings).toHaveLength(1);
    expect(retired.bindings[0].teamName).toBe('survivor');
    expect(retired.sources).toHaveLength(3);
    expect(
      retired.sources
        .filter((source) => source.teamName === 'deleted')
        .every(
          (source) =>
            !source.hasActiveBinding && source.lastUnboundAt === '2026-10-19T12:00:00.000Z'
        )
    ).toBe(true);
    expect(
      retired.sources.find((source) => source.gatewayUsageRef === first.gatewayUsageRef)
        ?.hasRuntimeArtifact
    ).toBe(true);
    expect(apiKeys.records.size).toBe(3);
    await service.unbindTeam('deleted');
    expect(await store.read()).toEqual(retired);
    await expect(
      service.bindMember({
        teamName: 'survivor',
        memberName: 'bob',
        profileId: profile.id,
        apiKey: 'deleted-alice-key',
      })
    ).rejects.toThrow('belongs to another teammate');
    await service.deleteProfile(profile.id);
    expect(
      (await service.listUsageSources()).filter((source) => source.teamName === 'deleted')
    ).toHaveLength(2);
    expect(await service.resolveMemberConnection('survivor', 'alice')).not.toBeNull();
  });

  it('persists the default agent identity and exposes it for older source records', async () => {
    const { service, store } = await createService();
    const profile = await service.saveProfile({
      displayName: 'Local',
      baseUrl: 'http://127.0.0.1:8080',
    });
    const owner = {
      teamName: 'team',
      memberName: 'alice',
      profileId: profile.id,
      apiKey: 'gw-key-alice',
    };
    await service.bindMember(owner);
    expect((await store.read()).sources[0].agentId).toBe('team:alice');
    await store.mutate(async (state) => {
      delete state.sources[0].agentId;
    });
    expect((await service.listUsageSources())[0].agentId).toBe('team:alice');
    await service.bindMember(owner);
    expect((await store.read()).sources[0].agentId).toBe('team:alice');
  });

  it('retires the previous binding on a key switch while keeping same-source rebinds active', async () => {
    const { service, store } = await createService();
    const profile = await service.saveProfile({
      displayName: 'Local',
      baseUrl: 'http://127.0.0.1:8080',
    });
    const owner = { teamName: 'team', memberName: 'alice', profileId: profile.id };
    const first = await service.bindMember({ ...owner, apiKey: 'gw-key-before' });
    await service.markRuntimeArtifactActive(first.gatewayUsageRef);

    const second = await service.bindMember({ ...owner, apiKey: 'gw-key-after' });
    const switched = await store.read();
    expect(switched.bindings).toHaveLength(1);
    expect(switched.bindings[0].gatewayUsageRef).toBe(second.gatewayUsageRef);
    const retired = switched.sources.find(
      (source) => source.gatewayUsageRef === first.gatewayUsageRef
    );
    expect(retired).toMatchObject({
      hasActiveBinding: false,
      lastUnboundAt: '2026-10-19T12:00:00.000Z',
      hasRuntimeArtifact: true,
    });

    await service.bindMember({ ...owner, apiKey: 'gw-key-after' });
    const rebound = await store.read();
    expect(rebound.sources).toHaveLength(2);
    const current = rebound.sources.find(
      (source) => source.gatewayUsageRef === second.gatewayUsageRef
    );
    expect(current?.hasActiveBinding).toBe(true);
    expect(current?.lastUnboundAt).toBeUndefined();
    expect(
      rebound.sources.find((source) => source.gatewayUsageRef === first.gatewayUsageRef)
        ?.hasActiveBinding
    ).toBe(false);
  });

  it('reuses the usage source for the same key and restores a deleted secret', async () => {
    const { service, apiKeys, store } = await createService();
    const profile = await service.saveProfile({
      displayName: 'Local',
      baseUrl: 'http://127.0.0.1:8080/v1',
    });
    const first = await service.bindMember({
      teamName: 'team',
      memberName: 'alice',
      profileId: profile.id,
      apiKey: 'gw-key-alice',
    });
    const state = await store.read();
    expect(state.sources).toHaveLength(1);
    expect(state.sources[0].allowPrivateNetwork).toBe(false);
    expect(state.sources[0].canonicalEndpoint).toBe('http://127.0.0.1:8080');

    await service.unbindMember({ teamName: 'team', memberName: 'alice' });
    expect((await store.read()).sources[0].hasActiveBinding).toBe(false);

    apiKeys.records.delete('key-1');
    const second = await service.bindMember({
      teamName: 'team',
      memberName: 'alice',
      profileId: profile.id,
      apiKey: 'gw-key-alice',
    });
    const restored = await store.read();
    expect(second.gatewayUsageRef).toBe(first.gatewayUsageRef);
    expect(restored.sources).toHaveLength(1);
    expect(restored.sources[0].secretStorageRef).toBe('key-2');
  });

  it('rejects another owner and a different endpoint before probing', async () => {
    const { service } = await createService();
    const profile = await service.saveProfile({
      displayName: 'Local',
      baseUrl: 'http://127.0.0.1:8080',
    });
    await service.bindMember({
      teamName: 'team',
      memberName: 'alice',
      profileId: profile.id,
      apiKey: 'gw-key-alice',
    });
    await expect(
      service.bindMember({
        teamName: 'team',
        memberName: 'bob',
        profileId: profile.id,
        apiKey: 'gw-key-alice',
      })
    ).rejects.toThrow(/another teammate/i);

    const other = await service.saveProfile({
      displayName: 'Other',
      baseUrl: 'http://127.0.0.1:9090',
    });
    await expect(
      service.probeModels({ profileId: other.id, apiKey: 'gw-key-alice' })
    ).rejects.toThrow(/another gateway endpoint/i);
  });

  it('keeps the approval snapshot after profile removal and blocks URL edits while bound', async () => {
    const { service, store } = await createService();
    const profile = await service.saveProfile({
      displayName: 'LAN',
      baseUrl: 'https://192.168.1.20',
      allowPrivateNetwork: true,
    });
    const binding = await service.bindMember({
      teamName: 'team',
      memberName: 'alice',
      profileId: profile.id,
      apiKey: 'gw-key-alice',
    });
    await expect(
      service.saveProfile({
        id: profile.id,
        displayName: 'LAN',
        baseUrl: 'https://192.168.1.21',
        allowPrivateNetwork: true,
      })
    ).rejects.toThrow(/Unbind teammates/i);

    await service.unbindMember({ teamName: 'team', memberName: 'alice' });
    await service.deleteProfile(profile.id);
    const sources = await service.listUsageSources();
    expect(sources).toHaveLength(1);
    expect(sources[0].gatewayUsageRef).toBe(binding.gatewayUsageRef);
    expect(sources[0].canonicalEndpoint).toBe('https://192.168.1.20');
    expect(sources[0].allowPrivateNetwork).toBe(true);
    expect((await store.read()).profiles).toHaveLength(0);
  });

  it('serializes concurrent binds without creating duplicate sources', async () => {
    const { service, store } = await createService();
    const profile = await service.saveProfile({
      displayName: 'Local',
      baseUrl: 'http://127.0.0.1:8080',
    });
    await Promise.all([
      service.bindMember({
        teamName: 'team',
        memberName: 'alice',
        profileId: profile.id,
        apiKey: 'gw-key-alice',
      }),
      service.bindMember({
        teamName: 'team',
        memberName: 'alice',
        profileId: profile.id,
        apiKey: 'gw-key-alice',
      }),
    ]);
    const state = await store.read();
    expect(state.bindings).toHaveLength(1);
    expect(state.sources).toHaveLength(1);
  });
});

it('conditionally unbinds only the expected draft binding, retaining a newer owner selection', async () => {
  const { service, store } = await createService();
  const profile = await service.saveProfile({
    displayName: 'Local',
    baseUrl: 'http://127.0.0.1:8080',
  });
  const owner = { teamName: 'team', memberName: 'alice', profileId: profile.id };
  const first = await service.bindMember({ ...owner, apiKey: 'gw-before' });
  const second = await service.bindMember({ ...owner, apiKey: 'gw-after' });
  await service.unbindMember({ ...owner, expectedBinding: first });
  expect((await service.listBindings('team'))[0].gatewayUsageRef).toBe(second.gatewayUsageRef);
  await service.unbindMember({ ...owner, expectedBinding: { ...second, boundAt: 'stale-time' } });
  expect((await store.read()).bindings).toHaveLength(1);
  await service.unbindMember({ ...owner, expectedBinding: second });
  expect((await store.read()).bindings).toHaveLength(0);
});
