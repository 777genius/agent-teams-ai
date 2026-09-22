import { describe, expect, it } from 'vitest';

import {
  buildHostedRosterConfiguration,
  createHostedInitialRosterDraft,
  hostedConfigurationToRosterDraft,
  hostedRosterCreateFingerprint,
  type HostedInitialRosterDraft,
} from '../../../../src/features/team-configuration/renderer/view-models/hostedInitialRoster';

import type { HostedRosterConfiguration } from '../../../../src/features/team-configuration/contracts';

function mixedDraft(): HostedInitialRosterDraft {
  return {
    lanes: [
      {
        id: 'lane-native',
        provider: 'anthropic',
        selectedModel: '',
        effort: '',
        members: [
          {
            id: 'member-lead',
            name: 'lead',
            prompt: 'Coordinate exactly.',
            model: 'claude-opus-4-6',
            effort: 'high',
          },
          {
            id: 'member-review',
            name: 'reviewer',
            prompt: 'Review exactly.',
            model: 'claude-sonnet-4-6',
            effort: 'medium',
          },
        ],
      },
      {
        id: 'lane-opencode',
        provider: 'opencode',
        selectedModel: 'openai/gpt-5.6',
        effort: 'high',
        members: [
          {
            id: 'member-builder',
            name: 'builder',
            prompt: 'Build exactly.',
            model: 'github-copilot/gpt-5.6-sol',
            effort: 'low',
          },
        ],
      },
      {
        id: 'lane-gemini',
        provider: 'gemini',
        selectedModel: '',
        effort: '',
        members: [
          {
            id: 'member-research',
            name: 'researcher',
            prompt: 'Research exactly.',
            model: 'gemini-2.5-pro',
            effort: '',
          },
        ],
      },
      {
        id: 'lane-codex',
        provider: 'codex',
        selectedModel: '',
        effort: '',
        members: [
          {
            id: 'member-codex',
            name: 'implementer',
            prompt: 'Implement exactly.',
            model: 'gpt-5.6-sol',
            effort: 'medium',
          },
        ],
      },
    ],
  };
}

