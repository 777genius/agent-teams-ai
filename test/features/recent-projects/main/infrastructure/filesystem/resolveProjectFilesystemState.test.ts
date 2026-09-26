// @vitest-environment node
import { resolveProjectFilesystemState } from '@features/recent-projects/main/infrastructure/filesystem/resolveProjectFilesystemState';
import { describe, expect, it, vi } from 'vitest';

describe('resolveProjectFilesystemState', () => {
  it('marks only definitive absence as deleted', async () => {
    const missing = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const permission = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const sftpMissing = Object.assign(new Error('SFTP 2'), { code: 2 });

    expect(
      await resolveProjectFilesystemState('/gone', {
        exists: vi.fn(),
        stat: vi.fn().mockRejectedValue(missing),
      })
    ).toBe('deleted');
    expect(
      await resolveProjectFilesystemState('/locked', {
        exists: vi.fn().mockResolvedValue(false),
        stat: vi.fn().mockRejectedValue(permission),
      })
    ).toBe('available');
    expect(
      await resolveProjectFilesystemState('/remote-gone', {
        exists: vi.fn(),
        stat: vi.fn().mockRejectedValue(sftpMissing),
      })
    ).toBe('deleted');
  });
});
