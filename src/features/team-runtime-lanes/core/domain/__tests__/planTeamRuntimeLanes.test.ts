import { describe, expect, it } from 'vitest';

import { planTeamRuntimeLanes } from '../planTeamRuntimeLanes';

describe('planTeamRuntimeLanes', () => {
  it('keeps non-OpenCode members on the primary lane', () => {
    const result = planTeamRuntimeLanes({
      leadProviderId: 'codex',
      members: [
        { name: 'alice', providerId: 'codex', model: 'gpt-5.4' },
        { name: 'bob', providerId: 'gemini', model: 'gemini-2.5-pro' },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      plan: {
        mode: 'primary_only',
        primaryMembers: [
          expect.objectContaining({ name: 'alice', providerId: 'codex' }),
          expect.objectContaining({ name: 'bob', providerId: 'gemini' }),
        ],
        sideLanes: [],
      },
    });
  });

  it('creates one secondary OpenCode lane per OpenCode teammate', () => {
    const result = planTeamRuntimeLanes({
      leadProviderId: 'codex',
      members: [
        { name: 'alice', providerId: 'codex', model: 'gpt-5.4' },
        { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
        { name: 'tom', providerId: 'opencode', model: 'nemotron-3-super-free' },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      plan: {
        mode: 'mixed_opencode_side_lanes',
        primaryMembers: [expect.objectContaining({ name: 'alice', providerId: 'codex' })],
        sideLanes: [
          {
            laneId: 'secondary:opencode:bob',
            providerId: 'opencode',
            member: expect.objectContaining({
              name: 'bob',
              providerId: 'opencode',
              model: 'minimax-m2.5-free',
            }),
          },
          {
            laneId: 'secondary:opencode:tom',
            providerId: 'opencode',
            member: expect.objectContaining({
              name: 'tom',
              providerId: 'opencode',
              model: 'nemotron-3-super-free',
            }),
          },
        ],
      },
    });
  });

  it('creates a secondary OpenCode lane for an Anthropic-led mixed team', () => {
    const result = planTeamRuntimeLanes({
      leadProviderId: 'anthropic',
      members: [
        { name: 'alice', providerId: 'anthropic', model: 'claude-opus-4-1' },
        { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      plan: {
        mode: 'mixed_opencode_side_lanes',
        primaryMembers: [expect.objectContaining({ name: 'alice', providerId: 'anthropic' })],
        sideLanes: [
          {
            laneId: 'secondary:opencode:bob',
            providerId: 'opencode',
            member: expect.objectContaining({
              name: 'bob',
              providerId: 'opencode',
              model: 'minimax-m2.5-free',
            }),
          },
        ],
      },
    });
  });

  it('creates a secondary OpenCode lane for a Gemini-led mixed team', () => {
    const result = planTeamRuntimeLanes({
      leadProviderId: 'gemini',
      members: [
        { name: 'alice', providerId: 'gemini', model: 'gemini-2.5-pro' },
        { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      plan: {
        mode: 'mixed_opencode_side_lanes',
        primaryMembers: [expect.objectContaining({ name: 'alice', providerId: 'gemini' })],
        sideLanes: [
          {
            laneId: 'secondary:opencode:bob',
            providerId: 'opencode',
            member: expect.objectContaining({
              name: 'bob',
              providerId: 'opencode',
              model: 'minimax-m2.5-free',
            }),
          },
        ],
      },
    });
  });

  it('rejects OpenCode-led mixed teams in this phase', () => {
    const result = planTeamRuntimeLanes({
      leadProviderId: 'opencode',
      members: [
        { name: 'alice', providerId: 'opencode', model: 'minimax-m2.5-free' },
        { name: 'bob', providerId: 'codex', model: 'gpt-5.4' },
      ],
    });

    expect(result).toEqual({
      ok: false,
      reason: 'unsupported_opencode_led_mixed_team',
      message:
        'Mixed teams with an OpenCode lead are not supported in this phase. Keep the team lead on Anthropic, Codex, or Gemini when you mix OpenCode with other providers.',
    });
  });
});
