import { resolveCodexDisplayCatalog } from '@main/services/runtime/resolveCodexDisplayCatalog';
import { describe, expect, it, vi } from 'vitest';

import type { CliProviderModelCatalog } from '@shared/types';

const runtimeCatalog = {
  providerId: 'codex',
  models: [{ id: 'model' }],
} as CliProviderModelCatalog;

describe('resolveCodexDisplayCatalog', () => {
  it('clears a runtime effort when the user config was read without an effort', async () => {
    const runtime = { ...runtimeCatalog, configuredReasoningEffort: 'high' } as const;
    const getCatalog = vi.fn().mockResolvedValue({
      diagnostics: { configReadState: 'ready' },
      configuredReasoningEffort: null,
    });
    await expect(resolveCodexDisplayCatalog(runtime, { getCatalog }, true)).resolves.toMatchObject({
      configuredReasoningEffort: null,
    });
  });

  it('preserves a runtime effort when config reading reports failure', async () => {
    const runtime = { ...runtimeCatalog, configuredReasoningEffort: 'high' } as const;
    const getCatalog = vi.fn().mockResolvedValue({
      diagnostics: { configReadState: 'failed' },
      configuredReasoningEffort: null,
    });
    await expect(resolveCodexDisplayCatalog(runtime, { getCatalog }, true)).resolves.toBe(runtime);
  });

  it('keeps the working runtime catalog when reading the user configuration fails', async () => {
    const getCatalog = vi.fn().mockRejectedValue(new Error('config unavailable'));
    await expect(resolveCodexDisplayCatalog(runtimeCatalog, { getCatalog }, true)).resolves.toBe(
      runtimeCatalog
    );
  });

  it('does not read the user configuration in passive mode', async () => {
    const getCatalog = vi.fn();
    await expect(resolveCodexDisplayCatalog(runtimeCatalog, { getCatalog }, false)).resolves.toBe(
      runtimeCatalog
    );
    expect(getCatalog).not.toHaveBeenCalled();
  });
});
