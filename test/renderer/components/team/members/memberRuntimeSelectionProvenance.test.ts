import {
  membersToJsonText,
  parseJsonToDrafts,
} from '@renderer/components/team/members/membersEditorJson';
import {
  buildMembersFromDrafts,
  createMemberDraftsFromInputs,
} from '@renderer/components/team/members/membersEditorUtils';
import { describe, expect, it } from 'vitest';

describe('member draft runtime selection provenance', () => {
  it('round-trips resolved provenance without materializing inherited snapshots as overrides', () => {
    const provenance = {
      version: 1 as const,
      providerBackendId: 'inherited' as const,
      model: 'explicit' as const,
      effort: 'inherited' as const,
    };
    const drafts = createMemberDraftsFromInputs([
      {
        name: 'builder',
        providerId: 'codex',
        providerBackendId: 'adapter',
        model: 'gpt-5-mini',
        effort: 'high',
        runtimeSelectionProvenance: provenance,
      },
    ]);

    expect(drafts[0]).toMatchObject({
      providerBackendId: undefined,
      model: 'gpt-5-mini',
      effort: undefined,
      runtimeSelectionProvenance: provenance,
    });
    expect(buildMembersFromDrafts(drafts)).toEqual([
      expect.objectContaining({
        name: 'builder',
        providerId: 'codex',
        model: 'gpt-5-mini',
        runtimeSelectionProvenance: provenance,
      }),
    ]);
  });

  it('preserves a partial legacy selection as unknown across draft import/export', () => {
    const drafts = createMemberDraftsFromInputs([
      { name: 'legacy', providerId: 'codex', providerBackendId: 'codex-native' },
    ]);

    expect(drafts[0]?.runtimeSelectionProvenance).toMatchObject({ unknownReason: 'partial' });
    expect(buildMembersFromDrafts(drafts)[0]?.runtimeSelectionProvenance).toMatchObject({
      unknownReason: 'partial',
    });
  });

  it('round-trips unknown provenance through the JSON editor contract', () => {
    const [draft] = parseJsonToDrafts(
      JSON.stringify([{ name: 'legacy', providerId: 'codex', providerBackendId: 'codex-native' }])
    );

    expect(draft?.runtimeSelectionProvenance).toMatchObject({ unknownReason: 'partial' });
    expect(JSON.parse(membersToJsonText(draft ? [draft] : []))).toEqual([
      expect.objectContaining({
        name: 'legacy',
        runtimeSelectionProvenance: expect.objectContaining({ unknownReason: 'partial' }),
      }),
    ]);
  });
});
