import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BudgetAlertsPanel } from './BudgetAlertsPanel';

import type { TokenUsageBudgetSettingsDto, TokenUsageBudgetStatusDto } from '../../contracts';
import type { Root } from 'react-dom/client';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
const t = (key: string, options?: Record<string, unknown>): string =>
  `${key}${options?.value ? ` ${options.value}` : ''}`;
const config: TokenUsageBudgetSettingsDto = {
  updatedAt: '2026-10-03T00:00:00.000Z',
  global: {
    monthlyTokenLimit: 100,
    monthlyApiEquivalentCostLimitUsd: 10,
    thresholds: [50, 90],
    notificationsEnabled: true,
  },
  projects: {
    'project:outside:filters': {
      monthlyTokenLimit: 200,
      thresholds: [],
      notificationsEnabled: false,
    },
  },
};
const status: TokenUsageBudgetStatusDto = {
  period: {
    key: '2026-10',
    from: '2026-10-01T00:00:00.000Z',
    to: '2026-11-01T00:00:00.000Z',
    timeZone: 'UTC',
  },
  computedAt: '2026-10-03T12:00:00.000Z',
  stale: false,
  degraded: false,
  notificationPolicy: { enabled: true, nativeToasts: true },
  options: [
    { scope: 'global', id: 'global', label: 'All teams' },
    { scope: 'project', id: 'project:outside:filters', label: 'Outside filters' },
  ],
  targets: [
    {
      scope: 'global',
      id: 'global',
      label: 'All teams',
      thresholds: [50, 90],
      notificationsEnabled: true,
      metrics: [
        { metric: 'tokens', value: 150, limit: 100, percent: 150, remaining: 0, incomplete: false },
      ],
    },
    {
      scope: 'project',
      id: 'project:outside:filters',
      label: 'Outside filters',
      thresholds: [],
      notificationsEnabled: false,
      metrics: [
        { metric: 'tokens', value: 0, limit: 200, percent: 0, remaining: 200, incomplete: false },
      ],
    },
  ],
};

