import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  formatOpenCodeCatalogReport,
  OpenCodeCatalogErrorAlert,
} from '../../../../src/features/runtime-provider-management/renderer/ui/OpenCodeCatalogErrorAlert';

import type { OpenCodeCatalogFailure } from '../../../../src/features/runtime-provider-management/renderer/hooks/catalogFailure';

function failures(count = 4, previewSize = 50): OpenCodeCatalogFailure[] {
  return Array.from({ length: count }, (_, index) => ({
    operation: 'provider_models',
    sourceProviderId: `source-${index}`,
    origin: 'main',
    message: 'Catalog failed api_key=private-value',
    diagnostics: {
      reportId: `oc-report-${index}`,
      stage: 'runtime_command',
      summary: null,
      likelyCause: null,
      binaryPath: '/sandbox/runtime',
      command: 'runtime providers models',
      projectPath: '/sandbox/catalog',
      exitCode: 7,
      stderrPreview: `token=private-value ${'x'.repeat(previewSize)}`,
      stdoutPreview: null,
      hints: [],
    },
  }));
}
let root: Root;
let host: HTMLDivElement;
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => Promise.resolve(root.unmount()));
  host.remove();
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  else Reflect.deleteProperty(navigator, 'clipboard');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function clipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
}

it.each([50, 20000])(
  'bounds combined reports and preserves all four IDs with %s preview characters',
  (size) => {
    const report = formatOpenCodeCatalogReport(failures(4, size));
    expect(report.length).toBeLessThanOrEqual(16384);
    expect(report).not.toContain('private-value');
    expect(report).not.toContain('provider settings');
    for (let index = 0; index < 4; index++) {
      expect(report).toContain(`source=source-${index}`);
      expect(report).toContain(`reportId=oc-report-${index}`);
    }
    if (size > 16384) expect(report).toContain('[truncated]');
  }
);

