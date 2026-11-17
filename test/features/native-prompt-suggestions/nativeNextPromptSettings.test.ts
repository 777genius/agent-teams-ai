import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigManager } from '../../../src/main/services/infrastructure/ConfigManager';
import { validateConfigUpdatePayload } from '../../../src/main/ipc/configValidation';
import { selectNativeNextPromptProviders } from '../../../src/features/native-prompt-suggestions/main/selectNativeNextPromptProviders';

const roots: string[] = [];
// Loading a normalized config can itself schedule an async rewrite.
const managers: ConfigManager[] = [];
function track(file: string): ConfigManager {
  const manager = new ConfigManager(file);
  managers.push(manager);
  return manager;
}
afterEach(async () => {
  try {
    await Promise.all(managers.map((manager) => manager.waitForPersistence()));
  } finally {
    managers.length = 0;
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture(raw?: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'TEST-next-prompt-settings-'));
  roots.push(root);
  const file = path.join(root, 'settings.json');
  if (raw !== undefined) fs.writeFileSync(file, JSON.stringify(raw));
  return { file, manager: track(file) };
}

const flags = (manager: ConfigManager) => {
  const { anthropic, codex } = manager.getConfig().providerConnections;
  return [anthropic.nativeNextPromptSuggestionsEnabled, codex.nativeNextPromptSuggestionsEnabled];
};

describe('native suggestions: one setting per provider, enabled by default', () => {
  it('is on for both providers when missing, keeps a saved false, never coerces a malformed value', () => {
    expect(flags(fixture().manager)).toEqual([true, true]);
    for (const malformed of ['false', 0, null, {}]) {
      const { manager } = fixture({
        providerConnections: {
          anthropic: { nativeNextPromptSuggestionsEnabled: malformed },
          codex: { nativeNextPromptSuggestionsEnabled: malformed },
        },
      });
      expect(flags(manager)).toEqual([true, true]);
    }
    const { manager } = fixture({
      providerConnections: {
        anthropic: { nativeNextPromptSuggestionsEnabled: false },
        codex: { nativeNextPromptSuggestionsEnabled: true },
      },
    });
    expect(flags(manager)).toEqual([false, true]);
  });

  it('turns one provider off without touching the other, and persists it', async () => {
    const { manager, file } = fixture();
    manager.updateConfig('providerConnections', {
      codex: { nativeNextPromptSuggestionsEnabled: false },
    } as never);
    expect(flags(manager)).toEqual([true, false]);
    await manager.waitForPersistence();
    expect(flags(track(file))).toEqual([true, false]);
    manager.updateConfig('providerConnections', {
      anthropic: { nativeNextPromptSuggestionsEnabled: false },
    } as never);
    expect(flags(manager)).toEqual([false, false]);
    manager.updateConfig('providerConnections', {
      codex: { nativeNextPromptSuggestionsEnabled: true },
    } as never);
    expect(flags(manager)).toEqual([false, true]);
  });

  it('does not reset a provider flag when an unrelated provider setting changes', () => {
    const { manager } = fixture({
      providerConnections: { anthropic: { nativeNextPromptSuggestionsEnabled: false } },
    });
    manager.updateConfig('providerConnections', { anthropic: { fastModeDefault: true } } as never);
    expect(flags(manager)).toEqual([false, true]);
  });

  it('selects the Host providers from the settings (anthropic means Claude)', () => {
    const on = { nativeNextPromptSuggestionsEnabled: true };
    const off = { nativeNextPromptSuggestionsEnabled: false };
    expect(selectNativeNextPromptProviders({ anthropic: on, codex: on })).toEqual([
      'claude',
      'codex',
    ]);
    expect(selectNativeNextPromptProviders({ anthropic: off, codex: on })).toEqual(['codex']);
    expect(selectNativeNextPromptProviders({ anthropic: off, codex: off })).toEqual([]);
    expect(selectNativeNextPromptProviders({})).toEqual([]);
  });

  it('refuses forged renderer settings with type coercion and a removed general key', () => {
    for (const provider of ['anthropic', 'codex']) {
      expect(
        validateConfigUpdatePayload('providerConnections', {
          [provider]: { nativeNextPromptSuggestionsEnabled: false },
        })
      ).toMatchObject({ valid: true });
      for (const value of ['true', 1, null, {}, []]) {
        expect(
          validateConfigUpdatePayload('providerConnections', {
            [provider]: { nativeNextPromptSuggestionsEnabled: value },
          }).valid
        ).toBe(false);
      }
    }
    expect(
      validateConfigUpdatePayload('general', { nativeNextPromptSuggestionsEnabled: true }).valid
    ).toBe(false);
  });
});
