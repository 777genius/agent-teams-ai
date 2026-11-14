import assert from 'node:assert/strict';
import { verifyLinuxChildExecInput } from '../../src/main/utils/linuxChildLaunchSelection.ts';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { runtimeProfileSchema } from '../../packages/legacy-agent-host/dist/composition/runtimeProfile.js';
import { openCodeManagementProfileSchema } from '../../packages/legacy-agent-host/dist/management/profile.js';
import { desktopOpenCodeV2ManagementProfile, prepareDesktopOpenCodeV2Recipe } from './desktop-opencode-v2-fixture.ts';
import type { DesktopOpenCodeV2Selection } from './desktop-opencode-v2-fixture.ts';
import type { OpenCodeMemberProfile } from '../../packages/legacy-agent-host/dist/composition/runtimeProfile.js';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';

export interface DesktopOpenCodeSourceSelection {
  readonly packageDirectory: string;
  readonly executable: { readonly path: string; readonly sha256: string };
  readonly modelUrl: string;
  readonly endpoint: string;
  readonly managementEndpoint: string;
  readonly initial: 'missing' | 'path';
  readonly v2?: Pick<DesktopOpenCodeV2Selection, 'bunPath' | 'bunSha256' | 'engineDirectory'>;
}

/** Complete TEST recipes before the first original Team owner is constructed. */
export async function prepareDesktopRuntimeProfile(input: {
  repo: string; root: string; node: string; profile: TeamHostProfile;
  scope: { teamId: string; runId: string };
  options: { nativeOpenCodeV2?: DesktopOpenCodeV2Selection;
    nativeOpenCodeSourceSelection?: DesktopOpenCodeSourceSelection;
    creation?: boolean; launchDialog?: boolean; nativeReviewUi?: boolean };
}) {
  const { repo, root, node, profile, scope, options } = input;
  if (options.nativeOpenCodeV2) {
    const member = await prepareDesktopOpenCodeV2Recipe({ repo, root, node,
      selection: options.nativeOpenCodeV2,
      identity: { teamId: scope.teamId, memberId: 'alice-id', principalId: 'alice-session',
        sessionId: 'TEST-native-opencode-v2', generation: 1, configRevision: 'TEST-opencode-v2-config' },
    });
    const team = profile.teams[0]!;
    team.members[0]!.delivery = { ...team.binding, runId: scope.runId,
      memberId: member.memberId, generation: String(member.generation) };
    team.grants.push({ principalId: member.principalId, memberName: 'alice',
      permissions: ['read', 'task.write', 'message.write'] });
    team.savedSettings = { cwd: member.cwd, providerId: 'opencode',
      model: `${member.nativeOptions.providerId}/${member.model}`, skipPermissions: options.nativeReviewUi === true };
    if (options.launchDialog) team.members[0]!.role = 'lead';
    profile.runtime = { members: [member],
      ...(options.creation ? { providerTemplates: [structuredClone(member)] } : {}) };
    profile.management = [desktopOpenCodeV2ManagementProfile(member,
      options.nativeOpenCodeV2.managementEndpoint, 'TEST-opencode-v2-management')];
  }
  if (options.nativeOpenCodeSourceSelection) {
    assert.equal(options.creation, true);
    assert.equal(profile.runtime, undefined);
    assert.equal(profile.management, undefined);
    const selection = options.nativeOpenCodeSourceSelection;
    const member = selection.v2
      ? await sourceV2Recipe(repo, root, node, selection, scope.teamId)
      : await sourceRecipe(root, node, selection, scope.teamId);
    await sourceProjectConfiguration(root, selection, member);
    // The sidebar seed is saved-only. A template does not assign Runtime delivery to it.
    profile.runtime = { members: [], providerTemplates: [member] };
    profile.management = [selection.v2
      ? desktopOpenCodeV2ManagementProfile(member, selection.managementEndpoint, 'TEST-opencode-source-management')
      : openCodeManagementProfileSchema.parse({
      provider: 'opencode', profileId: 'TEST-opencode-source-management',
      configRevision: 'TEST-opencode-management', accountBinding: member.accountBinding,
      cwd: member.cwd, executable: member.executable, environment: member.environment,
      endpoint: options.nativeOpenCodeSourceSelection.managementEndpoint,
      timeoutMs: 15000, modelProbeTimeoutMs: 30000,
    })];
  }
}

