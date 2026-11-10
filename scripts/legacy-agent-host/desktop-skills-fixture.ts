import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { FileManagementCommandStore } from '../../packages/legacy-agent-host/dist/adapters/providers/FileManagementCommandStore.js';
import { acquireProfileWriterLease } from '../../packages/legacy-agent-host/dist/adapters/profile/ProfileWriterLease.js';
import { CodexManagementCoordinator } from '../../packages/legacy-agent-host/dist/composition/CodexManagementCoordinator.js';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { ManagementResourceFence } from '../../packages/legacy-agent-host/dist/management/ManagementResourceFence.js';
import { SkillCoordinator } from '../../packages/legacy-agent-host/dist/skills/SkillCoordinator.js';
import { desktopNodeScriptHeader, digest, fileDigest } from './desktop-backend-fixture.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type {
  ClaudeManagementProfile,
  CodexManagementProfile,
} from '../../packages/legacy-agent-host/dist/management/profile.js';

type Fixture = Awaited<ReturnType<typeof prepareDesktopBackendFixture>>;
/** Automatic UI status reads may reach only these pinned refusal-only TEST executables. */
export function isSkillsMetadataRefusal(row: Record<string, unknown>): boolean {
  if (row.allowed !== false || row.skillsMetadataRefusal !== true || !Array.isArray(row.flags))
    return false;
  const flags = row.flags;
  if (row.executable === 'skills-claude-management' && row.operation === 'sdk.metadata')
    return (
      row.argc === 12 &&
      JSON.stringify(flags) ===
        JSON.stringify([
          '--output-format',
          '--verbose',
          '--input-format',
          '--tools',
          '--setting-sources',
          '--strict-mcp-config',
          '--permission-mode',
          '--no-session-persistence',
          '--settings',
        ])
    );
  return (
    row.argc === 3 &&
    flags.length === 1 &&
    ((row.executable === 'skills-claude-management' &&
      row.operation === 'auth.status' &&
      flags[0] === '--json') ||
      (row.executable === 'skills-codex-management' &&
        row.operation === 'app-server.read' &&
        flags[0] === '--listen'))
  );
}

export const skillsUiMarkdown = (version: number) =>
  `---\nname: test-ui-imported-v${version}\ndescription: TEST imported exact snapshot ${version}\n---\n\nTEST body version ${version}.\n`;

