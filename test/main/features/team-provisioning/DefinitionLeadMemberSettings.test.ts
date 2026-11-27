import { stableJsonStringify } from '@features/application-command-ledger/core/domain';
import { ApplicationCommandRunner } from '@features/application-command-ledger/core/application';
import { MemberSettingsPersistenceFailedError } from '@features/team-provisioning/core/application/ports/UpdateMemberSettingsPorts';
import { createMemberSettingsFingerprint } from '@features/team-provisioning/core/domain/memberSettingsPolicy';
import {
  definitionMemberSettingsLifecycle,
  DefinitionLeadMemberSettingsRepositoryAdapter,
} from '@features/team-provisioning/main/adapters/output/DefinitionLeadMemberSettingsAdapters';
import { createTeamMemberSettingsFeature } from '@features/team-provisioning/main/composition/createTeamMemberSettingsFeature';
import { describe, expect, it, vi } from 'vitest';

import {
  fixedClock,
  InMemoryLedgerStore,
} from '../../../features/application-command-ledger/inMemoryLedgerStore';

import type { UpdateMemberSettingsRequest } from '@features/team-provisioning/contracts/memberSettings';
import type { MemberSettingsRepositoryPort } from '@features/team-provisioning/core/application/ports/UpdateMemberSettingsPorts';
import type { MemberSettingsTargetSnapshot } from '@features/team-provisioning/core/domain/memberSettingsPolicy';

const leadRow: MemberSettingsTargetSnapshot = {
  name: 'team-lead',
  agentType: 'team-lead',
  agentId: null,
  joinedAt: null,
  settings: {
    role: null,
    workflow: null,
    isolation: null,
    providerId: null,
    providerBackendId: null,
    model: null,
    effort: null,
    fastMode: null,
    mcpPolicy: null,
  },
  teamIsAlive: false,
  leadProviderId: null,
  teamIsMixed: false,
  runtimeLane: 'primary',
};

/** The definition's launch settings, with a switch to make the read after a save fail. */
function definition() {
  const saved: { model?: string; effort?: string; providerId?: string } = {
    providerId: 'anthropic',
    model: 'model-one',
    effort: 'medium',
  };
  const saves: unknown[] = [];
  let failReadsAfterSave = false;
  let failSaveNumber: number | null = null;
  const launchSettings = {
    read: vi.fn(async () => {
      if (failReadsAfterSave && saves.length > 0) throw new Error('metadata read failed');
      return { ...saved };
    }),
    save: vi.fn(async (_team: string, settings: { model?: string; effort?: string }) => {
      saves.push(settings);
      if (failSaveNumber === saves.length) throw new Error('metadata write failed');
      Object.assign(saved, settings);
    }),
  };
  const base: MemberSettingsRepositoryPort = {
    findTarget: vi.fn(async () => leadRow),
    classifyMissingTarget: vi.fn(async () => 'member_not_found' as const),
    applyTarget: vi.fn(),
    restoreTarget: vi.fn(),
  };
  const adapter = new DefinitionLeadMemberSettingsRepositoryAdapter(base, launchSettings as never);
  return {
    adapter,
    saved,
    saves,
    failReadsAfterSave: () => {
      failReadsAfterSave = true;
    },
    failSave: (number: number) => {
      failSaveNumber = number;
    },
  };
}

async function currentFingerprint(
  adapter: DefinitionLeadMemberSettingsRepositoryAdapter
): Promise<string> {
  const target = await adapter.findTarget('builders', 'team-lead');
  if (!target) throw new Error('no lead');
  return createMemberSettingsFingerprint(target);
}

describe('DefinitionLeadMemberSettingsRepositoryAdapter', () => {
  it('rolls a write back when it cannot be read back, like the team repository', async () => {
    const d = definition();
    const expectedFingerprint = await currentFingerprint(d.adapter);
    d.failReadsAfterSave();
    const applying = d.adapter.applyTarget({
      teamName: 'builders',
      memberName: 'team-lead',
      expectedFingerprint,
      settings: { ...leadRow.settings, model: 'model-two', effort: 'high' },
    });
    await expect(applying).rejects.toBeInstanceOf(MemberSettingsPersistenceFailedError);
    await expect(applying).rejects.toMatchObject({ recoveryRequired: false });
    // The new values, then the previous ones back.
    expect(d.saves).toEqual([
      { model: 'model-two', effort: 'high' },
      { model: 'model-one', effort: 'medium' },
    ]);
    expect(d.saved).toMatchObject({ model: 'model-one', effort: 'medium' });
  });

  it('asks for recovery when the rollback fails too', async () => {
    const d = definition();
    const expectedFingerprint = await currentFingerprint(d.adapter);
    d.failReadsAfterSave();
    d.failSave(2);
    await expect(
      d.adapter.applyTarget({
        teamName: 'builders',
        memberName: 'team-lead',
        expectedFingerprint,
        settings: { ...leadRow.settings, model: 'model-two', effort: 'high' },
      })
    ).rejects.toMatchObject({ recoveryRequired: true });
  });
});

describe('the lead of a team definition through the durable command ledger', () => {
  it('replays a repeated command from the ledger without a second write', async () => {
    const d = definition();
    const ledger = new InMemoryLedgerStore();
    const commandRunner = new ApplicationCommandRunner({
      ledger,
      hasher: {
        hashJson: (value) => `hash:${stableJsonStringify(value)}`,
        hashString: (value) => `hash:${value}`,
      },
      clock: fixedClock(),
    });
    const feature = createTeamMemberSettingsFeature({
      commandRunner,
      isDurableStorageAvailable: async () => true,
      mutationSource: { runLiveRosterMutation: async (_team, operation) => operation() },
      lifecycle: definitionMemberSettingsLifecycle,
      repository: d.adapter,
    });
    const request: UpdateMemberSettingsRequest = {
      commandId: 'lead-command',
      idempotencyKey: 'lead-command',
      teamName: 'builders',
      memberName: 'team-lead',
      expectedFingerprint: await currentFingerprint(d.adapter),
      targetKind: 'lead',
      leadRuntime: { model: 'model-two', effort: 'high' },
    };

    const first = await feature.updateMemberSettings(request);
    const replay = await feature.updateMemberSettings(request);

    expect(first).toMatchObject({
      outcome: 'completed',
      effect: 'persisted_only',
      replayed: false,
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(d.saves).toEqual([{ model: 'model-two', effort: 'high' }]);
  });
});
