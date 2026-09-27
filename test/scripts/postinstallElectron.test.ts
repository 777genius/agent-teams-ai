// @vitest-environment node
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const requireScript = createRequire(import.meta.url);
const { postinstallElectron } = requireScript(
  path.join(process.cwd(), 'scripts/postinstall-electron.cjs')
) as {
  postinstallElectron(input: {
    prepare: () => void;
    rebuild: () => Promise<void>;
    ensure: (input: { strict: boolean }) => void;
    logger: { warn: (message: string) => void };
  }): Promise<void>;
};

describe('Electron postinstall', () => {
  it('still provisions the Electron binary when native rebuild fails', async () => {
    const prepare = vi.fn();
    const ensure = vi.fn();
    const logger = { warn: vi.fn() };

    await postinstallElectron({
      prepare,
      rebuild: async () => {
        throw new Error('native ABI build failed');
      },
      ensure,
      logger,
    });

    expect(prepare).toHaveBeenCalledOnce();
    expect(ensure).toHaveBeenCalledWith({ strict: true });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('native ABI build failed'));
  });
});
