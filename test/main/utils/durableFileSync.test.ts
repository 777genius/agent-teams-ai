// @vitest-environment node
import {
  syncDirectory,
  syncDirectoryBestEffort,
  syncDirectoryDurably,
} from '@main/utils/durableFileSync';
import { beforeEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ open: vi.fn(), sync: vi.fn(), close: vi.fn() }));
vi.mock('fs', () => ({ promises: { open: io.open } }));
beforeEach(() => {
  io.sync.mockReset().mockResolvedValue(undefined);
  io.close.mockReset().mockResolvedValue(undefined);
  io.open.mockReset().mockResolvedValue({ sync: io.sync, close: io.close });
});
const failure = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

it.each(['EIO', 'ENOSPC'])(
  'strict directory sync rejects an unexpected %s close after unsupported sync',
  async (code) => {
    io.sync.mockRejectedValue(failure('EINVAL'));
    const closeError = failure(code);
    io.close.mockRejectedValue(closeError);
    await expect(syncDirectoryDurably('/TEST-directory')).rejects.toBe(closeError);
    expect(io.open).toHaveBeenCalledExactlyOnceWith('/TEST-directory', 'r');
    expect(io.close).toHaveBeenCalledOnce();
  }
);

it('keeps the first unexpected sync error when close is unsupported', async () => {
  const syncError = failure('EIO');
  io.sync.mockRejectedValue(syncError);
  io.close.mockRejectedValue(failure('EINVAL'));
  await expect(syncDirectory('/TEST-directory', true)).rejects.toBe(syncError);
  expect(io.close).toHaveBeenCalledOnce();
});

it.each(['sync', 'close'] as const)(
  'allows an unsupported %s error without an unexpected storage error',
  async (phase) => {
    io[phase].mockRejectedValue(failure('EINVAL'));
    await expect(syncDirectoryDurably('/TEST-directory')).resolves.toBeUndefined();
    expect(io.close).toHaveBeenCalledOnce();
  }
);

it('propagates an unexpected close error after a successful sync', async () => {
  const closeError = failure('EIO');
  io.close.mockRejectedValue(closeError);
  await expect(syncDirectory('/TEST-directory', true)).rejects.toBe(closeError);
});

it('keeps both non-strict entrypoints best-effort after unsupported sync and unexpected close', async () => {
  io.sync.mockRejectedValue(failure('EINVAL'));
  io.close.mockRejectedValue(failure('ENOSPC'));
  await expect(syncDirectory('/TEST-directory', false)).resolves.toBeUndefined();
  await expect(syncDirectoryBestEffort('/TEST-directory')).resolves.toBeUndefined();
});
