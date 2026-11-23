// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ConfigManager } from '@main/services/infrastructure/ConfigManager';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ directory: '', switches: new Map<string, string>() }));
vi.mock('electron', () => ({
  app: {
    getPath: () => electron.directory,
    commandLine: {
      hasSwitch: (name: string) => electron.switches.has(name),
      appendSwitch: (name: string, value: string) => electron.switches.set(name, value),
      getSwitchValue: (name: string) => electron.switches.get(name) ?? '',
    },
  },
  webContents: {},
}));

import { prepareNativeRendererCdp } from '@features/external-agent-connection/main/NativeRendererCdp';

let sandbox: string | undefined;
afterEach(() => {
  setClaudeBasePathOverride(null);
  electron.switches.clear();
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  sandbox = undefined;
});

describe('default renderer access on ordinary app startup', () => {
  it('opens a loopback CDP listener for an unset preference and respects a saved opt-out', async () => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'TEST-cdp-default-'));
    electron.directory = sandbox;
    const file = path.join(sandbox, 'settings.json');
    const fresh = new ConfigManager(file);
    prepareNativeRendererCdp(fresh.getConfig().general.externalAgentCdpEnabled === true);
    expect(electron.switches.get('remote-debugging-address')).toBe('127.0.0.1');
    expect(electron.switches.get('remote-debugging-port')).toBe('0');

    electron.switches.clear();
    writeFileSync(
      file,
      JSON.stringify({
        general: { externalAgentCdpEnabled: false, externalAgentCdpSettingsVersion: 1 },
      })
    );
    const optedOut = new ConfigManager(file);
    await optedOut.waitForPersistence();
    prepareNativeRendererCdp(optedOut.getConfig().general.externalAgentCdpEnabled === true);
    expect(electron.switches.has('remote-debugging-port')).toBe(false);
  });
});