it('copies all current failures and expands their useful details', async () => {
  const current = failures();
  const write = vi.fn(() => Promise.resolve());
  clipboard(write);
  await act(() =>
    Promise.resolve(
      root.render(React.createElement(OpenCodeCatalogErrorAlert, { failures: current }))
    )
  );
  await act(() => Promise.resolve(host.querySelector('button')!.click()));
  expect(write).toHaveBeenCalledWith(formatOpenCodeCatalogReport(current));
  await act(() =>
    Promise.resolve(host.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
  );
  expect(host.textContent).toContain('oc-report-3');
  expect(host.textContent).toContain('runtime providers models');
});

it('offers each omitted failure separately and keeps origin in its copy', async () => {
  const current = failures(33);
  const lastPreview = vi.fn(() => 'Last preview');
  Object.defineProperty(current[32].diagnostics!, 'stderrPreview', { get: lastPreview });
  const write = vi.fn(() => Promise.resolve());
  clipboard(write);
  await act(() =>
    Promise.resolve(
      root.render(React.createElement(OpenCodeCatalogErrorAlert, { failures: current }))
    )
  );
  expect(formatOpenCodeCatalogReport(current)).toContain('17 failures omitted');
  const individuals = () => host.querySelectorAll('[data-testid^="opencode-catalog-error-"]');
  const next = () =>
    host.querySelector<HTMLButtonElement>('[data-testid="opencode-catalog-next-page"]')!;
  const previous = () =>
    host.querySelector<HTMLButtonElement>('[data-testid="opencode-catalog-previous-page"]')!;
  expect(individuals()).toHaveLength(16);
  expect(previous().disabled).toBe(true);
  expect(lastPreview).not.toHaveBeenCalled();
  await act(() => Promise.resolve(next().click()));
  expect(individuals()).toHaveLength(16);
  expect(host.querySelector('[data-testid="opencode-catalog-error-0"]')).toBeNull();
  expect(lastPreview).not.toHaveBeenCalled();
  await act(() => Promise.resolve(next().click()));
  expect(individuals()).toHaveLength(1);
  expect(next().disabled).toBe(true);
  expect(lastPreview).toHaveBeenCalled();
  const last = host.querySelector('[data-testid="opencode-catalog-error-32"]')!;
  await act(() => Promise.resolve(last.querySelector('button')!.click()));
  expect(write).toHaveBeenCalledWith(
    expect.stringContaining('source=source-32 origin=main reportId=oc-report-32')
  );
  await act(() =>
    Promise.resolve(
      host.querySelector('[data-testid="opencode-catalog-error"]')!.querySelector('button')!.click()
    )
  );
  expect(write).toHaveBeenLastCalledWith(formatOpenCodeCatalogReport(current));
  await act(() => Promise.resolve(previous().click()));
  expect(individuals()).toHaveLength(16);
  expect(host.querySelector('[data-testid="opencode-catalog-error-16"]')).not.toBeNull();
});

it('uses selection fallback, then exposes the same redacted combined report for manual copying', async () => {
  const current = failures();
  clipboard(vi.fn().mockRejectedValue(new Error('denied')));
  const original = Object.getOwnPropertyDescriptor(document, 'execCommand');
  const selectionCopy = vi.fn(() => true);
  Object.defineProperty(document, 'execCommand', { configurable: true, value: selectionCopy });
  try {
    await act(() =>
      Promise.resolve(
        root.render(React.createElement(OpenCodeCatalogErrorAlert, { failures: current }))
      )
    );
    await act(() => Promise.resolve(host.querySelector('button')!.click()));
    expect(selectionCopy).toHaveBeenCalledWith('copy');
    expect(host.querySelector('[role="status"]')).toBeNull();
    selectionCopy.mockReturnValue(false);
    await act(() => Promise.resolve(host.querySelector('button')!.click()));
    expect(host.querySelector('[role="status"] pre')?.textContent).toBe(
      formatOpenCodeCatalogReport(current)
    );
    expect(document.querySelector('textarea')).toBeNull();
  } finally {
    if (original) Object.defineProperty(document, 'execCommand', original);
    else Reflect.deleteProperty(document, 'execCommand');
  }
});

it('ignores completion of a previous combined report copy after retry', async () => {
  let finish!: () => void;
  clipboard(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  await act(() =>
    Promise.resolve(
      root.render(React.createElement(OpenCodeCatalogErrorAlert, { failures: failures() }))
    )
  );
  await act(() => Promise.resolve(host.querySelector('button')!.click()));
  const next = failures(1);
  next[0].message = 'New attempt';
  await act(() =>
    Promise.resolve(root.render(React.createElement(OpenCodeCatalogErrorAlert, { failures: next })))
  );
  await act(() => Promise.resolve(finish()));
  expect(host.textContent).not.toContain('Copied');
});

it.each(['client_validation', 'transport', 'stale'] as const)(
  'reports %s honestly without inventing main or HTTP context',
  (origin) => {
    const report = formatOpenCodeCatalogReport([
      {
        operation: 'provider_directory',
        sourceProviderId: null,
        origin,
        message: 'unavailable',
      },
    ]);
    expect(report).toContain(`origin=${origin} reportId=unavailable`);
    expect(report).toContain(
      origin === 'stale' ? 'Data state: stale' : 'Main log correlation: unavailable'
    );
    expect(report).not.toContain('Exit code:');
    expect(report).not.toContain('httpStatus');
  }
);

it('provides per-error copying when previews are clipped even though no failures are omitted', async () => {
  const current = failures(4, 20000);
  const write = vi.fn(() => Promise.resolve());
  clipboard(write);
  await act(() =>
    Promise.resolve(
      root.render(React.createElement(OpenCodeCatalogErrorAlert, { failures: current }))
    )
  );
  const report = formatOpenCodeCatalogReport(current);
  expect(report).toContain('[truncated]');
  expect(report).not.toContain('failures omitted');
  for (let index = 0; index < 4; index++) {
    const individual = host.querySelector(`[data-testid="opencode-catalog-error-${index}"]`)!;
    expect(individual).not.toBeNull();
    await act(() => Promise.resolve(individual.querySelector('button')!.click()));
    expect(write).toHaveBeenLastCalledWith(formatOpenCodeCatalogReport([current[index]]));
  }
});

it('resets pagination on retry, shrinking failures, and an empty result', async () => {
  const render = async (current: OpenCodeCatalogFailure[]) => {
    await act(() =>
      Promise.resolve(
        root.render(React.createElement(OpenCodeCatalogErrorAlert, { failures: current }))
      )
    );
  };
  const advance = async () => {
    await act(() =>
      Promise.resolve(
        host.querySelector<HTMLButtonElement>('[data-testid="opencode-catalog-next-page"]')!.click()
      )
    );
  };
  await render(failures(33));
  await advance();
  await advance();
  const retry = failures(33);
  retry.forEach((failure) => {
    failure.message = 'New attempt';
  });
  await render(retry);
  expect(host.querySelector('[data-testid="opencode-catalog-error-0"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="opencode-catalog-error-32"]')).toBeNull();
  expect(host.textContent).not.toContain('Catalog failed');
  await advance();
  await render(failures(4, 20000));
  expect(host.querySelectorAll('[data-testid^="opencode-catalog-error-"]')).toHaveLength(4);
  expect(host.querySelector('[data-testid="opencode-catalog-next-page"]')).toBeNull();
  await render([]);
  expect(host.textContent).toBe('');
  await render(failures(33));
  expect(host.querySelector('[data-testid="opencode-catalog-error-0"]')).not.toBeNull();
  expect(
    host.querySelector<HTMLButtonElement>('[data-testid="opencode-catalog-previous-page"]')!
      .disabled
  ).toBe(true);
});
