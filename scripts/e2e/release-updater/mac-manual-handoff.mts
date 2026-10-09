import assert from 'node:assert/strict';

export type ManualOriginalLaunch = (
  label: string,
  profile: string,
  version: string,
  seed?: true,
  expectedTheme?: string
) => Promise<string>;

// The seed launch must stop before this check, then the same signed 211/profile
// loads its durable preference naturally and supplies the accepted UI proof.
export async function proveOriginalManualHandoff(
  launch: ManualOriginalLaunch,
  profile: string,
  noAppProcesses: () => Promise<void>
) {
  const theme = await launch('original211-seed', profile, '2.17.1', true);
  await noAppProcesses();
  assert.equal(await launch('original211', profile, '2.17.1', undefined, theme), theme);
  return theme;
}