/** Only private TEST data; no app, native runtime, picker or OS Trash starts during preparation. */
export async function prepareDesktopSkillsFixture(fixture: Fixture): Promise<Fixture> {
  const { root } = fixture;
  assert.match(root, /\/TEST-desktop-backend-[^/]+$/);
  const profile = JSON.parse(await readFile(fixture.profilePath, 'utf8'));
  const descriptor = JSON.parse(await readFile(fixture.descriptorPath, 'utf8'));
  assert.equal(profile.runtime, undefined);
  const source = join(root, 'skill-source');
  const target = join(root, 'claude/skills/test-ui-installed');
  const held = join(root, 'config/codex/skills/test-ui-held');
  for (const directory of [
    source,
    join(source, 'assets'),
    join(source, 'references'),
    target,
    join(target, 'empty-sidecar'),
    join(target, 'scripts'),
    held,
    join(root, 'home/.agents/skills'),
    join(root, 'home/.cursor/skills'),
  ])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(source, 'SKILL.md'), skillsUiMarkdown(1), { mode: 0o600, flag: 'wx' });
  await writeFile(join(source, 'assets/picture.bin'), Buffer.from([0, 1, 254, 255, 2]), {
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(join(source, 'references/guide.md'), 'TEST immutable reference\n', {
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(join(source, '.hidden'), 'TEST must not import\n', { mode: 0o600, flag: 'wx' });
  await writeFile(
    join(target, 'SKILL.md'),
    '---\nname: test-ui-original\ndescription: TEST original\n---\nTEST original bytes\n',
    { mode: 0o600, flag: 'wx' }
  );
  await writeFile(join(target, 'scripts/obsolete.sh'), 'TEST obsolete managed file\n', {
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(join(target, 'keep.txt'), 'TEST unmanaged bytes\n', { mode: 0o600, flag: 'wx' });
  await writeFile(
    join(held, 'SKILL.md'),
    '---\nname: test-ui-held\ndescription: TEST original held intent\n---\nTEST held bytes remain\n',
    { mode: 0o600, flag: 'wx' }
  );
  const claudeMetadataArgs = [
    '--output-format',
    'stream-json',
    '--verbose',
    '--input-format',
    'stream-json',
    '--tools=',
    '--setting-sources=',
    '--strict-mcp-config',
    '--permission-mode=dontAsk',
    '--no-session-persistence',
    '--settings',
    '{"disableAllHooks":true}',
  ];
  for (const [name, refusals] of [
    [
      'skills-claude-management',
      [
        { args: ['auth', 'status', '--json'], operation: 'auth.status' },
        { args: claudeMetadataArgs, operation: 'sdk.metadata' },
      ],
    ],
    [
      'skills-codex-management',
      [{ args: ['app-server', '--listen', 'stdio://'], operation: 'app-server.read' }],
    ],
  ] as const) {
    const script = `${desktopNodeScriptHeader(fixture.node)}import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2),matched=${JSON.stringify(refusals)}.find(row=>JSON.stringify(args)===JSON.stringify(row.args));
appendFileSync(${JSON.stringify(fixture.sentinelLog)},JSON.stringify({executable:${JSON.stringify(name)},allowed:false,skillsMetadataRefusal:Boolean(matched),operation:matched?.operation??null,argc:args.length,flags:args.filter(x=>x.startsWith('-')).map(x=>x.split('=')[0])})+${JSON.stringify('\n')},{mode:0o600});
process.stderr.write(${JSON.stringify('TEST refuses metadata process; Skills filesystem ownership remains real\n')});process.exit(78);
`;
    await writeFile(join(root, 'bin', name), script, { mode: 0o700, flag: 'wx' });
  }
  const common = {
    accountBinding: 'TEST-NO-PROVIDER-ACTIONS',
    cwd: join(root, 'workspace'),
    timeoutMs: 1000,
    environment: {
      HOME: join(root, 'home'),
      TMPDIR: join(root, 'tmp'),
      PATH: dirname(fixture.node) + ':/usr/bin:/bin',
      SHELL: '/bin/sh',
    },
  };
  const claude: ClaudeManagementProfile = {
    ...common,
    provider: 'claude',
    sdkRevision: '0.3.305',
    profileId: 'TEST-skills-claude',
    configRevision: 'TEST-skills-claude-1',
    configNamespace: 'custom-directory',
    settingSources: [],
    executable: {
      path: join(root, 'bin/skills-claude-management'),
      sha256: await fileDigest(join(root, 'bin/skills-claude-management')),
    },
    environment: { ...common.environment, CLAUDE_CONFIG_DIR: join(root, 'claude') },
  };
  const codex: CodexManagementProfile = {
    ...common,
    provider: 'codex',
    protocolRevision: '0.162.0',
    profileId: 'TEST-skills-codex',
    configRevision: 'TEST-skills-codex-1',
    executable: {
      path: join(root, 'bin/skills-codex-management'),
      sha256: await fileDigest(join(root, 'bin/skills-codex-management')),
    },
    environment: { ...common.environment, CODEX_HOME: join(root, 'config/codex') },
  };
  profile.management = [claude, codex];
  profile.reviewTransport = 'review-v1';
  descriptor.owners[0].profile.reviewTransport = 'review-v1';
  descriptor.management = [claude, codex].map((entry) => ({
    runtimeId: entry.provider,
    contextId: 'local',
    projectPath: null,
    owner: descriptor.defaultOwner,
    profileId: entry.profileId,
    configRevision: entry.configRevision,
  }));
  const lease = acquireProfileWriterLease(profile.owner.storageRoot);
  try {
    const store = new FileManagementCommandStore(profile.owner.storageRoot);
    const native = new CodexManagementCoordinator([codex], () => lease.assertCurrent());
    const skills = new SkillCoordinator([codex], {
      store,
      fence: new ManagementResourceFence(store.list()),
      assertCurrent: () => lease.assertCurrent(),
      managementTarget: (id, revision) => native.target(id, revision),
      beforeEffect: async () => {
        throw new Error(
          'TEST stages original UNKNOWN admission before any filesystem/native effect'
        );
      },
    });
    const target = skills.capture({
      profileId: codex.profileId,
      configRevision: codex.configRevision,
      scope: 'user',
      rootKind: 'codex',
    });
    const selection = {
      profileId: target.profileId,
      configRevision: target.configRevision,
      targetId: target.targetId,
      scope: target.scope,
      rootKind: target.rootKind,
    };
    const item = skills.read(selection).items.find((item) => item.folderName === 'test-ui-held');
    assert.ok(item);
    const command = {
      action: 'trash' as const,
      folderName: item.folderName,
      expectedIdentity: item.identity,
    };
    const preview = skills.preview({ ...selection, command });
    const result = await skills.mutate({
      ...selection,
      commandId: 'TEST-original-unknown-skill-trash',
      command,
      reviewPlanId: preview.planId,
    });
    assert.equal(result.receipt.phase, 'held');
    assert.equal(result.nativeTrash, undefined);
    assert.equal([...store.list()].length, 1);
    await native.close();
  } finally {
    lease.release();
  }
  const profileBytes = JSON.stringify(profile);
  await writeFile(fixture.profilePath, profileBytes, { mode: 0o600 });
  readTeamHostProfile(fixture.profilePath, digest(profileBytes));
  descriptor.owners[0].profile.env.LEGACY_AGENT_HOST_PROFILE_SHA256 = digest(profileBytes);
  const descriptorBytes = JSON.stringify(descriptor);
  await writeFile(fixture.descriptorPath, descriptorBytes, { mode: 0o600 });
  fixture.pins.profileSha256 = digest(profileBytes);
  fixture.pins.descriptorSha256 = digest(descriptorBytes);
  fixture.appEnvironment.AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256 = digest(descriptorBytes);
  await writeFile(
    join(root, 'skills-ui-fixture.json'),
    JSON.stringify(
      {
        source,
        target,
        held,
        unknownCommandId: 'TEST-original-unknown-skill-trash',
        noNativeEffectForUnknown: true,
      },
      null,
      2
    ),
    { mode: 0o600, flag: 'wx' }
  );
  return fixture;
}
