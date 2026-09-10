import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  formatRuntimeProviderDiagnosticsCopyText,
  RuntimeProviderErrorAlert,
} from '../../../../src/features/runtime-provider-management/renderer/ui/RuntimeProviderErrorAlert';

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => {
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  else Reflect.deleteProperty(navigator, 'clipboard');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

it('offers the complete selectable report when both clipboard methods fail', async () => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      React.createElement(RuntimeProviderErrorAlert, {
        message: 'OpenCode failed',
        testId: 'error',
        compact: true,
      })
    )
  );
  await act(async () => host.querySelector('button')!.click());
  expect(host.textContent).not.toContain('Copied');
  expect(host.querySelector('pre')?.textContent).toContain('OpenCode failed');
  await act(async () => root.unmount());
});

it('ignores a clipboard completion belonging to the previous error', async () => {
  let resolve!: () => void;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    },
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      React.createElement(RuntimeProviderErrorAlert, { message: 'First error', testId: 'error' })
    )
  );
  await act(async () => host.querySelector('button')!.click());
  await act(async () =>
    root.render(
      React.createElement(RuntimeProviderErrorAlert, { message: 'Second error', testId: 'error' })
    )
  );
  await act(async () => resolve());
  expect(host.textContent).toContain('Second error');
  expect(host.textContent).not.toContain('Copied');
  await act(async () => root.unmount());
});

it('removes bare and named provider keys from clipboard report text', () => {
  for (const secret of [
    'AIza' + 'a'.repeat(35),
    'or-' + 'b'.repeat(32),
    'custom-private-key-value',
  ]) {
    expect(formatRuntimeProviderDiagnosticsCopyText(`key="${secret}"`, null)).not.toContain(secret);
  }
});

it.each(['Error: api_key=custom-private-key-value', '{"auth":{"key":"custom-private-key-value"}}'])(
  'redacts nested secrets from copy text: %s',
  (message) => {
    expect(formatRuntimeProviderDiagnosticsCopyText(message, null)).not.toContain(
      'custom-private-key-value'
    );
  }
);

it('preserves the provider settings heading unless catalog context is requested', () => {
  expect(formatRuntimeProviderDiagnosticsCopyText('failed', null)).toMatch(
    /^OpenCode provider settings diagnostics/
  );
  expect(
    formatRuntimeProviderDiagnosticsCopyText('failed', null, 'OpenCode catalog diagnostics')
  ).toMatch(/^OpenCode catalog diagnostics/);
});