/** The existing Local models inventory reads this original TEST project before any owner starts. */
async function sourceProjectConfiguration(root: string, selection: DesktopOpenCodeSourceSelection,
  member: OpenCodeMemberProfile) {
  const record = (value: unknown): Record<string, unknown> => {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    return value as Record<string, unknown>;
  };
  assert.equal(member.cwd, join(root, 'workspace'));
  assert.equal(await realpath(member.cwd), member.cwd);
  assert.equal(member.nativeOptions.providerId, 'test-local'); assert.equal(member.model, 'TEST-model');
  let provider: Record<string, unknown>;
  if (selection.v2) {
    assert.equal(member.nativeGeneration, 'v2');
    const original = record(member.embedded?.providerConfiguration);
    assert.equal(original.package, 'aisdk:@ai-sdk/openai-compatible');
    provider = { npm: '@ai-sdk/openai-compatible', options: original.settings, models: original.models };
  } else {
    const inline: unknown = JSON.parse(member.environment.OPENCODE_CONFIG_CONTENT!);
    provider = record(record(record(inline).provider)['test-local']);
  }
  assert.equal(provider.npm, '@ai-sdk/openai-compatible');
  const options = record(provider.options), models = record(provider.models);
  assert.equal(options.baseURL, selection.modelUrl + '/host/v1');
  assert.ok(options.apiKey === 'TEST-LOCALHOST-ONLY', 'original TEST-only configured key');
  assert.deepEqual(Object.keys(models), ['TEST-model']);
  assert.equal(record(models['TEST-model']).name, 'TEST-model');
  const bytes = Buffer.from(JSON.stringify({ provider: { 'test-local': provider } }) + '\n');
  assert.ok(bytes.length <= 64 * 1024, 'bounded original project configuration');
  const path = join(member.cwd, 'opencode.json'), file = await open(path, 'wx+', 0o600);
  try {
    await file.writeFile(bytes);
    const stat = await file.stat();
    assert.ok(stat.isFile() && stat.nlink === 1 && stat.size === bytes.length);
    assert.equal(stat.mode & 0o777, 0o600);
    const actual = Buffer.alloc(bytes.length + 1);
    let offset = 0;
    while (offset < actual.length) {
      const { bytesRead } = await file.read(actual, offset, actual.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    assert.ok(offset === bytes.length && actual.subarray(0, offset).equals(bytes),
      'original project configuration readback matches');
    const after = await lstat(path);
    assert.ok(after.isFile() && !after.isSymbolicLink() && after.dev === stat.dev && after.ino === stat.ino &&
      after.nlink === 1 && after.size === bytes.length && (after.mode & 0o777) === 0o600);
    assert.equal(await realpath(path), path);
  } finally { await file.close(); }
}

async function sourceV2Recipe(repo: string, root: string, node: string,
  selection: DesktopOpenCodeSourceSelection, teamId: string): Promise<OpenCodeMemberProfile> {
  assert.ok(selection.v2);
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v24.21.0'); assert.equal(await realpath(process.execPath), node);
  assert.equal(await realpath(selection.packageDirectory), selection.packageDirectory);
  assert.equal(await realpath(selection.executable.path), selection.executable.path);
  assert.ok(selection.executable.path.startsWith(selection.packageDirectory + sep));
  assert.equal(createHash('sha256').update(await readFile(selection.executable.path)).digest('hex'),
    selection.executable.sha256);
  for (const name of ['@opencode/cli', '@opencode/cli-linux-x64']) {
    const metadata = JSON.parse(await readFile(join(selection.packageDirectory, 'node_modules', name, 'package.json'), 'utf8'));
    assert.equal(metadata.name, name); assert.equal(metadata.version, '2.0.21');
  }
  assert.equal(await realpath(join(selection.packageDirectory, 'node_modules/@opencode/cli-linux-x64/bin/opencode')),
    selection.executable.path);
  const member = await prepareDesktopOpenCodeV2Recipe({ repo, root, node,
    selection: { ...selection.v2, modelUrl: selection.modelUrl, endpoint: selection.endpoint,
      managementEndpoint: selection.managementEndpoint },
    identity: { teamId, memberId: 'TEST-source-template', principalId: 'TEST-source-template-session',
      sessionId: 'TEST-source-template', generation: 1, configRevision: 'TEST-source-config' },
  });
  assert.ok(member.embedded?.providerConfiguration);
  const settings = member.embedded.providerConfiguration.settings;
  assert.ok(settings !== null && typeof settings === 'object' && !Array.isArray(settings));
  member.embedded.providerConfiguration.settings = {
    ...settings, baseURL: selection.modelUrl + '/host/v1',
  };
  runtimeProfileSchema.parse({ members: [], providerTemplates: [member] });
  return member;
}

async function sourceRecipe(root: string, node: string, selection: DesktopOpenCodeSourceSelection,
  teamId: string): Promise<OpenCodeMemberProfile> {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  assert.equal(process.version, 'v24.21.0'); assert.equal(await realpath(process.execPath), node);
  assert.match(basename(root), /^TEST-desktop-backend-/);
  assert.equal(await realpath(root), root);
  assert.equal(await realpath(selection.packageDirectory), selection.packageDirectory);
  assert.equal(await realpath(selection.executable.path), selection.executable.path);
  assert.ok(selection.executable.path.startsWith(selection.packageDirectory + sep));
  assert.equal(selection.executable.sha256, '538fcb1b6408c8d4608822acee19f7ff5b3a3eb3383c0633c4f06170857312a7');
  assert.equal(createHash('sha256').update(await readFile(selection.executable.path)).digest('hex'),
    selection.executable.sha256);
  for (const name of ['opencode-ai', 'opencode-linux-x64']) {
    const metadata = JSON.parse(await readFile(join(selection.packageDirectory, 'node_modules', name, 'package.json'), 'utf8'));
    assert.equal(metadata.name, name); assert.equal(metadata.version, '1.19.4');
  }
  assert.equal(await realpath(join(selection.packageDirectory, 'node_modules/opencode-linux-x64/bin/opencode')),
    selection.executable.path);
  assert.ok(['missing', 'path'].includes(selection.initial));
  assert.notEqual(selection.endpoint, selection.managementEndpoint);
  for (const value of [selection.modelUrl, selection.endpoint, selection.managementEndpoint]) {
    const url = new URL(value);
    assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
    assert.ok(url.port); assert.equal(url.origin, value);
  }
  const folder = join(root, 'providers/opencode-source');
  for (const name of ['home', 'config', 'data', 'state', 'cache', 'tmp'])
    await mkdir(join(folder, name), { recursive: true, mode: 0o700 });
  const recipe: OpenCodeMemberProfile = {
    provider: 'opencode', protocolRevision: '1.19.4',
    teamId, memberId: 'TEST-source-template', principalId: 'TEST-source-template-session',
    sessionId: 'TEST-source-template', generation: 1, configRevision: 'TEST-source-config',
    cwd: join(root, 'workspace'), endpoint: selection.endpoint, model: 'TEST-model',
    accountBinding: 'TEST-opencode-localhost-only', executable: { ...selection.executable },
    environment: {
      HOME: join(folder, 'home'), TMPDIR: join(folder, 'tmp'),
      XDG_CONFIG_HOME: join(folder, 'config'), XDG_DATA_HOME: join(folder, 'data'),
      XDG_STATE_HOME: join(folder, 'state'), XDG_CACHE_HOME: join(folder, 'cache'),
      PATH: dirname(node) + ':/usr/bin:/bin', SHELL: '/bin/sh', NO_COLOR: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_TELEMETRY: '1', OPENCODE_DISABLE_SHARE: '1',
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        autoupdate: false, share: 'disabled', plugin: [], enabled_providers: ['test-local'],
        model: 'test-local/TEST-model', small_model: 'test-local/TEST-model',
        permission: { '*': 'deny' }, compaction: { auto: false },
        agent: { title: { disable: true }, summary: { disable: true }, 'TEST-member': { mode: 'primary' } },
        provider: { 'test-local': { npm: '@ai-sdk/openai-compatible', name: 'TEST local',
          options: { baseURL: selection.modelUrl + '/host/v1', apiKey: 'TEST-LOCALHOST-ONLY' },
          models: { 'TEST-model': { name: 'TEST-model', tool_call: true, limit: { context: 200000, output: 2000 } } },
        } },
      }),
    },
    nativeOptions: { providerId: 'test-local', agent: 'TEST-member',
      instructions: 'Answer the original TEST source-selection input without tools.' },
    limits: { queuedInputs: 2, inputBytes: 8192, outputBytes: 1_000_000,
      outputEvents: 1500, pendingInteractions: 4, timeoutMs: 45_000 },
  };
  runtimeProfileSchema.parse({ members: [], providerTemplates: [recipe] });
  return recipe;
}

