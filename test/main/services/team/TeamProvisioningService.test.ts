import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: { resolve: vi.fn() },
}));

vi.mock('@main/utils/childProcess', () => ({
  spawnCli: vi.fn(),
}));

import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { spawnCli } from '@main/utils/childProcess';

function allowConsoleLogs() {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

describe('TeamProvisioningService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('warmup', () => {
    it('does not throw when spawnCli rejects', async () => {
      allowConsoleLogs();
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('C:\\path\\claude');
      vi.mocked(spawnCli).mockImplementation(() => {
        throw new Error('spawn EINVAL');
      });

      const svc = new TeamProvisioningService();
      await expect(svc.warmup()).resolves.not.toThrow();
      expect(spawnCli).toHaveBeenCalled();
    });
  });
});
