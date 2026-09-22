import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { AdvancedCliSection } from '@renderer/components/team/dialogs/AdvancedCliSection';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliArgsValidationResult } from '@shared/utils/cliArgsParser';

const mocks = vi.hoisted(() => ({
  validateCliArgs: vi.fn(),
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, values?: { flags?: string }) =>
      values?.flags ? `${key}: ${values.flags}` : key,
  }),
}));

vi.mock('@renderer/composition/team/createTeamProvisioningDiagnosticsTransport', () => ({
  createTeamProvisioningDiagnosticsTransport: () => ({
    getLaunchFailureDiagnostics: vi.fn(),
    validateCliArgs: mocks.validateCliArgs,
  }),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    size: _size,
    variant: _variant,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    size?: string;
    variant?: string;
  }) => React.createElement('button', props, children),
}));

vi.mock('@renderer/components/ui/checkbox', () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> & {
    onCheckedChange?: (checked: boolean) => void;
  }) =>
    React.createElement('input', {
      ...props,
      checked,
      type: 'checkbox',
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        onCheckedChange?.(event.target.checked),
    }),
}));

vi.mock('@renderer/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement('input', props),
}));

vi.mock('@renderer/components/ui/label', () => ({
  Label: (props: React.LabelHTMLAttributes<HTMLLabelElement>) =>
    React.createElement('label', props),
}));

vi.mock('@renderer/components/ui/popover', () => ({
  Popover: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  PopoverAnchor: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
  PopoverContent: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
}));

vi.mock('lucide-react', () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => React.createElement('svg', props);
  return {
    AlertTriangle: Icon,
    CheckCircle2: Icon,
    ChevronRight: Icon,
    Clock: Icon,
    Loader2: Icon,
    Terminal: Icon,
    XCircle: Icon,
  };
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('AdvancedCliSection', () => {
  let host: HTMLDivElement;
  let root: Root;

  function Harness({ initialArgs }: Readonly<{ initialArgs: string }>): React.JSX.Element {
    const [customArgs, setCustomArgs] = useState(initialArgs);
    return (
      <AdvancedCliSection
        teamName="sandbox-team"
        internalArgs={[]}
        worktreeEnabled={false}
        onWorktreeEnabledChange={vi.fn()}
        worktreeName=""
        onWorktreeNameChange={vi.fn()}
        customArgs={customArgs}
        onCustomArgsChange={setCustomArgs}
      />
    );
  }

  async function render(initialArgs: string): Promise<void> {
    await act(async () => {
      root.render(<Harness initialArgs={initialArgs} />);
      await Promise.resolve();
    });
    await clickButton('advancedCli.title');
  }

  async function clickButton(label: string): Promise<void> {
    const button = Array.from(host.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes(label)
    );
    if (!button) {
      throw new Error(`Button not found: ${label}`);
    }
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
  }

  async function changeCustomArgs(value: string): Promise<void> {
    const input = host.querySelector<HTMLInputElement>('input[placeholder="--max-turns 5"]');
    if (!input) {
      throw new Error('Custom arguments input not found');
    }
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      valueSetter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.validateCliArgs.mockReset();
    localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  });

  it('routes validation through the diagnostics port and preserves loading and success state', async () => {
    const pending = deferred<CliArgsValidationResult>();
    mocks.validateCliArgs.mockReturnValueOnce(pending.promise);
    await render('--max-turns 5');

    await clickButton('advancedCli.validate');

    expect(mocks.validateCliArgs).toHaveBeenCalledWith('--max-turns 5');
    expect(
      Array.from(host.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('advancedCli.validate')
      )?.disabled
    ).toBe(true);

    await act(async () => {
      pending.resolve({ valid: true });
      await pending.promise;
      await Promise.resolve();
    });

    expect(host.textContent).toContain('advancedCli.validation.allFlagsValid');
  });

  it('preserves unsupported transport failures as user-visible validation errors', async () => {
    mocks.validateCliArgs.mockRejectedValueOnce(
      new Error('CLI args validation not available in browser mode')
    );
    await render('--unknown');

    await clickButton('advancedCli.validate');

    expect(host.textContent).toContain('CLI args validation not available in browser mode');
  });

  it('ignores a stale validation result after custom arguments change', async () => {
    const staleRequest = deferred<CliArgsValidationResult>();
    mocks.validateCliArgs
      .mockReturnValueOnce(staleRequest.promise)
      .mockResolvedValueOnce({ valid: false, invalidFlags: ['--second'] });
    await render('--first');

    await clickButton('advancedCli.validate');
    await changeCustomArgs('--second');
    await clickButton('advancedCli.validate');

    expect(host.textContent).toContain('advancedCli.validation.unknownFlags: --second');

    await act(async () => {
      staleRequest.resolve({ valid: true });
      await staleRequest.promise;
      await Promise.resolve();
    });

    expect(host.textContent).toContain('advancedCli.validation.unknownFlags: --second');
    expect(host.textContent).not.toContain('advancedCli.validation.allFlagsValid');
  });
});
