import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const FEATURE_MAIN_ENTRYPOINT = 'src/features/team-provisioning/main/index.ts';
const PORTABLE_RELAUNCH_COMPOSITION =
  'src/features/team-provisioning/main/composition/createMemberSettingsRelaunchFeature.ts';

describe('member settings public boundary', () => {
  it('publishes portable relaunch composition without exposing Node construction', async () => {
    const [entrypoint, composition] = await Promise.all([
      readFile(FEATURE_MAIN_ENTRYPOINT, 'utf8'),
      readFile(PORTABLE_RELAUNCH_COMPOSITION, 'utf8'),
    ]);

    expect(entrypoint).toContain('createMemberSettingsRelaunchFeature');
    expect(entrypoint).not.toContain('persistNodeMemberSettingsRelaunch');
    expect(entrypoint).not.toContain('createNodeMemberSettingsRepositoryDependencies');
    expect(composition).not.toMatch(/(?:node:|from ['"](?:fs|path)['"]|@main\/)/);
  });
});
