import { describe, expect, it } from 'vitest';

import { hostTeamSelectionKey } from '../../../../../src/features/agent-backend/contracts';
import { buildProviderModelChecksMap } from '../../../../../src/renderer/components/team/dialogs/defaultModelSelection';
import { buildProviderPrepareModelChecksSignature } from '../../../../../src/renderer/components/team/dialogs/providerPrepareRequestSignature';

import type { MemberDraft } from '../../../../../src/renderer/components/team/members/membersEditorTypes';

const member = (name: string, values: Partial<MemberDraft> = {}): MemberDraft => ({
  id: name,
  name,
  roleSelection: '',
  customRole: '',
  ...values,
});
const base = {
  leadProviderId: 'anthropic' as const,
  leadModel: 'opus',
  leadEffort: 'medium' as const,
  members: [member('Bob')],
  scopeContext: { runtimeProviderStatusById: new Map() },
};

describe('existing dialog scoped model destinations', () => {
  it('keeps legacy scalar checks unchanged and binds Host inheritance to explicit lead/member references', () => {
    expect(buildProviderModelChecksMap(base).get('anthropic')).toEqual([
      { providerId: 'anthropic', model: 'opus', effort: 'medium' },
      { providerId: 'anthropic', model: '__provider_default__', effort: 'medium' },
    ]);
    expect(
      buildProviderModelChecksMap({ ...base, teamName: hostTeamSelectionKey('TEST') }).get(
        'anthropic'
      )
    ).toEqual([
      {
        providerId: 'anthropic',
        model: 'opus',
        effort: 'medium',
        targets: [{ kind: 'lead' }, { kind: 'member', name: 'Bob' }],
      },
    ]);
  });
  it('preserves opt-out, explicit effort, renamed source identity and removed rows', () => {
    const rows = buildProviderModelChecksMap({
      ...base,
      teamName: hostTeamSelectionKey('TEST'),
      syncModelsWithLead: false,
      members: [
        member('Renamed', { originalName: 'Bob', effort: 'high' }),
        member('Removed', { removedAt: 1 }),
      ],
    }).get('anthropic')!;
    expect(rows).toContainEqual({
      providerId: 'anthropic',
      model: '__provider_default__',
      effort: 'high',
      targets: [{ kind: 'member', name: 'Renamed', originalName: 'Bob' }],
    });
    expect(JSON.stringify(rows)).not.toContain('Removed');
  });
  it('never inherits a lead model or effort across different providers', () => {
    const rows = buildProviderModelChecksMap({
      ...base,
      teamName: hostTeamSelectionKey('TEST'),
      members: [member('Bob', { providerId: 'codex' })],
    });
    expect(rows.get('codex')).toEqual([
      {
        providerId: 'codex',
        model: '__provider_default__',
        targets: [{ kind: 'member', name: 'Bob' }],
      },
    ]);
  });
  it('invalidates cached model proof when destinations swap while the model/effort sets stay equal', () => {
    const build = (swap: boolean) =>
      buildProviderModelChecksMap({
        ...base,
        teamName: hostTeamSelectionKey('TEST'),
        members: [
          member('Bob', { model: swap ? 'opus' : 'sonnet' }),
          member('Alice', { model: swap ? 'sonnet' : 'opus' }),
        ],
      });
    expect(buildProviderPrepareModelChecksSignature(build(false))).not.toBe(
      buildProviderPrepareModelChecksSignature(build(true))
    );
  });
});

it('existing Host dialog keeps explicit Default rows when the lead/member effort selectors are cleared', () => {
  const selected = {
    ...base,
    teamName: hostTeamSelectionKey('TEST'),
    leadModel: '',
    leadEffort: undefined,
    members: [member('Bob')],
  };
  const rows = buildProviderModelChecksMap(selected).get('anthropic')!;
  expect(rows).toEqual([
    {
      providerId: 'anthropic',
      model: '__provider_default__',
      targets: [{ kind: 'lead' }, { kind: 'member', name: 'Bob' }],
    },
  ]);
  expect(
    buildProviderPrepareModelChecksSignature(buildProviderModelChecksMap(selected))
  ).not.toEqual(
    buildProviderPrepareModelChecksSignature(
      buildProviderModelChecksMap({ ...selected, leadEffort: 'high' })
    )
  );
});
