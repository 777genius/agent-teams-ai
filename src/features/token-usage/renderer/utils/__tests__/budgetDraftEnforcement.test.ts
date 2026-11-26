import { describe, expect, it } from 'vitest';

import { namedTeamId } from '../../../contracts';
import { createBudgetDraft, settingsFromDraft } from '../budgetDraft';

describe('team budget draft compatibility', () => {
  it('preserves a configured team stop policy without changing unrelated budgets', () => {
    const id = namedTeamId('alpha');
    const original = {
      global: { monthlyTokenLimit: 1000, thresholds: [50], notificationsEnabled: true },
      teams: {
        [id]: {
          monthlyTokenLimit: 50,
          thresholds: [80, 100],
          notificationsEnabled: true,
          onExceeded: 'stop_team' as const,
        },
      },
    };
    const draft = createBudgetDraft(original);
    expect(draft[`team:${id}`]?.onExceeded).toBe('stop_team');
    expect(settingsFromDraft(draft).teams?.[id].onExceeded).toBe('stop_team');
    expect(settingsFromDraft(draft).global?.onExceeded).toBeUndefined();
  });
  it('keeps old notification-only configs default even after Save', () => {
    const original = {
      teams: {
        [namedTeamId('beta')]: {
          monthlyApiEquivalentCostLimitUsd: 20,
          thresholds: [],
          notificationsEnabled: false,
        },
      },
    };
    const saved = settingsFromDraft(createBudgetDraft(original));
    expect(saved).toEqual(original);
  });
});
