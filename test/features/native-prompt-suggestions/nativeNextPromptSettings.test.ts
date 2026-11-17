import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigManager } from '../../../src/main/services/infrastructure/ConfigManager';
import { validateConfigUpdatePayload } from '../../../src/main/ipc/configValidation';

let root: string | undefined;
// Loading a normalized config can itself schedule an async rewrite.
const managers: ConfigManager[] = [];
function track(file: string): ConfigManager {
  const manager = new ConfigManager(file);
  managers.push(manager);
  return manager;
}
afterEach(async () => {
  try {
    await Promise.all(managers.map(manager => manager.waitForPersistence()));
  } finally {
    managers.length = 0;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  }
});
function fixture(raw?: unknown) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'TEST-next-prompt-settings-'));
  const file = path.join(root, 'settings.json');
  if (raw !== undefined) fs.writeFileSync(file, JSON.stringify(raw));
  return { file, manager: track(file) };
}

describe('native suggestion opt-in, disabled by default', () => {
  it('never enables extra inference from missing or non-boolean persisted values', () => {
    const { manager } = fixture({ general: { nativeNextPromptSuggestionsEnabled: 'true' } });
    expect(manager.getConfig().general.nativeNextPromptSuggestionsEnabled).toBe(false);
  });

  it('persists only an explicit boolean and new session captures can read it', async () => {
    const { manager, file } = fixture();
    expect(manager.getConfig().general.nativeNextPromptSuggestionsEnabled).toBe(false);
    const enabled = manager.updateConfig('general', { nativeNextPromptSuggestionsEnabled: true });
    expect(enabled.general.nativeNextPromptSuggestionsEnabled).toBe(true);
    await manager.waitForPersistence();
    expect(track(file).getConfig().general.nativeNextPromptSuggestionsEnabled).toBe(true);
    manager.updateConfig('general', { nativeNextPromptSuggestionsEnabled: false });
    await manager.waitForPersistence();
    expect(track(file).getConfig().general.nativeNextPromptSuggestionsEnabled).toBe(false);
  });

  it('refuses forged renderer settings with type coercion', () => {
    expect(validateConfigUpdatePayload('general', { nativeNextPromptSuggestionsEnabled: true }))
      .toMatchObject({ valid: true, data: { nativeNextPromptSuggestionsEnabled: true } });
    for (const value of ['true', 1, null, {}, []]) {
      const result = validateConfigUpdatePayload('general', {
        nativeNextPromptSuggestionsEnabled: value,
      });
      expect(result.valid).toBe(false);
    }
  });
});
