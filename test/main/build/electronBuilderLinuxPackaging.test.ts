// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../..');

describe('electron-builder Linux packaging', () => {
  it('installs a package-owned CLI launcher into PATH for fpm Linux packages', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const launcherPath = path.join(repoRoot, 'resources/linux/bin/agent-teams-ai');
    const launcher = fs.readFileSync(launcherPath, 'utf8');
    const launcherMode = fs.statSync(launcherPath).mode;

    for (const target of ['deb', 'rpm', 'pacman'] as const) {
      expect(packageJson.build[target].afterInstall).toBe('resources/afterInstall.sh');
      expect(packageJson.build[target].fpm).toContain(
        'resources/linux/bin/agent-teams-ai=/usr/bin/agent-teams-ai'
      );
    }
    expect(launcher).toContain('#!/bin/sh');
    expect(launcher).toContain('/opt/Agent-Teams-AI/agent-teams-ai');
    expect(launcher).not.toContain('--no-sandbox');
    if (process.platform !== 'win32') {
      expect(launcherMode & 0o111).not.toBe(0);
    }
  });

  it('fixes chrome-sandbox permissions at the actual fpm install directory', () => {
    const afterInstall = fs.readFileSync(path.join(repoRoot, 'resources/afterInstall.sh'), 'utf8');

    expect(afterInstall).toContain('/opt/${sanitizedProductName}/chrome-sandbox');
    expect(afterInstall).not.toContain('/opt/${productFilename}/chrome-sandbox');
  });
});
