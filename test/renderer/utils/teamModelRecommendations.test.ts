import {
  getTeamModelRecommendation,
  isTeamModelRecommended,
} from '@renderer/utils/teamModelRecommendations';
import { describe, expect, it } from 'vitest';

describe('getTeamModelRecommendation', () => {
  it('marks all visible Codex Agent Teams models as recommended', () => {
    for (const modelId of ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2']) {
      expect(getTeamModelRecommendation('codex', modelId)).toMatchObject({
        level: 'recommended',
        label: 'Recommended',
      });
      expect(isTeamModelRecommended('codex', modelId)).toBe(true);
    }

    for (const modelId of ['gpt-5.3-codex-spark']) {
      expect(getTeamModelRecommendation('codex', modelId)).toBeNull();
      expect(isTeamModelRecommended('codex', modelId)).toBe(false);
    }
  });

  it('marks supported Claude aliases and full ids as recommended but leaves default unbadged', () => {
    for (const modelId of [
      'haiku',
      'sonnet',
      'sonnet[1m]',
      'opus',
      'opus[1m]',
      'claude-haiku-4-5',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-6',
      'claude-sonnet-4-6[1m]',
      'claude-opus-4-8',
      'claude-opus-4-8[1m]',
      'claude-opus-4-7',
      'claude-opus-4-7[1m]',
      'claude-opus-4-6',
      'claude-opus-4-6[1m]',
    ]) {
      expect(getTeamModelRecommendation('anthropic', modelId)).toMatchObject({
        level: 'recommended',
        label: 'Recommended',
      });
      expect(isTeamModelRecommended('anthropic', modelId)).toBe(true);
    }

    expect(getTeamModelRecommendation('anthropic', '')).toBeNull();
    expect(getTeamModelRecommendation('anthropic', 'default')).toBeNull();
  });

  it('delegates OpenCode verdicts and keeps MiniMax below recommended', () => {
    expect(getTeamModelRecommendation('opencode', 'opencode/big-pickle')).toMatchObject({
      level: 'recommended',
      label: 'Recommended',
    });
    expect(isTeamModelRecommended('opencode', 'opencode/big-pickle')).toBe(true);

    expect(getTeamModelRecommendation('opencode', 'opencode/minimax-m2.5-free')).toMatchObject({
      level: 'tested-with-limits',
      label: 'Tested with limits',
    });
    expect(isTeamModelRecommended('opencode', 'opencode/minimax-m2.5-free')).toBe(false);
  });
});