/** The ordinary environment is unchanged; only this explicit TEST source choice removes its sentinel. */
export function desktopRuntimeSourceEnvironment(environment: Record<string, string>,
  root: string, node: string, selection?: DesktopOpenCodeSourceSelection): Record<string, string> {
  if (!selection) return environment;
  const result = { ...environment };
  for (const name of ['OPENCODE_CLI_PATH', 'CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH', 'OPENCODE_BIN_PATH'])
    delete result[name];
  result.PATH = [join(root, 'bin'), dirname(node),
    ...(selection.initial === 'path' ? [dirname(selection.executable.path)] : []), '/usr/bin', '/bin'].join(':');
  result.OPENCODE_DISABLE_AUTOUPDATE = '1';
  result.OPENCODE_DISABLE_MODELS_FETCH = '1';
  return result;
}

const linuxChildExecReference = Object.freeze({
  manifestPath: process.env.LEGACY_LINUX_CHILD_EXEC_MANIFEST,
  manifestSha256: process.env.LEGACY_LINUX_CHILD_EXEC_SHA256,
});

/** Separately pinned TEST launch input; it never enters a captured Host profile. */
export function readDesktopLinuxChildExecInput() {
  const { manifestPath, manifestSha256 } = linuxChildExecReference;
  if (manifestPath === undefined && manifestSha256 === undefined) return undefined;
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  assert.ok(manifestPath && manifestSha256);
  return verifyLinuxChildExecInput({ manifestPath, manifestSha256 });
}

