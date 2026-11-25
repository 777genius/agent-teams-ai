import assert from 'node:assert/strict';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { prepareDesktopStoppedImport } from './desktop-stopped-import-fixture.ts';
import { prepareDesktopEmulatedClaudeSettingsFixture, publishDesktopEmulatedClaudeSettingsProfile } from './desktop-emulated-claude-settings-fixture.ts';

/** A truthful legacy-format TEST archive; the original Main/Host import creates all target records. */
export async function prepareDesktopEmulatedImportFixture(repo: string, pnpmEntry: string) {
  const fixture = await prepareDesktopEmulatedClaudeSettingsFixture(repo, pnpmEntry, 'saved-import');
  await prepareDesktopStoppedImport(fixture.root);
  const profile = readTeamHostProfile(fixture.profilePath, fixture.pins.profileSha256);
  await publishDesktopEmulatedClaudeSettingsProfile(fixture, profile, descriptor => {
    const creation = descriptor.creation as Record<string, unknown>;
    assert.ok(creation && Array.isArray(creation.contextIds));
    creation.importAuthority = { principalId: profile.principalId };
  });
  return fixture;
}
