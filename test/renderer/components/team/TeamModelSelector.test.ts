import { describe, expect, it } from 'vitest';

import {
  computeEffectiveTeamModel,
  formatTeamModelSummary,
} from '@renderer/components/team/dialogs/TeamModelSelector';
import {
  GPT_5_1_CODEX_MINI_UI_DISABLED_REASON,
  GPT_5_3_CODEX_SPARK_UI_DISABLED_REASON,
  getTeamModelUiDisabledReason,
  normalizeTeamModelForUi,
} from '@renderer/utils/teamModelAvailability';

describe('formatTeamModelSummary', () => {
  it('shows cross-provider Anthropic models as backend-routed instead of brand-mismatched', () => {
    expect(formatTeamModelSummary('codex', 'claude-opus-4-6', 'medium')).toBe(
      'Opus 4.6 · via Codex · Medium'
    );
  });

  it('keeps native Codex-family models branded normally', () => {
    expect(formatTeamModelSummary('codex', 'gpt-5.4', 'medium')).toBe('5.4 · Medium');
  });

  it('marks 5.1 Codex Mini as disabled only for Codex team selection', () => {
    expect(getTeamModelUiDisabledReason('codex', 'gpt-5.1-codex-mini')).toBe(
      GPT_5_1_CODEX_MINI_UI_DISABLED_REASON
    );
    expect(getTeamModelUiDisabledReason('codex', 'gpt-5.3-codex-spark')).toBe(
      GPT_5_3_CODEX_SPARK_UI_DISABLED_REASON
    );
    expect(getTeamModelUiDisabledReason('codex', 'gpt-5.4-mini')).toBeNull();
    expect(getTeamModelUiDisabledReason('anthropic', 'gpt-5.1-codex-mini')).toBeNull();
  });

  it('normalizes disabled Codex model selections back to default', () => {
    expect(normalizeTeamModelForUi('codex', 'gpt-5.1-codex-mini')).toBe('');
    expect(normalizeTeamModelForUi('codex', 'gpt-5.3-codex-spark')).toBe('');
    expect(normalizeTeamModelForUi('codex', 'gpt-5.4-mini')).toBe('gpt-5.4-mini');
  });
});

describe('computeEffectiveTeamModel', () => {
  it('appends [1m] for anthropic models', () => {
    expect(computeEffectiveTeamModel('opus', false, 'anthropic')).toBe('opus[1m]');
    expect(computeEffectiveTeamModel('sonnet', false, 'anthropic')).toBe('sonnet[1m]');
  });

  it('does not double-append [1m] when input already has it', () => {
    expect(computeEffectiveTeamModel('opus[1m]', false, 'anthropic')).toBe('opus[1m]');
    expect(computeEffectiveTeamModel('sonnet[1m]', false, 'anthropic')).toBe('sonnet[1m]');
    expect(computeEffectiveTeamModel('opus[1m][1m]', false, 'anthropic')).toBe('opus[1m]');
  });

  it('defaults to opus[1m] when no model selected', () => {
    expect(computeEffectiveTeamModel('', false, 'anthropic')).toBe('opus[1m]');
  });

  it('returns base model without [1m] when limitContext is true', () => {
    expect(computeEffectiveTeamModel('opus', true, 'anthropic')).toBe('opus');
    expect(computeEffectiveTeamModel('opus[1m]', true, 'anthropic')).toBe('opus');
    expect(computeEffectiveTeamModel('opus[1m][1m]', true, 'anthropic')).toBe('opus');
  });

  it('returns haiku as-is', () => {
    expect(computeEffectiveTeamModel('haiku', false, 'anthropic')).toBe('haiku');
  });

  it('returns non-anthropic models as-is', () => {
    expect(computeEffectiveTeamModel('gpt-5.4', false, 'codex')).toBe('gpt-5.4');
    expect(computeEffectiveTeamModel('custom-model[1m]', false, 'codex')).toBe('custom-model[1m]');
  });
});
