import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, expect, it, vi } from 'vitest';

import { ModelRow } from '../../../../src/features/runtime-provider-management/renderer/ui/RuntimeProviderModelRow';

import type { ComponentProps } from 'react';

afterEach(() => vi.useRealTimers());

it('shows elapsed time from test start across remounts and clears its timer', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.setSystemTime(20_000);
  const host = document.createElement('div');
  const root = createRoot(host);
  const testModel = vi.fn();
  const stopModelTest = vi.fn(async () => false);
  const setDefaultModel = vi.fn();
  const props = {
    provider: { providerId: 'test' },
    model: { modelId: 'test/model', displayName: 'Test model', providerId: 'test' },
    selected: true,
    disabled: false,
    hasProjectContext: true,
    testing: true,
    testStartedAt: 10_000,
    result: undefined,
    defaultTarget: 'all_projects',
    intendedProjectPath: null,
    savingDefault: false,
    defaultMutationBusy: false,
    badges: null,
    formatMessage: (message: string) => ({ summary: message, details: null }),
    actions: { testModel, setDefaultModel, stopModelTest },
  } as unknown as ComponentProps<typeof ModelRow>;
  const baselineTimers = vi.getTimerCount();
  await act(async () => {
    root.render(<ModelRow {...props} />);
  });
  expect(host.querySelector('[role="status"]')?.textContent).toContain('10s');
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  expect(host.querySelector('[role="status"]')?.textContent).toContain('12s');
  await act(async () => {
    root.render(<ModelRow {...props} key="remount" />);
  });
  expect(host.querySelector('[role="status"]')?.textContent).toContain('12s');
  expect(host.textContent).not.toContain('%');
  await act(async () => {
    Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent === 'Stop')
      ?.click();
  });
  expect(stopModelTest).toHaveBeenCalledWith('test', 'test/model');
  expect(host.textContent).not.toContain('Test cancelled');
  await act(async () => {
    root.render(<ModelRow {...props} key="remount" testing={false} />);
  });
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(vi.getTimerCount()).toBe(baselineTimers);
  await act(async () => {
    host.querySelector<HTMLButtonElement>('button[aria-label^="Test:"]')?.click();
  });
  expect(testModel).toHaveBeenCalledWith('test', 'test/model');
  expect(setDefaultModel).not.toHaveBeenCalled();
  expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toBe('Selected');
  await act(async () => {
    root.render(<ModelRow {...props} testing={false} hasProjectContext={false} />);
  });
  expect(
    host.querySelector<HTMLButtonElement>('[data-testid="runtime-provider-model-test-test/model"]')
      ?.disabled
  ).toBe(true);
  expect(
    host.querySelector('[data-testid="runtime-provider-model-test-hint-test/model"]')?.textContent
  ).toBeTruthy();
  await act(async () => {
    root.render(
      <ModelRow
        {...props}
        key="stopped-remount"
        testing={false}
        cancelled
        result={{
          providerId: 'test',
          modelId: 'test/model',
          ok: true,
          availability: 'available',
          message: 'Old success',
          diagnostics: [],
        }}
      />
    );
  });
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Test stopped.');
  expect(host.textContent).not.toContain('Old success');
  await act(async () => root.unmount());
});
