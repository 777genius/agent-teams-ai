import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isGatewayMemberSaved } from '@main/services/gateway/GatewayDraftRoster';
import { GatewayRunMetadataStore } from '@main/services/gateway/GatewayRunMetadataStore';
import { describe, expect, it, vi } from 'vitest';

import { GatewayCredentialStore } from '../main/adapters/output/GatewayCredentialStore';
import { GatewayProviderService } from '../main/application/GatewayProviderService';
import { createGatewayProviderFeature } from '../main/composition/createGatewayProviderFeature';
import { JsonGatewayProviderStore } from '../main/infrastructure/JsonGatewayProviderStore';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-recovery-'));
  const storePath = join(dir, 'store.json');
  const runsPath = join(dir, 'runs.json');
  const values = new Map<string, string>();
  const apiKeys = {
    async save(input: { value: string }) {
      const id = `key-${values.size}`;
      values.set(id, input.value);
      return {
        id,
        name: id,
        envVarName: 'TEST_KEY',
        maskedValue: '***',
        scope: 'user' as const,
        createdAt: '',
      };
    },
    async readValueById(id: string) {
      return values.get(id) ?? null;
    },
  };
  const credentials = new GatewayCredentialStore(apiKeys);
  const recoveryFailures: string[] = [];
  const drafts = {
    isMemberSaved: (team: string, member: string) => isGatewayMemberSaved(dir, team, member),
    hasSourceHistory: (ref: string) => new GatewayRunMetadataStore(runsPath).hasSourceHistory(ref),
    onRecoveryFailure: (team: string) => {
      recoveryFailures.push(team);
    },
    configurationOperation: (_team: string, operation: () => Promise<void>) => operation(),
  };
  const restart = () => {
    const store = new JsonGatewayProviderStore(storePath);
    const history = new GatewayRunMetadataStore(runsPath);
    const service = new GatewayProviderService({
      store,
      credentials,
      clock: { now: () => new Date('2026-10-21T00:00:00.000Z') },
      drafts,
    });
    return { service, store, history };
  };
  const first = restart();
  const profile = await first.service.saveProfile({
    displayName: 'Sandbox',
    baseUrl: 'https://gateway.example',
  });
  const bind = (service: GatewayProviderService, member: string, owner: string, apiKey = member) =>
    service.bindMember(
      { teamName: 'sandbox', memberName: member, profileId: profile.id, apiKey },
      owner
    );
  return { ...first, restart, profile, bind, dir, apiKeys, storePath, drafts, recoveryFailures };
}

