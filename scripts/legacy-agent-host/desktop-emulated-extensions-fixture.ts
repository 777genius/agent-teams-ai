import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captureNativeClaudeFile } from '../../packages/legacy-agent-host/dist/extensions/captureNativeClaudeFile.js';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { fileDigest } from './desktop-backend-fixture.ts';
import { prepareDesktopEmulatedClaudeSettingsFixture } from './desktop-emulated-claude-settings-fixture.ts';
import { extensionPlugin } from './desktop-native-extensions-fixture.ts';
import type { NativeExtensionProofSelection } from './desktop-native-extensions-fixture.ts';

/** Original Settings mutation path, with a captured finite CLI and its real private config effects. */
export async function prepareDesktopEmulatedExtensionsFixture(repo: string, pnpmEntry: string) {
  const fixture = await prepareDesktopEmulatedClaudeSettingsFixture(repo, pnpmEntry, 'extensions');
  const selected = readTeamHostProfile(fixture.profilePath, fixture.pins.profileSha256).management![0]!;
  assert.equal(selected.provider, 'claude');
  if (selected.provider !== 'claude') throw new Error('Original Claude management profile required');
  const neighbor = join(fixture.root, 'TEST-extension-neighbor');
  await mkdir(neighbor, { mode: 0o700 });
  const neighborPath = join(neighbor, '.claude.json');
  await writeFile(neighborPath, JSON.stringify({ TEST_neighbor_must_remain_unchanged: true }), { mode: 0o600, flag: 'wx' });
  const selection: NativeExtensionProofSelection = {
    profile: selected, setup: [], plugin: extensionPlugin,
    nativeConfig: captureNativeClaudeFile(selected, () => {}).path,
    neighborPath, neighborSha256: await fileDigest(neighborPath), execution: 'finite-protocol-peer',
  };
  await writeFile(join(fixture.root, 'native-extensions-selection.json'), JSON.stringify(selection), { mode: 0o600, flag: 'wx' });
  return fixture;
}
