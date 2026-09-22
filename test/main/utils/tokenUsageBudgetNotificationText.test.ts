import { describe, expect, it } from 'vitest';

import {
  formatTokenUsageBudgetMetricLabel,
  formatTokenUsageBudgetValue,
} from '@main/utils/tokenUsageBudgetNotificationText';

describe('formatTokenUsageBudgetMetricLabel', () => {
  it('labels the API-equivalent cost metric', () => {
    expect(formatTokenUsageBudgetMetricLabel('apiEquivalentCostUsd')).toBe('API-equivalent');
  });

  it('labels the token metric', () => {
    expect(formatTokenUsageBudgetMetricLabel('tokens')).toBe('token');
  });
});

describe('formatTokenUsageBudgetValue', () => {
  it('formats API-equivalent cost with cents below ten dollars', () => {
    expect(formatTokenUsageBudgetValue(9.456, 'apiEquivalentCostUsd')).toBe('$9.46');
  });

  it('formats API-equivalent cost without cents from ten dollars up', () => {
    expect(formatTokenUsageBudgetValue(10.4, 'apiEquivalentCostUsd')).toBe('$10');
  });

  it('formats millions of tokens', () => {
    expect(formatTokenUsageBudgetValue(2_500_000, 'tokens')).toBe('2.5M tokens');
  });

  it('formats thousands of tokens', () => {
    expect(formatTokenUsageBudgetValue(12_300, 'tokens')).toBe('12.3K tokens');
  });

  it('rounds small token counts', () => {
    expect(formatTokenUsageBudgetValue(999.4, 'tokens')).toBe('999 tokens');
  });
});