describe('gateway draft recovery', () => {
  it('reclaims crashed unsaved drafts and replaced keys after a store restart', async () => {
    const { service, restart, bind, profile } = await fixture();
    await bind(service, 'alice', 'dead-renderer', 'first-key');
    await bind(service, 'alice', 'dead-renderer', 'second-key');
    // No React unmount/discard runs: a new service reads exactly the persisted bytes.
    const recovered = restart();
    await recovered.service.recoverDraftBindings();
    expect(await recovered.service.listBindings()).toEqual([]);
    expect(await recovered.service.listUsageSources()).toEqual([]);
    await recovered.service.deleteProfile(profile.id);
    const newProfile = await recovered.service.saveProfile({
      displayName: 'New',
      baseUrl: 'https://gateway.example',
    });
    await expect(
      recovered.service.bindMember(
        {
          teamName: 'new-sandbox',
          memberName: 'bob',
          profileId: newProfile.id,
          apiKey: 'first-key',
        },
        'new-renderer'
      )
    ).resolves.toMatchObject({ memberName: 'bob' });
    await expect(
      recovered.service.bindMember(
        {
          teamName: 'new-sandbox',
          memberName: 'charlie',
          profileId: newProfile.id,
          apiKey: 'second-key',
        },
        'new-renderer'
      )
    ).resolves.toMatchObject({ memberName: 'charlie' });
  });

  it('retains saved offline rosters and native launch history without runtime artifacts', async () => {
    const { service, restart, bind, dir, history } = await fixture();
    const offline = await bind(service, 'offline', 'dead-renderer');
    const native = await bind(service, 'native', 'dead-renderer');
    await mkdir(join(dir, 'sandbox'));
    await writeFile(
      join(dir, 'sandbox', 'members.meta.json'),
      JSON.stringify({ version: 1, members: [{ name: 'offline' }] })
    );
    await history.snapshotLaunch({
      teamName: 'sandbox',
      memberName: 'native',
      providerId: 'codex',
      gatewayUsageRef: native.gatewayUsageRef,
    });
    const recovered = restart();
    await recovered.service.recoverDraftBindings();
    expect(
      (await recovered.service.listBindings()).map((binding) => binding.memberName).sort()
    ).toEqual(['native', 'offline']);
    const state = await recovered.store.read();
    expect(state.sources.every((source) => !source.hasRuntimeArtifact && !source.draftOnly)).toBe(
      true
    );
    expect(state.bindings.every((binding) => !binding.draftOwner)).toBe(true);
    await expect(bind(recovered.service, 'intruder', 'new-renderer', 'offline')).rejects.toThrow(
      'another teammate'
    );
    expect(await recovered.service.resolveMemberConnection('sandbox', 'offline')).toMatchObject({
      gatewayUsageRef: offline.gatewayUsageRef,
      apiKey: 'offline',
    });
  });

  it('reclaims an unsaved restore despite metadata tombstones and stale config, but retains an active restore', async () => {
    const { service, restart, bind, dir } = await fixture();
    await mkdir(join(dir, 'sandbox'));
    await writeFile(
      join(dir, 'sandbox', 'members.meta.json'),
      JSON.stringify({ version: 1, members: [{ name: ' ALICE ', removedAt: 1_800_000_000_000 }] })
    );
    await writeFile(
      join(dir, 'sandbox', 'config.json'),
      JSON.stringify({ members: [{ name: 'alice' }] })
    );
    await bind(service, 'alice', 'crashed-restore', 'restore-key');
    const recovered = restart();
    await recovered.service.recoverDraftBindings();
    expect(await recovered.service.listBindings()).toEqual([]);
    expect(await recovered.service.listUsageSources()).toEqual([]);

    // Saving the restored metadata row makes the same identity active again.
    await writeFile(
      join(dir, 'sandbox', 'members.meta.json'),
      JSON.stringify({ version: 1, members: [{ name: ' ALICE ' }] })
    );
    await writeFile(join(dir, 'sandbox', 'config.json'), JSON.stringify({ members: [] }));
    await bind(recovered.service, 'alice', 'saved-restore', 'restore-key');
    const restored = restart();
    await restored.service.recoverDraftBindings();
    expect(await restored.service.resolveMemberConnection('sandbox', 'alice')).toMatchObject({
      apiKey: 'restore-key',
    });
    expect((await restored.store.read()).bindings[0].draftOwner).toBeUndefined();
  });

  it('scopes renderer recovery and stale receipts to the allocating document', async () => {
    const { service, bind } = await fixture();
    const stale = await bind(service, 'alice', 'old-document');
    const replacement = await bind(service, 'alice', 'new-document');
    await bind(service, 'bob', 'other-window');
    expect(replacement.boundAt).not.toBe(stale.boundAt);
    await service.recoverDraftBindings('old-document');
    await service.unbindMember({
      teamName: 'sandbox',
      memberName: 'alice',
      expectedBinding: stale,
    });
    expect((await service.listBindings()).map((binding) => binding.memberName)).toEqual([
      'alice',
      'bob',
    ]);
    await service.recoverDraftBindings('new-document');
    expect((await service.listBindings()).map((binding) => binding.memberName)).toEqual(['bob']);
  });

  it('keeps a committed credential replacement when its renderer disappears', async () => {
    const { service, bind, dir } = await fixture();
    await mkdir(join(dir, 'sandbox'));
    await writeFile(
      join(dir, 'sandbox', 'members.meta.json'),
      JSON.stringify({ version: 1, members: [{ name: 'alice' }] })
    );
    await bind(service, 'alice', 'document', 'old-key');
    await bind(service, 'alice', 'document', 'new-key');
    await service.recoverDraftBindings('document');
    expect(await service.resolveMemberConnection('sandbox', 'alice')).toMatchObject({
      apiKey: 'new-key',
    });
  });

  it('keeps ordinary APIs and live-owner cleanup independent of delayed startup recovery', async () => {
    const { service, bind, storePath, apiKeys, drafts, profile } = await fixture();
    await bind(service, 'stale', 'old-process');
    const feature = createGatewayProviderFeature({ storePath, apiKeys, drafts });
    let resumeRead!: () => void;
    const paused = new Promise<void>((resolve) => {
      resumeRead = resolve;
    });
    const originalRead = JsonGatewayProviderStore.prototype.read;
    const read = vi
      .spyOn(JsonGatewayProviderStore.prototype, 'read')
      .mockImplementationOnce(async function (this: JsonGatewayProviderStore) {
        await paused;
        return originalRead.call(this);
      });
    const recovery = feature.recoverGatewayDraftBindings();
    try {
      // These settle while the initial recovery read is still paused.
      expect(await feature.listGatewayProfiles()).toHaveLength(1);
      await feature.bindGatewayMember(
        { teamName: 'sandbox', memberName: 'live', profileId: profile.id, apiKey: 'live-key' },
        'current-document'
      );
      await feature.bindGatewayMember(
        { teamName: 'sandbox', memberName: 'closed', profileId: profile.id, apiKey: 'closed-key' },
        'closed-document'
      );
      await feature.recoverGatewayDraftBindings('closed-document');
      expect((await feature.listGatewayBindings()).map((binding) => binding.memberName)).toEqual([
        'stale',
        'live',
      ]);
      resumeRead();
      await recovery;
      expect((await feature.listGatewayBindings()).map((binding) => binding.memberName)).toEqual([
        'live',
      ]);
      await feature.recoverGatewayDraftBindings('current-document');
      expect(await feature.listGatewayBindings()).toEqual([]);
      expect(await feature.listGatewayUsageSources()).toEqual([]);
    } finally {
      resumeRead();
      await recovery;
      read.mockRestore();
    }
  });

  it.each(['z-invalid-date', '+275760-09-13T00:00:00.000Z'])(
    'rebinds a persisted receipt with an invalid or overflowing timestamp: %s',
    async (boundAt) => {
      const { service, bind, store } = await fixture();
      await bind(service, 'alice', 'document');
      await store.mutate((state) => {
        state.bindings[0].boundAt = boundAt;
      });
      const replacement = await bind(service, 'alice', 'document');
      expect(replacement.boundAt).toBe('2026-10-21T00:00:00.000Z');
      await service.unbindMember({
        teamName: 'sandbox',
        memberName: 'alice',
        expectedBinding: { gatewayUsageRef: replacement.gatewayUsageRef, boundAt },
      });
      expect(await service.listBindings()).toHaveLength(1);
    }
  );

  it('isolates unreadable roster recovery from healthy drafts and saved facade operations', async () => {
    const { service, bind, dir, store, apiKeys, storePath, drafts, recoveryFailures, profile } =
      await fixture();
    await bind(service, 'alice', 'dead-renderer');
    await mkdir(join(dir, 'sandbox'));
    await writeFile(join(dir, 'sandbox', 'members.meta.json'), '{incomplete');
    await mkdir(join(dir, 'healthy'));
    await writeFile(
      join(dir, 'healthy', 'config.json'),
      JSON.stringify({ members: [{ name: 'saved' }] })
    );
    await service.bindMember(
      { teamName: 'healthy', memberName: 'saved', profileId: profile.id, apiKey: 'saved-key' },
      'live-renderer'
    );
    await service.bindMember(
      { teamName: 'healthy', memberName: 'unsaved', profileId: profile.id, apiKey: 'unsaved-key' },
      'dead-renderer'
    );
    // Explicit startup recovery preserves the bad team without blocking healthy connections.
    const feature = createGatewayProviderFeature({ storePath, apiKeys, drafts });
    await feature.recoverGatewayDraftBindings();
    expect(await feature.listGatewayProfiles()).toHaveLength(1);
    expect(
      (await feature.listGatewayBindings('healthy')).map((binding) => binding.memberName)
    ).toEqual(['saved']);
    expect(await feature.resolveMemberConnection('healthy', 'saved')).toMatchObject({
      apiKey: 'saved-key',
    });
    const state = await store.read();
    expect(state.bindings.find((binding) => binding.teamName === 'sandbox')?.draftOwner).toBe(
      'dead-renderer'
    );
    expect(state.sources).toHaveLength(2);
    expect(recoveryFailures).toEqual(['sandbox']);
  });
});
