// @vitest-environment node

import * as path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';

interface NodeOptionsModule {
  ensureMinimumNodeOldSpaceEnv(env: NodeJS.ProcessEnv, minMb?: number): void;
  ensureMinimumNodeOldSpaceOptions(value: string | undefined, minMb?: number): string | undefined;
}

describe('script node options helpers', () => {
  it('raises low hyphen old-space values', async () => {
    const { ensureMinimumNodeOldSpaceOptions } = await loadModule();

    expect(ensureMinimumNodeOldSpaceOptions('--max-old-space-size=64 --trace-warnings')).toBe(
      '--max-old-space-size=2048 --trace-warnings'
    );
  });

  it('raises low underscore old-space values', async () => {
    const { ensureMinimumNodeOldSpaceOptions } = await loadModule();

    expect(ensureMinimumNodeOldSpaceOptions('--trace-warnings --max_old_space_size 64')).toBe(
      '--trace-warnings --max_old_space_size 2048'
    );
  });

  it('mutates env without adding NODE_OPTIONS when unset', async () => {
    const { ensureMinimumNodeOldSpaceEnv } = await loadModule();
    const env: NodeJS.ProcessEnv = {};

    ensureMinimumNodeOldSpaceEnv(env);

    expect(env.NODE_OPTIONS).toBeUndefined();
  });
});

async function loadModule(): Promise<NodeOptionsModule> {
  const moduleUrl = pathToFileURL(path.join(process.cwd(), 'scripts/lib/node-options.mjs')).href;
  return (await import(`${moduleUrl}?t=${Date.now()}`)) as NodeOptionsModule;
}
