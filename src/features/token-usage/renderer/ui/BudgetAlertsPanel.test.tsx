import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BudgetAlertsPanel } from './BudgetAlertsPanel';

import type {
  TokenUsageBudgetLimits,
  TokenUsageBudgetTargetOptionViewModel,
} from '../view-models/tokenUsageViewModel';
import type { Root } from 'react-dom/client';

const globalOption: TokenUsageBudgetTargetOptionViewModel = {
  scope: 'global',
  id: 'global',
  label: 'All teams',
  tokens: '0',
  cost: '$0',
  tokenValue: 0,
};
const translate = (key: string, options?: Record<string, unknown>): string =>
  typeof options?.scope === 'string' ? `${key}: ${options.scope}` : key;

describe('BudgetAlertsPanel selected identity', () => {
  let container: HTMLDivElement;
  let root: Root;
  let config: TokenUsageBudgetLimits;
  let selectedKey: string;
  let configChanges: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    config = { global: { monthlyTokenLimit: 100, monthlyApiEquivalentCostLimitUsd: 10 } };
    selectedKey = 'global:global';
    configChanges = vi.fn();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = async (options: TokenUsageBudgetTargetOptionViewModel[]): Promise<void> => {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <BudgetAlertsPanel
            alerts={[]}
            budgetConfig={config}
            budgetTargetKey={selectedKey}
            budgetTargetOptions={options}
            error={null}
            onBudgetTargetKeyChange={(key) => {
              selectedKey = key;
            }}
            onBudgetConfigChange={(update) => {
              config = typeof update === 'function' ? update(config) : update;
              configChanges(config);
            }}
            onOpenNotificationSettings={() => undefined}
            t={translate}
          />
        </TooltipProvider>
      );
    });
  };

  const selectTarget = async (label: string): Promise<void> => {
    const trigger = container.querySelector('[role="combobox"]');
    if (!trigger) throw new Error('Missing budget selector');
    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const option = [...document.querySelectorAll('[role="option"]')].find((item) =>
      item.textContent?.endsWith(`/ ${label}`)
    );
    if (!option) throw new Error(`Missing budget option ${label}`);
    await act(async () => {
      option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
  };

  const editLimit = async (value: string, index = 0): Promise<void> => {
    const input = container.querySelectorAll<HTMLInputElement>('input[type="number"]')[index];
    if (!input) throw new Error('Missing budget input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.bind(
      input
    );
    if (!setter) throw new Error('Missing native input setter');
    await act(async () => {
      setter(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  // A filtered snapshot previously redirected these edits to the global budget.
  it.each([
    { scope: 'team' as const, id: 'sandbox-team', label: 'Sandbox team' },
    { scope: 'project' as const, id: '/sandbox/project:example', label: 'Sandbox project' },
  ])('keeps editing the selected $scope after its option disappears', async (target) => {
    const options = [globalOption, { ...target, tokens: '0', cost: '$0', tokenValue: 0 }];
    await render(options);
    await selectTarget(target.label);
    expect(selectedKey).toBe(`${target.scope}:${target.id}`);
    await render(options);
    expect(container.querySelector('[role="combobox"]')?.textContent).toContain(target.label);

    await render([globalOption]);
    expect(container.querySelector('[role="combobox"]')?.textContent).toContain(target.id);
    expect(container.textContent).toContain(`tokenUsage.budgets.configureFor: ${target.id}`);
    await editLimit('250');
    await editLimit('25.5', 1);

    expect(config.global).toEqual({ monthlyTokenLimit: 100, monthlyApiEquivalentCostLimitUsd: 10 });
    const limits = target.scope === 'team' ? config.teams : config.projects;
    expect(limits).toEqual({
      [target.id]: { monthlyTokenLimit: 250, monthlyApiEquivalentCostLimitUsd: 25.5 },
    });
    expect(target.scope === 'team' ? config.projects : config.teams).toBeUndefined();

    await render([globalOption]);
    await selectTarget(globalOption.label);
    await render([globalOption]);
    await editLimit('300');
    expect(config.global?.monthlyTokenLimit).toBe(300);
    expect(
      (target.scope === 'team' ? config.teams : config.projects)?.[target.id]?.monthlyTokenLimit
    ).toBe(250);
  });

  it.each(['unknown:sandbox', 'team:', 'project:', 'global:other', 'global'])(
    'disables editing for an invalid target %s',
    async (key) => {
      selectedKey = key;
      await render([globalOption]);
      expect(container.querySelector('[role="combobox"]')?.textContent).toContain(key);
      const inputs = [...container.querySelectorAll<HTMLInputElement>('input[type="number"]')];
      expect(inputs).toHaveLength(2);
      expect(inputs.every((input) => input.disabled)).toBe(true);
      await editLimit('999');
      expect(configChanges).not.toHaveBeenCalled();
      expect(config.global?.monthlyTokenLimit).toBe(100);
    }
  );
});
