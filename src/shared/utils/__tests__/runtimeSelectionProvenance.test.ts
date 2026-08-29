import { describe, expect, it } from 'vitest';

import {
  buildEffectiveRuntimeRosterRevision,
  resolveEffectiveMemberRuntimeIdentity,
} from '../effectiveMemberRuntimeIdentity';
import {
  normalizeTeamLeadRuntimeSelectionProvenance,
  normalizeTeamMemberRuntimeSelectionProvenance,
  resolveLeadRuntimeSelectionProvenance,
  resolveMemberRuntimeSelectionProvenance,
} from '../teamMemberRuntimeSelectionProvenance';

const codexLead = {
  providerId: 'codex' as const,
  providerBackendId: 'codex-native' as const,
  model: 'gpt-5',
  effort: 'high' as const,
};

describe('runtime selection provenance migration matrix', () => {
  it.each([
    ['absent', {}, 'absent'],
    ['invalid', { runtimeSelectionProvenance: { version: 9 } }, 'invalid'],
    ['backend only', { providerBackendId: 'codex-native' }, 'partial'],
    ['model only', { model: 'gpt-5-mini' }, 'partial'],
    ['effort only', { effort: 'low' }, 'partial'],
    ['backend/model', { providerBackendId: 'codex-native', model: 'gpt-5-mini' }, 'partial'],
    ['backend/effort', { providerBackendId: 'codex-native', effort: 'low' }, 'partial'],
    ['model/effort', { model: 'gpt-5-mini', effort: 'low' }, 'partial'],
  ] as const)('classifies %s legacy member provenance as unknown/%s', (_name, fields, reason) => {
    expect(resolveMemberRuntimeSelectionProvenance({ providerId: 'codex', ...fields })).toEqual({
      version: 1,
      providerBackendId: 'unknown',
      model: 'unknown',
      effort: 'unknown',
      unknownReason: reason,
    });
  });

  it('uses present-is-explicit only for a fully concrete legacy member', () => {
    expect(
      resolveMemberRuntimeSelectionProvenance({
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5-mini',
        effort: 'low',
      })
    ).toEqual({
      version: 1,
      providerBackendId: 'explicit',
      model: 'explicit',
      effort: 'explicit',
    });
  });

  it('treats the Anthropic backend axis as not applicable for complete legacy data', () => {
    expect(
      resolveMemberRuntimeSelectionProvenance({
        providerId: 'anthropic',
        model: 'claude-sonnet-4-5',
        effort: 'high',
      })
    ).toMatchObject({
      providerBackendId: 'inherited',
      model: 'explicit',
      effort: 'explicit',
    });
  });

  it('rejects unknown provenance for same-provider and cross-provider resolution', () => {
    for (const providerId of ['codex', 'gemini'] as const) {
      expect(
        resolveEffectiveMemberRuntimeIdentity({
          lead: codexLead,
          member: {
            providerId,
            providerBackendId: providerId === 'codex' ? 'codex-native' : 'cli-sdk',
            runtimeSelectionProvenance: resolveMemberRuntimeSelectionProvenance({
              providerId,
              providerBackendId: providerId === 'codex' ? 'codex-native' : 'cli-sdk',
            }),
          },
          missingProvenance: 'conservative-legacy',
        })
      ).toBeNull();
    }
  });

  it('rejects missing legacy lead provenance even when concrete values survive', () => {
    expect(resolveLeadRuntimeSelectionProvenance({})).toEqual({
      version: 1,
      providerBackendId: 'unknown',
      model: 'unknown',
      effort: 'unknown',
      unknownReason: 'absent',
    });
    expect(
      resolveLeadRuntimeSelectionProvenance({
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5',
      })
    ).toEqual({
      version: 1,
      providerBackendId: 'unknown',
      model: 'unknown',
      effort: 'unknown',
      unknownReason: 'absent',
    });
    expect(
      resolveLeadRuntimeSelectionProvenance({
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5',
        effort: 'high',
      })
    ).toEqual({
      version: 1,
      providerBackendId: 'unknown',
      model: 'unknown',
      effort: 'unknown',
      unknownReason: 'absent',
    });
  });

  it('distinguishes Default from explicit for the same concrete lead and catalog changes', () => {
    const revision = (model: string, selection: 'default' | 'explicit') =>
      buildEffectiveRuntimeRosterRevision({
        lead: { ...codexLead, model },
        leadRuntimeSelectionProvenance: {
          version: 1,
          providerBackendId: 'default',
          model: selection,
          effort: 'default',
        },
        members: [],
        missingProvenance: 'reject',
      });

    expect(revision('gpt-5', 'default')).not.toBe(revision('gpt-5', 'explicit'));
    expect(revision('gpt-5', 'default')).not.toBe(revision('gpt-6', 'default'));
  });

  it.each([
    normalizeTeamLeadRuntimeSelectionProvenance,
    normalizeTeamMemberRuntimeSelectionProvenance,
  ])('rejects resolved axes carrying a contradictory unknown reason', (normalize) => {
    expect(
      normalize({
        version: 1,
        providerBackendId: 'explicit',
        model: 'explicit',
        effort: 'explicit',
        unknownReason: 'invalid',
      })
    ).toBeUndefined();
  });

  it.each([
    { version: 2, providerBackendId: 'explicit', model: 'explicit', effort: 'explicit' },
    { version: 1, providerBackendId: 'unknown', model: 'explicit', effort: 'explicit' },
    { version: 1, providerBackendId: 'explicit', model: 'bogus', effort: 'explicit' },
  ])('rejects malformed provenance %#', (value) => {
    expect(normalizeTeamMemberRuntimeSelectionProvenance(value)).toBeUndefined();
  });
});
