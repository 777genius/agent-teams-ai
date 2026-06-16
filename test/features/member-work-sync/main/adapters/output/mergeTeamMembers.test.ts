import { mergeTeamMembers } from '@features/member-work-sync/main/adapters/output/mergeTeamMembers';
import { describe, expect, it } from 'vitest';

describe('mergeTeamMembers', () => {
  it('preserves config provider fields when member meta only carries runtime fields', () => {
    expect(
      mergeTeamMembers(
        [
          {
            name: 'NickName',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.5',
            effort: 'medium',
          },
        ],
        [
          {
            name: 'NickName',
            role: 'developer',
            agentType: 'general-purpose',
            color: 'blue',
          },
        ]
      )
    ).toEqual([
      {
        name: 'NickName',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.5',
        effort: 'medium',
        role: 'developer',
        agentType: 'general-purpose',
        color: 'blue',
      },
    ]);
  });

  it('allows explicit member meta values to override config values', () => {
    expect(
      mergeTeamMembers(
        [{ name: 'Alice', providerId: 'codex', model: 'gpt-5.5', removedAt: undefined }],
        [
          {
            name: 'Alice',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
            removedAt: 1780567089118,
          },
        ]
      )
    ).toEqual([
      {
        name: 'Alice',
        providerId: 'opencode',
        model: 'minimax-m2.5-free',
        removedAt: 1780567089118,
      },
    ]);
  });

  it('clears stale config provider fields when explicit member meta changes provider', () => {
    const [member] = mergeTeamMembers(
      [
        {
          name: 'Alice',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.5',
          effort: 'medium',
          fastMode: 'off',
        },
      ],
      [{ name: 'Alice', providerId: 'opencode', role: 'developer' }]
    );

    expect(member).toEqual({
      name: 'Alice',
      providerId: 'opencode',
      role: 'developer',
    });
  });

  it('clears stale inferred config provider fields when explicit member meta changes provider', () => {
    const [member] = mergeTeamMembers(
      [
        {
          name: 'Alice',
          model: 'gpt-5.5',
          effort: 'medium',
          fastMode: 'off',
        },
      ],
      [{ name: 'Alice', providerId: 'opencode', role: 'developer' }]
    );

    expect(member).toEqual({
      name: 'Alice',
      providerId: 'opencode',
      role: 'developer',
    });
  });

  it('clears stale backend-inferred config provider fields when explicit member meta changes provider', () => {
    const [member] = mergeTeamMembers(
      [
        {
          name: 'Alice',
          providerBackendId: 'codex-native',
          fastMode: 'off',
        },
      ],
      [{ name: 'Alice', providerId: 'opencode', role: 'developer' }]
    );

    expect(member).toEqual({
      name: 'Alice',
      providerId: 'opencode',
      role: 'developer',
    });
  });

  it('does not let providerless runtime meta model override config provider metadata', () => {
    expect(
      mergeTeamMembers(
        [{ name: 'Alice', providerId: 'codex', model: 'gpt-5.5', effort: 'medium' }],
        [
          {
            name: 'Alice',
            role: 'developer',
            model: 'opencode/openai/gpt-oss',
            effort: 'high',
          },
        ]
      )
    ).toEqual([
      {
        name: 'Alice',
        providerId: 'codex',
        model: 'gpt-5.5',
        effort: 'medium',
        role: 'developer',
      },
    ]);
  });

  it('preserves config fastMode off without dropping runtime provider identity fields', () => {
    expect(
      mergeTeamMembers(
        [{ name: 'Alice', fastMode: 'off' }],
        [{ name: 'Alice', model: 'opencode/openai/gpt-oss', fastMode: 'on' }]
      )
    ).toEqual([{ name: 'Alice', fastMode: 'off', model: 'opencode/openai/gpt-oss' }]);
  });

  it('preserves backend-only config provider metadata over providerless runtime meta model', () => {
    expect(
      mergeTeamMembers(
        [{ name: 'Alice', providerBackendId: 'codex-native' }],
        [{ name: 'Alice', model: 'opencode/openai/gpt-oss', role: 'developer' }]
      )
    ).toEqual([
      {
        name: 'Alice',
        providerBackendId: 'codex-native',
        role: 'developer',
      },
    ]);
  });

  it('treats provider backend as stronger provider identity than a stale model', () => {
    const [member] = mergeTeamMembers(
      [
        {
          name: 'Alice',
          providerBackendId: 'opencode-cli',
          model: 'gpt-5.5',
          fastMode: 'off',
        },
      ],
      [{ name: 'Alice', providerId: 'codex', role: 'developer' }]
    );

    expect(member).toEqual({
      name: 'Alice',
      providerId: 'codex',
      role: 'developer',
    });
  });

  it('does not treat empty or null config provider metadata as authoritative', () => {
    const [member] = mergeTeamMembers(
      [{ name: 'Alice', model: '', providerBackendId: null as never }],
      [{ name: 'Alice', model: 'gpt-5.5', role: 'developer' }]
    );

    expect(member).toMatchObject({
      name: 'Alice',
      model: 'gpt-5.5',
      role: 'developer',
    });
  });

  it('does not treat an uninferable config model as authoritative provider identity', () => {
    const [member] = mergeTeamMembers(
      [{ name: 'Alice', model: 'custom-local-model', fastMode: 'off' }],
      [{ name: 'Alice', model: 'gpt-5.5', role: 'developer' }]
    );

    expect(member).toEqual({
      name: 'Alice',
      model: 'gpt-5.5',
      fastMode: 'off',
      role: 'developer',
    });
  });

  it('allows runtime member meta to clear stale config removal state without clearing provider fields', () => {
    const [member] = mergeTeamMembers(
      [{ name: 'Alice', providerId: 'codex', model: 'gpt-5.5', removedAt: 1780567089118 }],
      [
        {
          name: 'Alice',
          role: 'developer',
          removedAt: undefined,
        },
      ]
    );

    expect(member).toMatchObject({
      name: 'Alice',
      providerId: 'codex',
      model: 'gpt-5.5',
      role: 'developer',
    });
    expect(member).not.toHaveProperty('removedAt');
  });

  it('keeps meta-only members', () => {
    expect(
      mergeTeamMembers([], [{ name: 'Bob', role: 'reviewer', color: 'green' }])
    ).toEqual([{ name: 'Bob', role: 'reviewer', color: 'green' }]);
  });
});
