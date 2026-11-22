import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigManager } from '../../../../src/main/services/infrastructure/ConfigManager';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

describe('ConfigManager persistence barrier', () => {
  let dir: string | null = null;

  afterEach(() => {
    setClaudeBasePathOverride(null);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('enables renderer access by default while preserving an explicit opt-out', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-cdp-default-'));
    const file = path.join(dir, 'settings.json');
    expect(new ConfigManager(file).getConfig().general.externalAgentCdpEnabled).toBe(true);
    fs.writeFileSync(file, JSON.stringify({ general: { theme: 'dark' } }));
    const missingSetting = new ConfigManager(file);
    expect(missingSetting.getConfig().general.externalAgentCdpEnabled).toBe(true);
    await missingSetting.waitForPersistence();
    fs.writeFileSync(file, JSON.stringify({ general: { externalAgentCdpEnabled: false } }));
    const disabled = new ConfigManager(file);
    expect(disabled.getConfig().general.externalAgentCdpEnabled).toBe(false);
    await disabled.waitForPersistence();
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
    // Both diagnostics are expected in this intentionally broken filesystem fixture.
    const errors = vi.mocked(console.error).mock.calls.map((call) => call.map(String).join(' '));
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('Error loading config');
    expect(errors[1]).toContain('Error persisting config');
    vi.mocked(console.error).mockClear();
  });
});
