import { describe, expect, it } from 'vitest';

import { buildProviderModelChecksMap } from './defaultModelSelection';
import { materializeOpenCodeDefaultSelections } from './openCodeDefaultModel';

import type { MemberDraft } from '@renderer/components/team/members/membersEditorTypes';

const DEFAULT_SENTINEL = '__provider_default__';

function member(overrides: Partial<MemberDraft>): MemberDraft {
  return { id: 'm1', name: 'one', roleSelection: '', customRole: '', ...overrides };
}

describe('buildProviderModelChecksMap', () => {
  it('never sends the Default sentinel for OpenCode', () => {
    const checks = buildProviderModelChecksMap({
      leadProviderId: 'opencode',
      leadModel: '',
      members: [member({ providerId: 'opencode' })],
      scopeContext: { runtimeProviderStatusById: new Map() },
    });

    expect(checks.get('opencode')).toBeUndefined();
  });

  it('checks the concrete route once Default is materialized', () => {
    const { selectedModel, members } = materializeOpenCodeDefaultSelections({
      selectedProviderId: 'anthropic',
      selectedModel: 'opus[1m]',
      members: [member({ providerId: 'opencode' })],
      syncModelsWithLead: true,
      projectDefault: { state: 'available', model: 'opencode/big-pickle' },
    });
    const checks = buildProviderModelChecksMap({
      leadProviderId: 'anthropic',
      leadModel: selectedModel,
      members,
      scopeContext: { runtimeProviderStatusById: new Map() },
    });

    expect(checks.get('opencode')).toEqual([
      { providerId: 'opencode', model: 'opencode/big-pickle' },
    ]);
    expect(JSON.stringify([...checks.values()])).not.toContain(DEFAULT_SENTINEL);
  });

  it('keeps runtime Default checks for Codex and Gemini', () => {
    const checks = buildProviderModelChecksMap({
      leadProviderId: 'codex',
      leadModel: '',
      members: [member({ providerId: 'gemini' })],
      scopeContext: { runtimeProviderStatusById: new Map() },
    });

    expect(checks.get('codex')).toEqual([{ providerId: 'codex', model: DEFAULT_SENTINEL }]);
    expect(checks.get('gemini')).toEqual([{ providerId: 'gemini', model: DEFAULT_SENTINEL }]);
  });

  it('keeps Anthropic Default checks limited to an Anthropic lead', () => {
    const anthropicLead = buildProviderModelChecksMap({
      leadProviderId: 'anthropic',
      leadModel: '',
      members: [],
      scopeContext: { runtimeProviderStatusById: new Map() },
    });
    const codexLead = buildProviderModelChecksMap({
      leadProviderId: 'codex',
      leadModel: 'gpt-5.5',
      members: [member({ providerId: 'anthropic' })],
      scopeContext: { runtimeProviderStatusById: new Map() },
    });

    expect(anthropicLead.get('anthropic')).toEqual([
      { providerId: 'anthropic', model: DEFAULT_SENTINEL },
    ]);
    expect(codexLead.get('anthropic')).toBeUndefined();
  });

  it('dedupes identical checks, carries effort and skips removed members', () => {
    const checks = buildProviderModelChecksMap({
      leadProviderId: 'codex',
      leadModel: 'gpt-5.5',
      leadEffort: 'high',
      members: [
        member({ id: 'a', name: 'a' }),
        member({ id: 'b', name: 'b', providerId: 'codex', model: 'gpt-5.5', effort: 'high' }),
        member({ id: 'c', name: 'c', providerId: 'gemini', removedAt: 1 }),
      ],
      scopeContext: { runtimeProviderStatusById: new Map() },
    });

    expect(checks.get('codex')).toEqual([
      { providerId: 'codex', model: 'gpt-5.5', effort: 'high' },
      { providerId: 'codex', model: DEFAULT_SENTINEL, effort: 'high' },
    ]);
    expect(checks.get('gemini')).toBeUndefined();
  });
});
