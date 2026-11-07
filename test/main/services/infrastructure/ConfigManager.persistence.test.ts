import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConfigManager } from '../../../../src/main/services/infrastructure/ConfigManager';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

describe('ConfigManager persistence barrier', () => {
  let dir: string | null = null;

  afterEach(() => {
    setClaudeBasePathOverride(null);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('serializes rapid updates and waits until the final snapshot is on disk', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-persistence-'));
    const file = path.join(dir, 'settings.json');
    const manager = new ConfigManager(file);
    manager.updateConfig('general', { useNativeTitleBar: true });
    manager.updateConfig('general', { theme: 'light' });
    manager.updateConfig('general', { autoExpandAIGroups: true });
    await manager.waitForPersistence();
    const disk = JSON.parse(fs.readFileSync(file, 'utf8')) as ReturnType<
      ConfigManager['getConfig']
    >;
    expect(disk.general.useNativeTitleBar).toBe(true);
    expect(disk.general.theme).toBe('light');
    expect(disk.general.autoExpandAIGroups).toBe(true);
  });

  it('propagates filesystem failures instead of claiming a successful save', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-persistence-error-'));
    const parentFile = path.join(dir, 'not-a-directory');
    fs.writeFileSync(parentFile, 'occupied');
    const manager = new ConfigManager(path.join(parentFile, 'settings.json'));
    manager.updateConfig('general', { useNativeTitleBar: true });
    await expect(manager.waitForPersistence()).rejects.toThrow();
  });
});
