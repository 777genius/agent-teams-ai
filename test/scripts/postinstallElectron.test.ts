// @vitest-environment node
import { createRequire } from 'node:module';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireScript = createRequire(import.meta.url);
const { postinstallElectron } = requireScript(
  path.join(process.cwd(), 'scripts/postinstall-electron.cjs')
) as {
  postinstallElectron(input: {
    profile?: string;
    prepare: () => void;
    rebuild: (modules: string[]) => Promise<void>;
    ensure: (input: { strict: boolean }) => void;
    logger: { warn: (message: string) => void };
  }): Promise<void>;
};

describe('Electron postinstall', () => {
  beforeEach(() => {
    vi.stubEnv('AGENT_TEAMS_INSTALL_PROFILE', undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it('does not provision Electron or rebuild its ABI in the Node CI profile', async () => {
    const effects: string[] = [];
    await postinstallElectron({
      profile: 'node-ci',
      prepare: () => {
        effects.push('prepare');
      },
      rebuild: async () => {
        effects.push('rebuild');
      },
      ensure: () => {
        effects.push('ensure');
      },
      logger: { warn: vi.fn() },
    });
    expect(effects).toEqual([]);
  });

  it('rejects an unknown profile before install side effects', async () => {
    const effects: string[] = [];
    await expect(
      postinstallElectron({
        profile: 'unknown',
        prepare: () => {
          effects.push('prepare');
        },
        rebuild: async () => {
          effects.push('rebuild');
        },
        ensure: () => {
          effects.push('ensure');
        },
        logger: { warn: vi.fn() },
      })
    ).rejects.toThrow('Unknown install profile');
    expect(effects).toEqual([]);
  });

  it('selects the Node CI profile through the install environment', async () => {
    vi.stubEnv('AGENT_TEAMS_INSTALL_PROFILE', 'node-ci');
    const effects: string[] = [];
    await postinstallElectron({
      prepare: () => {
        effects.push('prepare');
      },
      rebuild: async () => {
        effects.push('rebuild');
      },
      ensure: () => {
        effects.push('ensure');
      },
      logger: { warn: vi.fn() },
    });
    expect(effects).toEqual([]);
  });

  it('rebuilds every required module before strict provisioning when preparation succeeds', async () => {
    const effects: unknown[] = [];

    await postinstallElectron({
      prepare: () => {
        effects.push('prepare');
      },
      rebuild: async (modules) => {
        effects.push(modules);
      },
      ensure: (input) => {
        effects.push(input);
      },
      logger: { warn: vi.fn() },
    });

    expect(effects).toEqual([
      'prepare',
      ['node-pty', 'ssh2', 'cpu-features', 'better-sqlite3'],
      { strict: true },
    ]);
  });

  it('still rebuilds required modules when optional cpu-features preparation fails', async () => {
    const effects: unknown[] = [];
    const logger = { warn: vi.fn() };

    await postinstallElectron({
      prepare: () => {
        throw new Error('Unable to detect compiler type');
      },
      rebuild: async (modules) => {
        effects.push(modules);
      },
      ensure: (input) => {
        effects.push(input);
      },
      logger,
    });

    expect(effects).toEqual([['node-pty', 'ssh2', 'better-sqlite3'], { strict: true }]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Unable to detect compiler type')
    );
  });

  it('rejects a strict Electron provisioning failure after optional preparation fails', async () => {
    const ensureFailure = new Error('Electron executable is missing');

    await expect(
      postinstallElectron({
        prepare: () => {
          throw new Error('compiler missing');
        },
        rebuild: async () => {},
        ensure: (input) => {
          expect(input).toEqual({ strict: true });
          throw ensureFailure;
        },
        logger: { warn: vi.fn() },
      })
    ).rejects.toBe(ensureFailure);
  });

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
