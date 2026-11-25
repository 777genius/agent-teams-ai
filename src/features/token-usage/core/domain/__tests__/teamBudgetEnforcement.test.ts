import { describe, expect, it } from 'vitest';

import { namedTeamId, validateBudgetSettings } from '../../../contracts';
import { assertTeamBudgetLaunchAllowed, evaluateTeamBudgetEnforcement } from '../teamBudgetEnforcement';

import type { TokenUsageBudgetStatusDto } from '../../../contracts';

const status = (options?: {
  action?: 'notify' | 'block_launch' | 'stop_team';
  value?: number | null;
  incomplete?: boolean;
  stale?: boolean;
  degraded?: boolean;
  period?: string;
}): TokenUsageBudgetStatusDto => ({
  period: { key: options?.period ?? '2026-11', from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z', timeZone: 'UTC' },
  computedAt: '2026-11-25T00:00:00.000Z',
  stale: options?.stale ?? false,
  degraded: options?.degraded ?? false,
  notificationPolicy: { enabled: true, nativeToasts: false },
  options: [],
  targets: [{
    scope: 'team', id: namedTeamId('alpha'), label: 'alpha',
    thresholds: [80, 100], notificationsEnabled: true,
    onExceeded: options?.action,
    metrics: [{
      metric: 'tokens', value: options?.value === undefined ? 100 : options.value,
      limit: 100, percent: options?.value === null ? null : (options?.value ?? 100),
      remaining: 0, incomplete: options?.incomplete ?? false,
    }],
  }],
});

describe('team budget enforcement', () => {
  it('keeps older notification-only teams and unrelated teams running', () => {
    expect(evaluateTeamBudgetEnforcement(status(), 'alpha')).toEqual({ action: 'notify', state: 'disabled' });
    expect(() => assertTeamBudgetLaunchAllowed(status({ action: 'stop_team' }), 'beta')).not.toThrow();
  });
  it.each(['block_launch', 'stop_team'] as const)('blocks new launches when %s exceeds', (action) => {
    expect(evaluateTeamBudgetEnforcement(status({ action }), 'alpha').state).toBe('exceeded');
    expect(() => assertTeamBudgetLaunchAllowed(status({ action }), 'alpha')).toThrow('TEAM_BUDGET_BLOCKED');
  });
  it('allows a new month when the counter resets', () => {
    expect(() => assertTeamBudgetLaunchAllowed(status({ action: 'stop_team', value: 0, period: '2026-12' }), 'alpha')).not.toThrow();
  });
  it.each([{ stale: true }, { degraded: true }, { incomplete: true }, { value: null }])(
    'never authorizes launches with %o', (overrides) => {
      const decision = evaluateTeamBudgetEnforcement(
        status({ action: 'stop_team', value: 0, ...overrides }), 'alpha'
      );
      expect(decision.state).toBe('unknown');
      expect(() => assertTeamBudgetLaunchAllowed(
        status({ action: 'stop_team', value: 0, ...overrides }), 'alpha'
      )).toThrow('TEAM_BUDGET_BLOCKED');
    }
  );
  it('stops when a complete counter already exceeded despite an unrelated degraded source', () => {
    expect(evaluateTeamBudgetEnforcement(
      status({ action: 'stop_team', value: 120, degraded: true }), 'alpha'
    ).state).toBe('exceeded');
  });
  it('enforces an already-reached known subtotal despite incomplete pricing', () => {
    expect(evaluateTeamBudgetEnforcement(
      status({ action: 'stop_team', value: 120, incomplete: true }), 'alpha'
    ).state).toBe('exceeded');
    expect(() => assertTeamBudgetLaunchAllowed(
      status({ action: 'stop_team', value: 120, incomplete: true }), 'alpha'
    )).toThrow('TEAM_BUDGET_BLOCKED');
  });
  it('allows under-limit usage', () => {
    expect(evaluateTeamBudgetEnforcement(status({ action: 'stop_team', value: 80 }), 'alpha').state).toBe('within_limit');
  });
  it('rejects destructive policy outside real team scope', () => {
    const limit = { monthlyTokenLimit: 10, thresholds: [80], notificationsEnabled: true, onExceeded: 'stop_team' };
    expect(() => validateBudgetSettings({ global: limit })).toThrow('only supported');
    expect(() => validateBudgetSettings({ projects: { x: limit } })).toThrow('only supported');
    expect(() => validateBudgetSettings({ teams: { anonymous: limit } })).toThrow('only supported');
    expect(validateBudgetSettings({ teams: { [namedTeamId('alpha')]: limit } }).teams?.[namedTeamId('alpha')].onExceeded).toBe('stop_team');
    expect(validateBudgetSettings({ teams: { [namedTeamId('alpha')]: { ...limit, onExceeded: undefined } } }).teams?.[namedTeamId('alpha')].onExceeded).toBeUndefined();
  });
});