describe('Hosted initial roster mapping', () => {
  it('starts with the implementation-chosen editable Codex defaults without completing instructions', () => {
    const draft = createHostedInitialRosterDraft();

    expect(draft.lanes[0]).toMatchObject({
      provider: 'codex',
      members: [{ name: 'lead', prompt: '', model: 'gpt-5.6-sol', effort: 'medium' }],
    });
    expect(buildHostedRosterConfiguration(draft)).toMatchObject({
      ok: false,
      errors: ['Member “lead” needs instructions.'],
    });
  });

  it('builds a complete solo Codex roster once explicit instructions are supplied', () => {
    const initial = createHostedInitialRosterDraft();
    const lane = initial.lanes[0];
    const initialMember = lane?.members[0];
    if (!lane || !initialMember) throw new Error('expected-default-member');
    const result = buildHostedRosterConfiguration({
      lanes: [
        {
          ...lane,
          members: [{ ...initialMember, prompt: 'Own the requested work.' }],
        },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      members: [{ name: 'lead' }],
      configuration: {
        schemaVersion: 1,
        toolApprovalMode: 'auto',
        lanes: [
          {
            kind: 'native',
            provider: 'codex',
            members: [
              {
                name: 'lead',
                prompt: 'Own the requested work.',
                model: 'gpt-5.6-sol',
                effort: 'medium',
              },
            ],
          },
        ],
      },
    });
  });

  it('maps mixed and repeated-provider lanes in exact lane/member order without field loss', () => {
    const input = mixedDraft();
    const repeated = {
      ...input,
      lanes: [...input.lanes, { ...input.lanes[3]!, id: 'lane-codex-two', members: [
        { ...input.lanes[3]!.members[0]!, id: 'member-codex-two', name: 'implementer_b' },
      ] }],
    } satisfies HostedInitialRosterDraft;

    const result = buildHostedRosterConfiguration(repeated);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected-complete-roster');
    expect(result.members.map(({ name }) => name)).toEqual([
      'lead', 'reviewer', 'builder', 'researcher', 'implementer', 'implementer_b',
    ]);
    expect(result.configuration).toEqual({
      schemaVersion: 1,
      toolApprovalMode: 'auto',
      lanes: [
        {
          kind: 'native', provider: 'anthropic', members: [
            { name: 'lead', prompt: 'Coordinate exactly.', model: 'claude-opus-4-6', effort: 'high' },
            { name: 'reviewer', prompt: 'Review exactly.', model: 'claude-sonnet-4-6', effort: 'medium' },
          ],
        },
        {
          kind: 'opencode', provider: 'opencode', selectedModel: 'openai/gpt-5.6', effort: 'high',
          members: [
            { name: 'builder', prompt: 'Build exactly.', model: 'github-copilot/gpt-5.6-sol', effort: 'low' },
          ],
        },
        {
          kind: 'native', provider: 'gemini',
          members: [{ name: 'researcher', prompt: 'Research exactly.', model: 'gemini-2.5-pro' }],
        },
        {
          kind: 'native', provider: 'codex',
          members: [{ name: 'implementer', prompt: 'Implement exactly.', model: 'gpt-5.6-sol', effort: 'medium' }],
        },
        {
          kind: 'native', provider: 'codex',
          members: [{ name: 'implementer_b', prompt: 'Implement exactly.', model: 'gpt-5.6-sol', effort: 'medium' }],
        },
      ],
    });
  });

  it('rehydrates every saved field for read-only display, including manual records', () => {
    const configuration: HostedRosterConfiguration = {
      schemaVersion: 1,
      toolApprovalMode: 'manual',
      lanes: [
        {
          kind: 'native',
          provider: 'codex',
          members: [
            {
              name: 'lead',
              prompt: 'Coordinate first.',
              model: 'gpt-5.6-sol',
              effort: 'medium',
            },
          ],
        },
        {
          kind: 'opencode',
          provider: 'opencode',
          selectedModel: 'z-ai/glm-5',
          effort: 'medium',
          members: [
            {
              name: 'builder',
              prompt: 'Keep this prompt.',
              model: 'openrouter/model-x',
              effort: 'high',
            },
          ],
        },
      ],
    };

    expect(hostedConfigurationToRosterDraft(configuration).lanes).toMatchObject([
      {
        provider: 'codex',
        selectedModel: '',
        effort: '',
        members: [
          {
            name: 'lead',
            prompt: 'Coordinate first.',
            model: 'gpt-5.6-sol',
            effort: 'medium',
          },
        ],
      },
      {
        provider: 'opencode',
        selectedModel: 'z-ai/glm-5',
        effort: 'medium',
        members: [
          {
            name: 'builder',
            prompt: 'Keep this prompt.',
            model: 'openrouter/model-x',
            effort: 'high',
          },
        ],
      },
    ]);
    expect(configuration.toolApprovalMode).toBe('manual');
  });

  it('rejects incomplete and invalid editor state instead of inventing routing defaults', () => {
    const draft = mixedDraft();
    const invalid: HostedInitialRosterDraft = {
      lanes: [
        { ...draft.lanes[0]!, members: [{ ...draft.lanes[0]!.members[0]!, model: '', prompt: '' }] },
        { ...draft.lanes[1]!, selectedModel: 'unqualified', members: [
          { ...draft.lanes[1]!.members[0]!, name: 'LEAD' },
        ] },
      ],
    };

    const result = buildHostedRosterConfiguration(invalid);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected-invalid-roster');
    expect(result.errors).toEqual(expect.arrayContaining([
      'Member “lead” needs instructions.',
      'Member “lead” needs a model for anthropic.',
      'Lane 2 needs a provider-qualified OpenCode model.',
      'Member name “LEAD” is used more than once.',
    ]));
  });

  it('rejects surrounding whitespace instead of silently changing roster bytes', () => {
    const draft = mixedDraft();
    const firstLane = draft.lanes[0];
    const firstMember = firstLane?.members[0];
    if (!firstLane || !firstMember) throw new Error('expected-first-member');
    const prompt = ' Preserve these bytes. ';
    const model = ' claude-opus-4-6';
    const result = buildHostedRosterConfiguration({
      lanes: [
        {
          ...firstLane,
          members: [{ ...firstMember, prompt, model }, ...firstLane.members.slice(1)],
        },
        ...draft.lanes.slice(1),
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        'Member “lead” instructions cannot start or end with whitespace.',
        'Member “lead” model cannot start or end with whitespace.',
      ]),
    });
    expect(prompt).toBe(' Preserve these bytes. ');
    expect(model).toBe(' claude-opus-4-6');
  });

  it('fingerprints the entire canonical configuration, not only names', () => {
    const result = buildHostedRosterConfiguration(mixedDraft());
    if (!result.ok) throw new Error('expected-complete-roster');
    const baseline = hostedRosterCreateFingerprint('Team', result.configuration);
    const firstLane = result.configuration.lanes[0];
    if (!firstLane || firstLane.kind !== 'native') throw new Error('expected-native-first-lane');
    const firstMember = firstLane.members[0];
    if (!firstMember) throw new Error('expected-first-member');
    const withFirstMember = (
      patch: Partial<typeof firstMember>
    ): HostedRosterConfiguration => ({
      ...result.configuration,
      lanes: [
        {
          ...firstLane,
          members: [{ ...firstMember, ...patch }, ...firstLane.members.slice(1)],
        },
        ...result.configuration.lanes.slice(1),
      ],
    });
    const variants: readonly HostedRosterConfiguration[] = [
      { ...result.configuration, toolApprovalMode: 'manual' as const },
      { ...result.configuration, lanes: result.configuration.lanes.toReversed() },
      {
        ...result.configuration,
        lanes: [{ ...firstLane, provider: 'gemini' }, ...result.configuration.lanes.slice(1)],
      },
      withFirstMember({ model: 'claude-sonnet-4-6' }),
      withFirstMember({ effort: 'low' }),
      withFirstMember({ prompt: 'Changed.' }),
    ];

    const fingerprints = variants.map((value) => hostedRosterCreateFingerprint('Team', value));
    expect(new Set(fingerprints).size).toBe(variants.length);
    expect(fingerprints.every((fingerprint) => fingerprint !== baseline)).toBe(true);
  });
});