export function desktopBackendEnvironment(
  root: string,
  node: string,
  descriptorPath: string,
  descriptorSha256: string,
  linuxChildExec = readDesktopLinuxChildExecInput()
) {
  return {
    HOME: join(root, 'home'),
    TMPDIR: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'config'),
    // Chromium's macOS GetHomeDir uses NSHomeDirectory, not getenv(HOME).
    // Apple's CFPlatform.c prioritizes this override before the passwd home.
    CFFIXED_USER_HOME: join(root, 'home'),
    MAC_CHROMIUM_TMPDIR: join(root, 'tmp'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    PATH: `${join(root, 'bin')}:${dirname(node)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`,
    SHELL: join(root, 'bin/shell-env'),
    NODE_ENV: 'development',
    ...(process.platform === 'darwin' && process.arch === 'arm64' &&
      process.env.LEGACY_PROCESS_COLD_UI_GO === '1' &&
      process.env.LEGACY_DESKTOP_PROOF_MODE === 'process-cold-ui'
      ? { NODE_OPTIONS: '--max-old-space-size=8192' } : {}),
    ...(process.platform === 'linux' ? {
      DISPLAY: process.env.LEGACY_DESKTOP_TEST_DISPLAY ?? '',
      XAUTHORITY: process.env.LEGACY_DESKTOP_TEST_XAUTHORITY ?? '',
    } : {}),
    ...(process.env.LEGACY_DESKTOP_COREPACK_HOME ? { COREPACK_HOME: process.env.LEGACY_DESKTOP_COREPACK_HOME } : {}),
    NO_COLOR: '1',
    // A TEST HOME changes pnpm's store lookup. Report drift without installing
    // into the frozen worktree; the harness verifies its selected archive bytes.
    pnpm_config_verify_deps_before_run: 'warn',
    TERM: 'dumb',
    AGENT_TEAMS_ELECTRON_USER_DATA_DIR: join(root, 'userData'),
    AGENT_TEAMS_ELECTRON_CLAUDE_ROOT: join(root, 'claude'),
    CLAUDE_ROOT: join(root, 'claude'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'config/codex'),
    OPENCODE_CONFIG_DIR: join(root, 'config/opencode'),
    AGENT_TEAMS_BACKEND_DESCRIPTOR_PATH: descriptorPath,
    AGENT_TEAMS_BACKEND_DESCRIPTOR_SHA256: descriptorSha256,
    ...(linuxChildExec ? { AGENT_TEAMS_LINUX_CHILD_EXEC_MANIFEST: linuxChildExec.manifestPath,
      AGENT_TEAMS_LINUX_CHILD_EXEC_SHA256: linuxChildExec.manifestSha256 } : {}),
    CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: join(root, 'bin/claude-multimodel'),
    CLAUDE_CLI_PATH: join(root, 'bin/claude'),
    CODEX_CLI_PATH: join(root, 'bin/codex'),
    OPENCODE_CLI_PATH: join(root, 'bin/opencode'),
    CLAUDE_TERMINAL_DAEMON_BINARY: join(root, 'bin/terminal-daemon'),
    CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: join(root, 'bin/opencode'),
    OPENCODE_BIN_PATH: join(root, 'bin/opencode'),
    CLAUDE_DEV_RUNTIME_DISABLE_GH: '1',
    CLAUDE_DEV_RUNTIME_CACHE_ROOT: join(root, 'cache/runtime'),
    NODE_BINARY: node,
    CLAUDE_TEAM_OPENCODE_MCP_HTTP: '0',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
  };
}
