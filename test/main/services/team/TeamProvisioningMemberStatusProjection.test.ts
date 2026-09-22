import {
  buildLaunchMemberSpawnStatus,
  findEffectiveRunMember,
  isLaunchMemberStatusRelevantToRuntimeRun,
  resolveEffectiveConfiguredMember,
  resolveLeadMemberName,
} from '@main/services/team/provisioning/TeamProvisioningMemberStatusProjection';
import { describe, expect, it } from 'vitest';

import type { MemberSpawnStatusEntry, PersistedTeamLaunchMemberState } from '@shared/types';

describe('TeamProvisioningMemberStatusProjection', () => {
  it('resolves effective member settings with meta taking precedence', () => {
    const member = resolveEffectiveConfiguredMember(
      [
        {
          name: 'Builder',
          role: 'configured role',
          providerId: 'anthropic',
          model: 'claude-configured',
        },
      ],
      [
        {
          name: 'builder',
          role: 'meta role',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-meta',
          joinedAt: 1,
        },
      ],
      'Builder'
    );

    expect(member).toMatchObject({
      name: 'builder',
      role: 'meta role',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-meta',
    });
  });

  it('falls back to the configured lead member name before the default', () => {
    expect(
      resolveLeadMemberName([{ name: 'Lead', agentType: 'lead' }, { name: 'Builder' }], [])
    ).toBe('Lead');
    expect(resolveLeadMemberName([{ name: 'Builder' }], [])).toBe('team-lead');
  });

  it('finds effective runtime members across live run collections', () => {
    expect(
      findEffectiveRunMember(
        {
          allEffectiveMembers: [{ name: 'Builder', model: 'gpt-worker' }],
          effectiveMembers: [],
        },
        'builder'
      )
    ).toMatchObject({ name: 'Builder', model: 'gpt-worker' });
  });

  it('projects launch member state into spawn status entries', () => {
    const status = buildLaunchMemberSpawnStatus(
      {
        name: 'Builder',
        providerId: 'codex',
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        lastEvaluatedAt: '2026-01-01T00:00:00.000Z',
      },
      'gpt-worker'
    );

    expect(status).toMatchObject<Partial<MemberSpawnStatusEntry>>({
      status: 'online',
      launchState: 'confirmed_alive',
      runtimeAlive: true,
      bootstrapConfirmed: true,
      runtimeModel: 'gpt-worker',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('requires matching runtime ids for OpenCode launch status reuse', () => {
    const member: PersistedTeamLaunchMemberState = {
      name: 'Builder',
      providerId: 'opencode',
      launchState: 'confirmed_alive',
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      hardFailure: false,
      runtimeRunId: 'run-1',
      lastEvaluatedAt: '2026-01-01T00:00:00.000Z',
    };

    expect(isLaunchMemberStatusRelevantToRuntimeRun(member, 'run-1')).toBe(true);
    expect(isLaunchMemberStatusRelevantToRuntimeRun(member, 'run-2')).toBe(false);
  });
});
