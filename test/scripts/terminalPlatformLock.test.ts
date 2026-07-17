import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// The terminal-platform runtime archives ship a native terminal-daemon that is
// executed on user machines, so their integrity must be anchored by a committed
// sha256 pin in terminal-platform.lock.json (the download path prefers this pin
// over the network manifest). This guards the pin from silently going missing -
// the same invariant scripts/ci/verify-runtime-lock.mjs enforces for the agent
// runtime.
describe('terminal-platform.lock.json', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const lock = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'terminal-platform.lock.json'), 'utf8')
  ) as {
    version: string;
    assets: Record<string, { file?: string; sha256?: string }>;
  };

  const platforms = Object.entries(lock.assets ?? {});

  it('pins the expected platform assets', () => {
    expect(platforms.map(([key]) => key).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
      'win32-x64',
    ]);
  });

  it.each(platforms)('pins a committed 64-hex sha256 for %s', (_platform, asset) => {
    const sha256 = typeof asset.sha256 === 'string' ? asset.sha256.trim().toLowerCase() : '';
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(platforms)('names the %s asset with the locked version', (_platform, asset) => {
    expect(asset.file).toContain(`-v${lock.version}.`);
  });
});
