import {
  buildAuthoritativeModelChecks,
  buildMaterializedRuntimeRosterRevision,
  materializeConcreteLaunchRoster,
} from '@renderer/components/team/dialogs/authoritativeLaunchIdentity';
import { describe, expect, it } from 'vitest';

describe('authoritative launch identity', () => {
  it('preserves backend-separated member routes for the same provider and model', () => {
    const checks = buildAuthoritativeModelChecks({
      leadProviderId: 'codex',
      leadModel: 'gpt-5',
      leadBackendId: 'codex-native',
      providerStatusById: new Map([
        [
          'codex',
          {
            providerId: 'codex' as const,
            resolvedBackendId: 'codex-native',
            selectedBackendId: 'codex-native',
            modelCatalog: null,
            backend: null,
          },
        ],
      ]),
      members: [
        {
          providerId: 'codex',
          providerBackendId: 'adapter',
          model: 'gpt-5',
          runtimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'explicit',
            model: 'explicit',
            effort: 'inherited',
          },
        },
        {
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5',
          runtimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'explicit',
            model: 'explicit',
            effort: 'inherited',
          },
        },
      ],
      resolveMember: (member) => ({ providerId: 'codex', model: member.model }),
    });

    expect(checks.get('codex')).toEqual([
      { providerId: 'codex', providerBackendId: 'codex-native', model: 'gpt-5' },
      { providerId: 'codex', providerBackendId: 'adapter', model: 'gpt-5' },
    ]);
  });

  it('emits explicit null for Anthropic identity', () => {
    const checks = buildAuthoritativeModelChecks({
      leadProviderId: 'anthropic',
      leadModel: 'claude-sonnet-4-5',
      leadBackendId: null,
      providerStatusById: new Map(),
      members: [],
      resolveMember: () => ({ providerId: 'anthropic' }),
    });
    expect(checks.get('anthropic')).toEqual([
      {
        providerId: 'anthropic',
        providerBackendId: null,
        model: 'claude-sonnet-4-5',
      },
    ]);
  });

  it.each(['api', 'adapter'] as const)(
    'keeps live explicit Codex route %s exact in create/relaunch preparation and roster materialization',
    (providerBackendId) => {
      const providerStatus = {
        providerId: 'codex' as const,
        resolvedBackendId: providerBackendId,
        selectedBackendId: providerBackendId,
        modelCatalog: null,
        backend: { kind: providerBackendId, label: providerBackendId },
      };
      const providerStatusById = new Map([['codex' as const, providerStatus]]);

      expect(
        buildAuthoritativeModelChecks({
          leadProviderId: 'codex',
          leadModel: 'gpt-5',
          leadBackendId: providerBackendId,
          providerStatusById,
          members: [
            {
              providerId: 'codex',
              providerBackendId,
              model: 'gpt-5',
              runtimeSelectionProvenance: {
                version: 1,
                providerBackendId: 'explicit',
                model: 'explicit',
                effort: 'inherited',
              },
            },
          ],
          resolveMember: (member) => ({ providerId: 'codex', model: member.model }),
        }).get('codex')
      ).toEqual([{ providerId: 'codex', providerBackendId, model: 'gpt-5' }]);

      expect(
        materializeConcreteLaunchRoster({
          members: [
            {
              name: 'builder',
              providerId: 'codex',
              model: 'gpt-5',
              runtimeSelectionProvenance: {
                version: 1,
                providerBackendId: 'inherited',
                model: 'explicit',
                effort: 'inherited',
              },
            },
          ],
          leadProviderId: 'codex',
          leadModel: 'gpt-5',
          leadBackendId: providerBackendId,
          providerStatusById,
        })
      ).toEqual([
        {
          name: 'builder',
          providerId: 'codex',
          providerBackendId,
          model: 'gpt-5',
          runtimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'inherited',
            model: 'explicit',
            effort: 'inherited',
          },
        },
      ]);
    }
  );

  it('materializes Codex auto intent to the exact resolved backend', () => {
    expect(
      buildAuthoritativeModelChecks({
        leadProviderId: 'codex',
        leadModel: 'gpt-5',
        leadBackendId: 'auto',
        providerStatusById: new Map([
          [
            'codex',
            {
              providerId: 'codex',
              selectedBackendId: 'auto',
              resolvedBackendId: 'codex-native',
              modelCatalog: null,
              backend: { kind: 'codex-native', label: 'Native' },
            },
          ],
        ]),
        members: [],
        resolveMember: () => ({ providerId: 'codex' }),
      }).get('codex')
    ).toEqual([{ providerId: 'codex', providerBackendId: 'codex-native', model: 'gpt-5' }]);
  });

  it('rematerializes inherited same-provider fields from the current lead tuple', () => {
    const statuses = new Map([
      [
        'codex' as const,
        {
          providerId: 'codex' as const,
          resolvedBackendId: 'codex-native' as const,
          selectedBackendId: 'codex-native' as const,
          modelCatalog: null,
          backend: null,
        },
      ],
    ]);
    const first = materializeConcreteLaunchRoster({
      members: [
        {
          name: 'builder',
          providerId: 'codex',
          runtimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'inherited',
            model: 'inherited',
            effort: 'inherited',
          },
        },
      ],
      leadProviderId: 'codex',
      leadBackendId: 'codex-native',
      leadModel: 'gpt-5',
      leadEffort: 'high',
      providerStatusById: statuses,
    });
    expect(first?.[0]).toMatchObject({
      providerBackendId: 'codex-native',
      model: 'gpt-5',
      effort: 'high',
    });

    expect(
      materializeConcreteLaunchRoster({
        members: first!,
        leadProviderId: 'codex',
        leadBackendId: 'adapter',
        leadModel: 'gpt-6',
        leadEffort: 'xhigh',
        providerStatusById: statuses,
      })
    ).toEqual([
      expect.objectContaining({
        providerBackendId: 'adapter',
        model: 'gpt-6',
        effort: 'xhigh',
        runtimeSelectionProvenance: {
          version: 1,
          providerBackendId: 'inherited',
          model: 'inherited',
          effort: 'inherited',
        },
      }),
    ]);
  });

  it('removes stale inherited fields when the current lead tuple omits them', () => {
    const codexRoster = materializeConcreteLaunchRoster({
      members: [
        {
          name: 'builder',
          runtimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'inherited',
            model: 'inherited',
            effort: 'inherited',
          },
        },
      ],
      leadProviderId: 'codex',
      leadBackendId: 'codex-native',
      leadModel: 'gpt-5',
      leadEffort: 'high',
      providerStatusById: new Map(),
    });

    const anthropicRoster = materializeConcreteLaunchRoster({
      members: codexRoster!,
      leadProviderId: 'anthropic',
      leadBackendId: null,
      leadModel: 'claude-sonnet-4-5',
      providerStatusById: new Map(),
    });

    expect(anthropicRoster).toEqual([
      expect.objectContaining({
        model: 'claude-sonnet-4-5',
        runtimeSelectionProvenance: {
          version: 1,
          providerBackendId: 'inherited',
          model: 'inherited',
          effort: 'inherited',
        },
      }),
    ]);
    expect(anthropicRoster?.[0]).not.toHaveProperty('providerBackendId');
    expect(anthropicRoster?.[0]).not.toHaveProperty('effort');
  });

  it('keeps explicit overrides stable and never cross-inherits a lead tuple', () => {
    const statuses = new Map([
      [
        'gemini' as const,
        {
          providerId: 'gemini' as const,
          resolvedBackendId: 'cli-sdk' as const,
          selectedBackendId: 'cli-sdk' as const,
          modelCatalog: null,
          backend: null,
        },
      ],
    ]);
    const members = [
      {
        name: 'builder',
        providerId: 'codex' as const,
        providerBackendId: 'codex-native' as const,
        model: 'gpt-5-mini',
        effort: 'low' as const,
      },
      {
        name: 'reviewer',
        providerId: 'gemini' as const,
        providerBackendId: 'cli-sdk' as const,
        model: 'gemini-2.5-pro',
        effort: 'medium' as const,
      },
    ];

    expect(
      materializeConcreteLaunchRoster({
        members,
        leadProviderId: 'codex',
        leadBackendId: 'adapter',
        leadModel: 'gpt-6',
        leadEffort: 'xhigh',
        providerStatusById: statuses,
      })
    ).toEqual([
      expect.objectContaining({
        providerBackendId: 'codex-native',
        model: 'gpt-5-mini',
        effort: 'low',
      }),
      expect.objectContaining({
        providerBackendId: 'cli-sdk',
        model: 'gemini-2.5-pro',
        effort: 'medium',
      }),
    ]);
  });

  it('conservatively treats concrete legacy fields without provenance as explicit', () => {
    expect(
      materializeConcreteLaunchRoster({
        members: [
          {
            name: 'legacy',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5',
            effort: 'high',
          },
        ],
        leadProviderId: 'codex',
        leadBackendId: 'adapter',
        leadModel: 'gpt-6',
        leadEffort: 'xhigh',
        providerStatusById: new Map(),
      })
    ).toEqual([
      expect.objectContaining({
        providerBackendId: 'codex-native',
        model: 'gpt-5',
        effort: 'high',
        runtimeSelectionProvenance: {
          version: 1,
          providerBackendId: 'explicit',
          model: 'explicit',
          effort: 'explicit',
        },
      }),
    ]);
  });

  it('gives identical tuples different roster revisions when provenance differs', () => {
    const member = {
      name: 'builder',
      providerId: 'codex' as const,
      providerBackendId: 'adapter' as const,
      model: 'gpt-6',
      effort: 'xhigh' as const,
    };
    const revision = (selection: 'explicit' | 'inherited') =>
      buildMaterializedRuntimeRosterRevision({
        members: [
          {
            ...member,
            runtimeSelectionProvenance: {
              version: 1,
              providerBackendId: selection,
              model: selection,
              effort: selection,
            },
          },
        ],
        leadProviderId: 'codex',
        leadBackendId: 'adapter',
        leadModel: 'gpt-6',
        leadEffort: 'xhigh',
        leadRuntimeSelectionProvenance: {
          version: 1,
          providerBackendId: 'explicit',
          model: 'explicit',
          effort: 'explicit',
        },
      });

    expect(revision('inherited')).not.toBe(revision('explicit'));
  });
});
