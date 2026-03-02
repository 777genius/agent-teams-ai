import { EventEmitter } from 'events';

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

function createFakeChild(exitCode: number): NodeJS.Process {
  const child = new EventEmitter() as NodeJS.Process & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => child.emit('close', exitCode));
  return child;
}

describe('TeamProvisioningService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('warmup', () => {
    it('does not throw when spawnCli rejects', async () => {
      allowConsoleLogs();
      vi.mocked(ClaudeBinaryResolver.resolve).mockResolvedValue('C:\\path\\claude');
      let callCount = 0;
      vi.mocked(spawnCli).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error('spawn EINVAL');
        }
        return createFakeChild(0) as ReturnType<typeof spawnCli>;
      });

      const svc = new TeamProvisioningService();
      await expect(svc.warmup()).resolves.not.toThrow();
      expect(spawnCli).toHaveBeenCalled();
    });
  });
});
