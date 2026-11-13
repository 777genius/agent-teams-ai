import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import {
  COMMAND_ARGS,
  PROJECT_COMMAND_BODY,
  USER_COMMAND_BODY,
} from '../../packages/legacy-agent-host/tests/fixtures/native-claude-compaction/model.ts';
import { prepareDesktopBackendFixture, digest, fileDigest } from './desktop-backend-fixture.ts';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import type {
  NativeCommandUiPhase,
  NativeCommandUiScenario,
} from '../../packages/legacy-agent-host/tests/fixtures/native-claude-commands/model.ts';

export const nativeCommandUiState = (root: string) => join(root, 'native-commands-ui-state.json');

/** A private pre-start overlay, following the existing Skills fixture's profile/descriptor pin update. */
export async function prepareDesktopNativeCommandsFixture(
  repo: string,
  pnpmEntry: string,
  modelUrl: string
) {
  const fixture = await prepareDesktopBackendFixture(repo, {
    pnpmEntry,
    seedUiTask: true,
    launchDialog: true,
    nativeClaude: {
      path: process.env.LEGACY_DESKTOP_CLAUDE_PATH!,
      sha256: 'ea3ea3c08d2a9634a4651e687fcf900d410c489bce2b00f22bd7352b91ba704f',
      modelUrl,
    },
  });
  const profile = JSON.parse(await readFile(fixture.profilePath, 'utf8')) as TeamHostProfile;
  assert.equal(profile.runtime?.members.length, 1);
  const member = profile.runtime!.members[0]!;
  assert.equal(member.provider, 'claude');
  if (member.provider !== 'claude')
    throw new Error('TEST commands require the captured Claude lead');
  assert.equal(profile.teams[0]!.members[0]!.role, 'lead');
  member.nativeOptions = { ...member.nativeOptions, settingSources: ['user', 'project'] };
  for (const management of profile.management ?? []) {
    assert.equal(management.provider, 'claude');
    if (management.provider === 'claude') management.settingSources = ['user', 'project'];
  }
  assert.equal(member.environment.CLAUDE_CONFIG_DIR, join(fixture.root, 'native-claude/config'));
  const sources: { path: string; sha256: string }[] = [];
  const files: [string, string][] = [
    [
      join(member.cwd, '.claude/commands/test-project-command.md'),
      `---\ndescription: TEST captured project command\n---\n${PROJECT_COMMAND_BODY}\nArguments: $ARGUMENTS\nUse the captured Team message_send tool for the requested TEST reply.\n`,
    ],
    [
      join(member.environment.CLAUDE_CONFIG_DIR!, 'skills/test-user-command/SKILL.md'),
      `---\nname: test-user-command\ndescription: TEST captured user command\nuser-invocable: true\n---\n${USER_COMMAND_BODY}\nArguments: $ARGUMENTS\n`,
    ],
    [
      join(member.cwd, '.claude/skills/test-hidden-command/SKILL.md'),
      '---\nname: test-hidden-command\ndescription: TEST model-only command\nuser-invocable: false\n---\nTEST_HIDDEN_SKILL_MUST_NOT_BE_USER_INVOKED\n',
    ],
  ];
  for (const [path, content] of files) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600, flag: 'wx' });
    sources.push({ path, sha256: await fileDigest(path) });
  }
  const bytes = JSON.stringify(profile);
  await writeFile(fixture.profilePath, bytes, { mode: 0o600 });
  readTeamHostProfile(fixture.profilePath, digest(bytes));
  const descriptor = JSON.parse(await readFile(fixture.descriptorPath, 'utf8')) as {
    owners: { profile: { env: Record<string, string> } }[];
  };
  assert.equal(descriptor.owners.length, 1);
  descriptor.owners[0]!.profile.env.LEGACY_AGENT_HOST_PROFILE_SHA256 = digest(bytes);
  const descriptorBytes = JSON.stringify(descriptor);
  await writeFile(fixture.descriptorPath, descriptorBytes, { mode: 0o600 });
  fixture.pins.profileSha256 = digest(bytes);
  fixture.pins.descriptorSha256 = digest(descriptorBytes);
  fixture.appEnvironment.AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256 = digest(descriptorBytes);
  await writeFile(nativeCommandUiState(fixture.root), JSON.stringify({ phase: 'idle' }), {
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(
    join(fixture.root, 'native-commands-ui-sources.json'),
    JSON.stringify({ sources, args: COMMAND_ARGS }),
    { mode: 0o600, flag: 'wx' }
  );
  return fixture;
}

/** Explicit TEST phase selects only the finite response oracle; it never dispatches product actions. */
export function desktopNativeCommandScenario(root: () => string): NativeCommandUiScenario {
  return {
    phase() {
      const row = JSON.parse(readFileSync(nativeCommandUiState(root()), 'utf8')) as {
        phase: NativeCommandUiPhase;
      };
      assert.ok(['idle', 'compact', 'project-command', 'review'].includes(row.phase));
      return row.phase;
    },
  };
}
