import { readOpenCodeEffectiveRuntimeStatus } from '@main/services/runtime/openCodeEffectiveRuntimeVersion';
import { describe, expect, it, vi } from 'vitest';

describe('readOpenCodeEffectiveRuntimeStatus', () => {
  it('uses the selected managed runtime without an explicit override', async () => {
    const readDefaultStatus = vi.fn(async () => ({ installed: true, version: '1.18.32' }));
    const probe = vi.fn();
    await expect(readOpenCodeEffectiveRuntimeStatus({}, readDefaultStatus, probe)).resolves.toEqual(
      {
        installed: true,
        version: '1.18.32',
      }
    );
    expect(probe).not.toHaveBeenCalled();
  });

  it('checks the exact override binary instead of an outdated managed runtime', async () => {
    const readDefaultStatus = vi.fn(async () => ({ installed: true, version: '1.17.18' }));
    const probe = vi.fn(async () => ({ ok: true, version: '1.18.32' }));
    await expect(
      readOpenCodeEffectiveRuntimeStatus(
        { OPENCODE_BIN_PATH: '/custom/opencode' },
        readDefaultStatus,
        probe
      )
    ).resolves.toEqual({ installed: true, version: '1.18.32' });
    expect(readDefaultStatus).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledWith('/custom/opencode');
  });

  it('checks the wrapper target when Windows wraps an explicit override', async () => {
    const probe = vi.fn(async () => ({ ok: true, version: '1.17.18' }));
    await expect(
      readOpenCodeEffectiveRuntimeStatus(
        {
          CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: '/wrapper/opencode.exe',
          OPENCODE_CONSOLE_WRAPPER_TARGET: '/custom/opencode.exe',
        },
        vi.fn(),
        probe
      )
    ).resolves.toEqual({ installed: true, version: '1.17.18' });
    expect(probe).toHaveBeenCalledWith('/custom/opencode.exe');
  });
});
