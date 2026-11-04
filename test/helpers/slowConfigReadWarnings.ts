import { vi } from 'vitest';

const SLOW_CONFIG_READ_WARNING = '[getConfig] slow read diag=';

/**
 * TeamConfigReader warns when one config read takes 500 ms or more, which a
 * loaded machine can hit in tests that read real team files. test/setup.ts
 * fails a test on any console.warn, so such tests call this in afterEach: it
 * clears the warnings only when every one of them is that diagnostic.
 */
export function clearSlowConfigReadWarnings(): void {
  const warn = vi.mocked(console.warn);
  if (
    warn.mock.calls.length > 0 &&
    warn.mock.calls.every((call) =>
      call
        .map((part) => String(part))
        .join(' ')
        .includes(SLOW_CONFIG_READ_WARNING)
    )
  ) {
    warn.mockClear();
  }
}
