import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { bounded } from './desktop-proof-bounds.ts';
import type { UiCdpPort } from './desktop-ui-controls.ts';
/** Original Codex account diagnostic mode; keeps the captured renderer and exact operation sequence. */
export async function runDesktopCodexAccountProof(
  cdp: UiCdpPort,
  options: {
    mode: string;
    fixture: { profilePath: string; root: string };
    evidence: Record<string, unknown>;
    assertOwnedRenderer(): void;
  }
): Promise<void> {
  const { mode, fixture, evidence } = options;
  const object = (value: unknown): Record<string, unknown> => {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    return value as Record<string, unknown>;
  };
  assert.ok(['codex-account-read', 'codex-account-auth'].includes(mode));
  assert.ok(
    process.env.LEGACY_DESKTOP_CODEX_PATH,
    'metadata proof needs the pinned native TEST profile'
  );
  options.assertOwnedRenderer();
  if (mode === 'codex-account-auth') {
    const before = object(evidence.codexInitialAccount);
    assert.equal(object(before.managedAccount).type, 'api_key');
    options.assertOwnedRenderer();
    const refreshed = object(
      await bounded(
        cdp.evaluate(
          'window.electronAPI.refreshCodexAccountSnapshot({includeRateLimits:true,forceRefreshToken:true})'
        ),
        20000,
        'explicit TEST token refresh'
      )
    );
    assert.equal(object(refreshed.managedAccount).type, 'api_key');
    options.assertOwnedRenderer();
    const reused = object(
      await bounded(
        cdp.evaluate(
          'window.electronAPI.refreshCodexAccountSnapshot({includeRateLimits:true,forceRefreshToken:true})'
        ),
        20000,
        'explicit repeated TEST refresh'
      )
    );
    assert.equal(object(reused.managedAccount).type, 'api_key');
    // The captured profile below supplies the authoritative store location.
    const selectedProfile = object(JSON.parse(await readFile(fixture.profilePath, 'utf8')));
    const storeRoot = String(object(selectedProfile.owner).storageRoot);
    const commandsDirectory = join(storeRoot, 'management-commands');
    const refreshRecords = await Promise.all(
      (await readdir(commandsDirectory)).map(async (name) =>
        object(JSON.parse(await readFile(join(commandsDirectory, name), 'utf8')))
      )
    );
    assert.equal(refreshRecords.length, 2);
    assert.equal(
      refreshRecords[0]!.refreshCompletedAtMs,
      refreshRecords[1]!.refreshCompletedAtMs,
      'second explicit refresh reuses the durable namespace rotation'
    );
    evidence.codexRefreshReuse = { commandReceipts: 2, originalRotationReused: true };
    options.assertOwnedRenderer();
    const loggedOut = object(
      await bounded(
        cdp.evaluate('window.electronAPI.logoutCodexAccount()'),
        20000,
        'explicit TEST logout'
      )
    );
    assert.equal(loggedOut.managedAccount, null);
    assert.equal(
      JSON.stringify([before, refreshed, loggedOut]).includes('TEST-ONLY-NOT-A-REAL-KEY'),
      false
    );
    evidence.codexAuth = {
      status: 'PASS',
      scope:
        'Actual Electron account API, Host durable refresh/logout, Native TEST API-key file. Not ChatGPT login or real token rotation.',
      beforeType: object(before.managedAccount).type,
      refreshedType: object(refreshed.managedAccount).type,
      afterAccount: loggedOut.managedAccount,
    };
  }
  const snapshot = object(
    await bounded(
      cdp.evaluate(
        'window.electronAPI.refreshCodexAccountSnapshot({includeRateLimits:true,forceRefreshToken:false})'
      ),
      20000,
      'captured Codex account/quota read'
    )
  );
  assert.equal(snapshot.appServerState, 'healthy');
  assert.equal(snapshot.managedAccount, null);
  assert.equal(snapshot.rateLimits, null);
  assert.equal(snapshot.launchAllowed, false);
  assert.equal(typeof snapshot.requiresOpenaiAuth, 'boolean');
  assert.equal(Object.hasOwn(snapshot, 'runtimeContext'), false);
  assert.equal(JSON.stringify(snapshot).includes(fixture.root), false);
  evidence.codexAccountRead = {
    status: 'PASS',
    scope:
      'Existing read-only renderer API through preload/Main/Host/D/native Codex; no user controls or business mutations',
    snapshot,
    nativeVersion: '0.162.0',
    authenticatedQuotaData: 'Separate synthetic real-wire fixture only; no vendor credentials',
  };
}