describe('Budget Save/Cancel and standalone status', () => {
  let container: HTMLDivElement;
  let root: Root;
  let selected: string;
  let save: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    selected = 'global:global';
    save = vi.fn(async () => undefined);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  async function render(settings = config, data = status) {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <BudgetAlertsPanel
            status={data}
            budgetConfig={settings}
            budgetTargetKey={selected}
            error={null}
            loaded
            onBudgetTargetKeyChange={(key) => {
              selected = key;
            }}
            onSave={save}
            onReload={async () => true}
            onOpenNotificationSettings={() => undefined}
            t={t}
          />
        </TooltipProvider>
      )
    );
  }
  async function button(key: string) {
    const element = [...document.querySelectorAll('button')].find(
      (item) => item.textContent === key
    );
    if (!element) throw new Error(`Missing ${key}`);
    await act(async () => element.click());
  }
  async function input(label: string, text: string) {
    const element = [...document.querySelectorAll('input')].find(
      (item) =>
        item.closest('label')?.textContent?.startsWith(label) ||
        item.getAttribute('aria-label') === label
    );
    if (!element) throw new Error(`Missing input ${label}`);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        element,
        text
      );
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  async function open() {
    await button('tokenUsage.budgets.editor.title');
  }
  async function choose(label: string) {
    const trigger = document.querySelector('[role="dialog"] [role="combobox"]')!;
    await act(async () =>
      trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    );
    const option = [...document.querySelectorAll('[role="option"]')].find(
      (element) => element.textContent === label || element.textContent?.endsWith(`/ ${label}`)
    )!;
    await act(async () =>
      option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    );
  }
  // These assertions go red under the old autosave form even before touching disk.
  it('typing and Cancel never write; Save writes once and preserves unedited identities', async () => {
    await render();
    await open();
    await input('tokenUsage.budgets.tokenLimit', '250');
    expect(save).not.toHaveBeenCalled();
    await button('tokenUsage.budgets.editor.cancel');
    await open();
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')!.value).toBe('100');
    await input('tokenUsage.budgets.tokenLimit', '250');
    await button('tokenUsage.budgets.editor.save');
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({
      global: { monthlyTokenLimit: 250 },
      projects: config.projects,
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('invalid limits and duplicate chips prevent Save; empty thresholds remain valid', async () => {
    await render();
    await open();
    await input('tokenUsage.budgets.tokenLimit', '0');
    await button('tokenUsage.budgets.editor.save');
    expect(save).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('tokenUsage.budgets.editor.invalidLimit');
    await input('tokenUsage.budgets.tokenLimit', '100');
    const chips = [
      ...document.querySelectorAll('input[aria-label="tokenUsage.budgets.editor.threshold"]'),
    ];
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        chips[1],
        '50'
      );
      chips[1].dispatchEvent(new Event('input', { bubbles: true }));
    });
    await button('tokenUsage.budgets.editor.save');
    expect(save).not.toHaveBeenCalled();
    const removals = [
      ...document.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="tokenUsage.budgets.editor.removeThreshold"]'
      ),
    ];
    await act(async () => removals[1].click());
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="tokenUsage.budgets.editor.removeThreshold"]'
        )!
        .click()
    );
    await button('tokenUsage.budgets.editor.save');
    expect(save.mock.calls[0][0].global.thresholds).toEqual([]);
  });
  it('multi-scope edits survive navigation; unconfigured initial scope does not create an empty budget', async () => {
    await render({ projects: config.projects });
    await open();
    await choose('Outside filters');
    await input('tokenUsage.budgets.tokenLimit', '300');
    await choose('tokenUsage.budgets.allTeams');
    await choose('Outside filters');
    expect(document.querySelector<HTMLInputElement>('[role="dialog"] input')!.value).toBe('300');
    await button('tokenUsage.budgets.editor.save');
    expect(save.mock.calls[0][0]).toEqual({
      projects: {
        'project:outside:filters': {
          monthlyTokenLimit: 300,
          thresholds: [],
          notificationsEnabled: false,
        },
      },
    });
  });
  it('delete is draft-only and Save applies it', async () => {
    await render();
    await open();
    await button('tokenUsage.budgets.editor.delete');
    expect(save).not.toHaveBeenCalled();
    await button('tokenUsage.budgets.editor.save');
    expect(save.mock.calls[0][0].global).toBeUndefined();
    expect(save.mock.calls[0][0].projects).toEqual(config.projects);
  });
  it('in-flight blocks Save/close; failure preserves typed draft', async () => {
    let reject!: (error: Error) => void;
    save.mockImplementation(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        })
    );
    await render();
    await open();
    await input('tokenUsage.budgets.tokenLimit', '400');
    await button('tokenUsage.budgets.editor.save');
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('button[aria-disabled="true"]')).not.toBeNull();
    expect(
      [...dialog.querySelectorAll('button')].find(
        (item) => item.textContent === 'tokenUsage.budgets.editor.cancel'
      )?.disabled
    ).toBe(true);
    await act(async () => reject(new Error('Budget settings changed')));
    expect(document.body.textContent).toContain('Budget settings changed');
    expect(dialog.querySelector<HTMLInputElement>('input')!.value).toBe('400');
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('shows over100, zero outside filters, stale/degraded and pause without changing selected identity', async () => {
    await render();
    expect(container.textContent).toContain('150.0%');
    expect(container.querySelector<HTMLElement>('.bg-red-500')?.style.width).toBe('100%');
    selected = 'project:project:outside:filters';
    await render(config, { ...status, stale: true, degraded: true });
    expect(container.textContent).toContain('0.0%');
    expect(container.textContent).toContain('tokenUsage.budgets.card.stale');
    expect(container.textContent).toContain('tokenUsage.budgets.card.degraded');
    expect(container.textContent).toContain('tokenUsage.budgets.card.paused');
    expect(container.textContent).toContain('Outside filters');
  });
});
