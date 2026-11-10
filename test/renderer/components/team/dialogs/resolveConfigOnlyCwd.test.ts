import { resolveConfigOnlyCwd } from '@renderer/components/team/dialogs/resolveConfigOnlyCwd';
import { describe, expect, it, vi } from 'vitest';

describe('resolveConfigOnlyCwd', () => {
  it('preserves the selected project path without probing it', async () => {
    const getState = vi.fn();

    await expect(
      resolveConfigOnlyCwd({
        cwdMode: 'project',
        cwd: ' /test/project ',
        projectFolder: { getState },
      })
    ).resolves.toBe('/test/project');
    expect(getState).not.toHaveBeenCalled();
  });

  it.each(['exists', 'missing', 'unknown'] as const)(
    'preserves a custom path when a fresh check reports %s',
    async (state) => {
      const getState = vi.fn().mockResolvedValue({ state });

      await expect(
        resolveConfigOnlyCwd({
          cwdMode: 'custom',
          cwd: '/test/custom',
          projectFolder: { getState },
        })
      ).resolves.toBe('/test/custom');
      expect(getState).toHaveBeenCalledWith({ path: '/test/custom' });
    }
  );

  it.each(['invalid', 'not_directory'] as const)(
    'omits a custom path when a fresh check reports %s',
    async (state) => {
      await expect(
        resolveConfigOnlyCwd({
          cwdMode: 'custom',
          cwd: state === 'invalid' ? 'relative/path' : '/test/file',
          projectFolder: { getState: vi.fn().mockResolvedValue({ state }) },
        })
      ).resolves.toBeUndefined();
    }
  );

  it('omits a custom path when the folder state cannot be read', async () => {
    await expect(
      resolveConfigOnlyCwd({
        cwdMode: 'custom',
        cwd: '/test/custom',
        projectFolder: { getState: vi.fn().mockRejectedValue(new Error('IPC unavailable')) },
      })
    ).resolves.toBeUndefined();
  });
});
