import { describe, expect, it, vi } from 'vitest';

import { refreshCliStatusForCurrentMode } from '@renderer/utils/refreshCliStatus';

describe('refreshCliStatusForCurrentMode', () => {
  it('uses provider-first bootstrap when multimodel is enabled', async () => {
    const bootstrapCliStatus = vi.fn().mockResolvedValue(undefined);
    const fetchCliStatus = vi.fn().mockResolvedValue(undefined);

    await refreshCliStatusForCurrentMode({
      multimodelEnabled: true,
      bootstrapCliStatus,
      fetchCliStatus,
    });

    expect(bootstrapCliStatus).toHaveBeenCalledWith({ multimodelEnabled: true });
    expect(fetchCliStatus).not.toHaveBeenCalled();
  });

  it('falls back to legacy status fetch when multimodel is disabled', async () => {
    const bootstrapCliStatus = vi.fn().mockResolvedValue(undefined);
    const fetchCliStatus = vi.fn().mockResolvedValue(undefined);

    await refreshCliStatusForCurrentMode({
      multimodelEnabled: false,
      bootstrapCliStatus,
      fetchCliStatus,
    });

    expect(fetchCliStatus).toHaveBeenCalledTimes(1);
    expect(bootstrapCliStatus).not.toHaveBeenCalled();
  });
});
