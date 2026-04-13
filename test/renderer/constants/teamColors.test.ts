import { describe, expect, it } from 'vitest';

import {
  getThemedText,
  getSubagentTypeColorSet,
  getTeamColorSet,
  scaleColorAlpha,
  TeamColorSet,
} from '@renderer/constants/teamColors';

function isValidColorSet(cs: TeamColorSet): boolean {
  return (
    typeof cs.border === 'string' && typeof cs.badge === 'string' && typeof cs.text === 'string'
  );
}

// =============================================================================
// getTeamColorSet
// =============================================================================

describe('getTeamColorSet', () => {
  it('returns blue (default) for empty string', () => {
    const result = getTeamColorSet('');
    expect(result.border).toBe('#3b82f6');
  });

  it('resolves named colors', () => {
    expect(getTeamColorSet('green').border).toBe('#22c55e');
    expect(getTeamColorSet('red').border).toBe('#ef4444');
    expect(getTeamColorSet('purple').border).toBe('#a855f7');
  });

  it('is case-insensitive for named colors', () => {
    expect(getTeamColorSet('Green')).toEqual(getTeamColorSet('green'));
    expect(getTeamColorSet('BLUE')).toEqual(getTeamColorSet('blue'));
  });

  it('generates a color set from hex strings', () => {
    const result = getTeamColorSet('#ff5500');
    expect(result.border).toBe('#ff5500');
    expect(result.badge).toBe('rgba(255, 85, 0, 0.15)');
    expect(result.badgeLight).toBe('rgba(255, 85, 0, 0.12)');
    expect(result.text).toBeTruthy();
    expect(result.textLight).toBeTruthy();
    expect(getThemedText(result, true)).not.toBe('#ff5500');
  });

  it('hashes unknown non-hex strings to a valid named color (not always blue)', () => {
    const result = getTeamColorSet('nonexistent');
    // Should be a valid color set from the named palette, not necessarily blue
    expect(isValidColorSet(result)).toBe(true);
    // Should be deterministic
    expect(getTeamColorSet('nonexistent')).toEqual(result);
    // Different unknown strings should potentially yield different colors
    const colors = new Set(
      ['coral', 'sapphire', 'honey', 'arctic', 'chartreuse'].map(
        (name) => getTeamColorSet(name).border
      )
    );
    expect(colors.size).toBeGreaterThan(1);
  });
});

// =============================================================================
// getSubagentTypeColorSet
// =============================================================================

describe('getSubagentTypeColorSet', () => {
  it('always returns a valid TeamColorSet without agent configs', () => {
    const types = ['test-agent', 'quality-fixer', 'Explore', 'Plan', 'my-custom-agent', 'anything'];
    for (const t of types) {
      const result = getSubagentTypeColorSet(t);
      expect(isValidColorSet(result)).toBe(true);
    }
  });

  it('is deterministic — same input always returns same color', () => {
    const a = getSubagentTypeColorSet('my-custom-agent');
    const b = getSubagentTypeColorSet('my-custom-agent');
    expect(a).toEqual(b);
  });

  it('different types can produce different colors', () => {
    const results = new Set(
      [
        'Explore',
        'Plan',
        'test-agent',
        'quality-fixer',
        'claude-md-auditor',
        'Bash',
        'general-purpose',
        'statusline-setup',
      ].map((t) => getSubagentTypeColorSet(t).border)
    );
    expect(results.size).toBeGreaterThan(1);
  });

  it('uses color from agent config when available', () => {
    const configs = {
      'test-agent': { name: 'test-agent', color: 'red' },
    };
    const result = getSubagentTypeColorSet('test-agent', configs);
    // Should use the named "red" color from getTeamColorSet
    expect(result.border).toBe('#ef4444');
    expect(result.text).toBe('#f87171');
  });

  it('uses hex color from agent config', () => {
    const configs = {
      'my-agent': { name: 'my-agent', color: '#ff00ff' },
    };
    const result = getSubagentTypeColorSet('my-agent', configs);
    expect(result.border).toBe('#ff00ff');
  });

  it('falls back to hash when agent config has no color', () => {
    const configs = {
      'my-agent': { name: 'my-agent' },
    };
    const withConfig = getSubagentTypeColorSet('my-agent', configs);
    const withoutConfig = getSubagentTypeColorSet('my-agent');
    // Should be the same — both use hash fallback
    expect(withConfig).toEqual(withoutConfig);
  });

  it('falls back to hash when agent type not in configs', () => {
    const configs = {
      'other-agent': { name: 'other-agent', color: 'green' },
    };
    const withConfig = getSubagentTypeColorSet('unknown-agent', configs);
    const withoutConfig = getSubagentTypeColorSet('unknown-agent');
    expect(withConfig).toEqual(withoutConfig);
  });

  it('does not interfere with getTeamColorSet', () => {
    const teamGreen = getTeamColorSet('green');
    expect(teamGreen.border).toBe('#22c55e');

    const configs = { green: { name: 'green', color: 'purple' } };
    getSubagentTypeColorSet('green', configs);
    // Team API remains unaffected
    expect(getTeamColorSet('green').border).toBe('#22c55e');
  });
});

describe('scaleColorAlpha', () => {
  it('halves rgba badge opacity', () => {
    expect(scaleColorAlpha('rgba(59, 130, 246, 0.15)', 0.5)).toBe('rgba(59, 130, 246, 0.075)');
  });

  it('halves hsla badge opacity', () => {
    expect(scaleColorAlpha('hsla(220, 80%, 50%, 0.12)', 0.5)).toBe('hsla(220, 80%, 50%, 0.06)');
  });

  it('halves hex alpha badge opacity', () => {
    expect(scaleColorAlpha('#ff550026', 0.5)).toBe('#ff550013');
  });
});
