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
  ).toBe(false);
  expect(
    host.querySelector('[data-testid="runtime-provider-model-test-hint-test/model"]')
  ).toBeNull();
  await act(async () => {
    host
      .querySelector<HTMLButtonElement>('[data-testid="runtime-provider-model-test-test/model"]')
      ?.click();
  });
  expect(testModel).toHaveBeenCalledTimes(2);
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

it.each(['quota', 'other-error', 'success', 'changed-project'])(
  'retries the confirmed free quota exactly once and keeps the paid result separate (%s)',
  async (scenario) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    let finish!: (value: unknown) => void;
    const original = new Promise((resolve) => {
      finish = resolve;
    });
    const testModel = vi
      .fn()
      .mockReturnValueOnce(original)
      .mockResolvedValue({
        providerId: 'openrouter',
        modelId: 'openrouter/openai/gpt-oss-20b',
        ok: false,
        availability: 'unknown',
        message: 'Paid provider refused the request',
        diagnostics: ['provider_free_quota_exhausted'],
      });
    const props = {
      provider: { providerId: 'openrouter' },
      model: {
        modelId: 'openrouter/test:free',
        providerId: 'openrouter',
        displayName: 'Free model',
        free: true,
      },
      selected: false,
      disabled: false,
      hasProjectContext: true,
      testing: false,
      result: undefined,
      defaultTarget: null,
      intendedProjectPath: '/TEST-first',
      savingDefault: false,
      defaultMutationBusy: false,
      badges: null,
      formatMessage: (message: string) => ({ summary: message, details: null }),
      actions: { testModel },
    } as unknown as ComponentProps<typeof ModelRow>;
    try {
      await act(async () => root.render(<ModelRow {...props} />));
      expect(host.textContent).toContain('automatically retry once');
      expect(host.textContent).toContain('uses your OpenRouter balance');
      await act(async () =>
        host.querySelector<HTMLButtonElement>('button[aria-label^="Test:"]')?.click()
      );
      if (scenario === 'changed-project') {
        await act(async () =>
          root.render(<ModelRow {...props} intendedProjectPath="/TEST-other" />)
        );
      }
      await act(async () =>
        finish({
          providerId: 'openrouter',
          modelId: props.model.modelId,
          ok: scenario === 'success',
          availability: 'unknown',
          message: 'Free test result',
          diagnostics: scenario === 'other-error' ? [] : ['provider_free_quota_exhausted'],
        })
      );
      expect(testModel.mock.calls).toEqual(
        scenario === 'quota'
          ? [
              ['openrouter', props.model.modelId],
              ['openrouter', 'openrouter/openai/gpt-oss-20b'],
            ]
          : [['openrouter', props.model.modelId]]
      );
      if (scenario === 'quota') {
        expect(host.textContent).toContain('Paid retry with gpt-oss-20b');
        expect(host.textContent).toContain('Paid provider refused');
      }
    } finally {
      await act(async () => root.unmount());
    }
  }
);

const quotaResult = {
  providerId: 'openrouter',
  modelId: 'openrouter/test:free',
  ok: false,
  availability: 'unknown',
  message: 'Free quota reached',
  diagnostics: ['provider_free_quota_exhausted'],
};
const paidResult = {
  ...quotaResult,
  modelId: 'openrouter/openai/gpt-oss-20b',
  ok: true,
  message: 'Paid model responded',
  diagnostics: [],
};
const retryProps = (testModel: unknown, stopModelTest: unknown) =>
  ({
    provider: { providerId: 'openrouter' },
    model: {
      modelId: quotaResult.modelId,
      providerId: 'openrouter',
      displayName: 'Free model',
      free: true,
    },
    selected: false,
    disabled: false,
    hasProjectContext: true,
    testing: false,
    result: undefined,
    defaultTarget: null,
    intendedProjectPath: '/TEST-first',
    savingDefault: false,
    defaultMutationBusy: false,
    badges: null,
    formatMessage: (message: string) => ({ summary: message, details: null }),
    actions: { testModel, stopModelTest },
  }) as unknown as ComponentProps<typeof ModelRow>;

it('latches Stop before its IPC settles, while a later explicit Test can still retry once', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let finishFree!: (value: unknown) => void;
  let finishStop!: (value: boolean) => void;
  const testModel = vi
    .fn()
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finishFree = resolve;
      })
    )
    .mockResolvedValueOnce(quotaResult)
    .mockResolvedValueOnce(paidResult);
  const stopModelTest = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finishStop = resolve;
      })
  );
  const props = retryProps(testModel, stopModelTest);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<ModelRow {...props} />));
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label^="Test:"]')?.click()
    );
    await act(async () => root.render(<ModelRow {...props} testing />));
    await act(async () =>
      Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === 'Stop')
        ?.click()
    );
    await act(async () => finishFree(quotaResult));
    expect(testModel).toHaveBeenCalledOnce();
    await act(async () => finishStop(true));
    await act(async () => root.render(<ModelRow {...props} cancelled />));
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label^="Test:"]')?.click();
      root.render(<ModelRow {...props} cancelled={false} />);
    });
    expect(testModel.mock.calls).toEqual([
      ['openrouter', quotaResult.modelId],
      ['openrouter', quotaResult.modelId],
      ['openrouter', paidResult.modelId],
    ]);
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([false, true])(
  'shows paid Stop as completed only after confirmation (%s)',
  async (stopped) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let finishPaid!: (value: unknown) => void;
    const testModel = vi
      .fn()
      .mockResolvedValueOnce(quotaResult)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishPaid = resolve;
        })
      );
    const stopModelTest = vi.fn(async () => stopped);
    const props = retryProps(testModel, stopModelTest);
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () => root.render(<ModelRow {...props} />));
      await act(async () =>
        host.querySelector<HTMLButtonElement>('button[aria-label^="Test:"]')?.click()
      );
      await act(async () =>
        Array.from(host.querySelectorAll('button'))
          .find((b) => b.textContent === 'Stop')
          ?.click()
      );
      expect(stopModelTest).toHaveBeenCalledWith('openrouter', paidResult.modelId);
      expect(host.textContent?.includes('Test stopped.')).toBe(stopped);
      await act(async () => finishPaid(paidResult));
      expect(host.textContent?.includes('Paid model responded')).toBe(!stopped);
      expect(testModel).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
    }
  }
);
