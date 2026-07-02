import { describe, expect, it } from 'vitest';

import { OPEN_CODE_SOLO_MEMBER_NAME, planTeamRuntimeLanes } from '../planTeamRuntimeLanes';

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

  it('allows a non-OpenCode lead with only OpenCode teammates and leaves the primary lane teammate roster empty', () => {
    const result = planTeamRuntimeLanes({
      leadProviderId: 'codex',
      members: [
        { name: 'alice', providerId: 'opencode', model: 'big-pickle' },
        { name: 'bob', providerId: 'opencode', model: 'minimax-m2.5-free' },
        { name: 'tom', providerId: 'opencode', model: 'ling-2.6-flash-free' },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      plan: {
        mode: 'mixed_opencode_side_lanes',
        primaryMembers: [],
        sideLanes: [
          {
            laneId: 'secondary:opencode:alice',
            providerId: 'opencode',
            member: expect.objectContaining({
              name: 'alice',
              providerId: 'opencode',
              model: 'big-pickle',
            }),
          },
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
              model: 'ling-2.6-flash-free',
            }),
          },
        ],
      },
    });
  });

  it('creates an addressable solo runtime member for OpenCode-led solo teams', () => {
    const result = planTeamRuntimeLanes({
      leadProviderId: 'opencode',
      baseCwd: '/repo',
      members: [],
    });

    expect(result).toMatchObject({
      ok: true,
      plan: {
        mode: 'pure_opencode_solo',
        primaryMembers: [
          expect.objectContaining({
            name: OPEN_CODE_SOLO_MEMBER_NAME,
            role: 'Solo OpenCode Agent',
            providerId: 'opencode',
            cwd: '/repo',
          }),
        ],
        allMembers: [
          expect.objectContaining({
            name: OPEN_CODE_SOLO_MEMBER_NAME,
            providerId: 'opencode',
          }),
        ],
        sideLanes: [],
        soloMember: expect.objectContaining({
          name: OPEN_CODE_SOLO_MEMBER_NAME,
          providerId: 'opencode',
        }),
      },
    });
  });

  it('creates worktree-root OpenCode lanes for pure OpenCode teams with isolated members', () => {
    const result = planTeamRuntimeLanes({
      leadProviderId: 'opencode',
      baseCwd: '/repo',
      members: [
        {
          name: 'bob',
          providerId: 'opencode',
          model: 'minimax-m2.5-free',
          cwd: '/repo/.worktrees/bob',
        },
        {
          name: 'tom',
          providerId: 'opencode',
          model: 'nemotron-3-super-free',
          cwd: '/repo/.worktrees/tom',
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      plan: {
        mode: 'pure_opencode_worktree_root_lanes',
        primaryMembers: [],
        sideLanes: [
          {
            laneId: 'secondary:opencode:bob',
            providerId: 'opencode',
            member: expect.objectContaining({
              name: 'bob',
              providerId: 'opencode',
              cwd: '/repo/.worktrees/bob',
            }),
          },
          {
            laneId: 'secondary:opencode:tom',
            providerId: 'opencode',
            member: expect.objectContaining({
              name: 'tom',
              providerId: 'opencode',
              cwd: '/repo/.worktrees/tom',
            }),
          },
        ],
      },
    });
  });

  it('keeps base-cwd OpenCode members on primary and isolated members on worktree lanes', () => {
    const result = planTeamRuntimeLanes({
      leadProviderId: 'opencode',
      baseCwd: '/repo',
      members: [
        { name: 'lead-dev', providerId: 'opencode', model: 'big-pickle' },
        {
          name: 'bob',
          providerId: 'opencode',
          model: 'minimax-m2.5-free',
          cwd: '/repo/.worktrees/bob',
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      plan: {
        mode: 'pure_opencode_worktree_root_lanes',
        primaryMembers: [expect.objectContaining({ name: 'lead-dev', providerId: 'opencode' })],
        sideLanes: [
          {
            laneId: 'secondary:opencode:bob',
            providerId: 'opencode',
            member: expect.objectContaining({
              name: 'bob',
              providerId: 'opencode',
              cwd: '/repo/.worktrees/bob',
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
        'Mixed teams with an OpenCode lead are not supported in this phase. Keep the team lead on Anthropic or Codex when you mix OpenCode with other providers.',
    });
  });
});
