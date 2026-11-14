import { resolveCodexDisplayCatalog } from '@main/services/runtime/resolveCodexDisplayCatalog';
import { describe, expect, it, vi } from 'vitest';

import type { CliProviderModelCatalog } from '@shared/types';

const runtimeCatalog = {
  providerId: 'codex',
  models: [{ id: 'model' }],
} as CliProviderModelCatalog;

describe('resolveCodexDisplayCatalog', () => {
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
