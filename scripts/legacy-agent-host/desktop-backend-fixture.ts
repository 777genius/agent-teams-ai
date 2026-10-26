import {
  GROUP_ALICE_CONTEXT,
  GROUP_BOB_CONTEXT,
} from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/group-chat.ts';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createFilesystemTeamOwner } from '../../packages/legacy-agent-host/dist/adapters/team/createFilesystemTeamOwner.js';
import { acquireProfileWriterLease } from '../../packages/legacy-agent-host/dist/adapters/profile/ProfileWriterLease.js';
import { CONTEXT_MARKER } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import type { CandidateRuntimePaths } from './candidate-runtime-paths.ts';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';
import { prepareNativeReviewWorkspace } from './desktop-native-review-fixture.ts';
import { prepareDesktopReviewLedger } from './desktop-review-fixture.ts';
import { prepareDesktopStoppedImport } from './desktop-stopped-import-fixture.ts';

export const digest = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');
export const fileDigest = async (path: string): Promise<string> => digest(await readFile(path));

const quoteShellArgument = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

/** Shell bootstrap preserves the captured absolute Node even inside an app bundle path. */
export function desktopNodeScriptHeader(node: string): string {
  if (!node.startsWith('/') || /[\0\r\n]/u.test(node)) throw new Error('Invalid TEST Node path');
  return `#!/bin/sh\n':' //; exec ${quoteShellArgument(node)} "$0" "$@"\n`;
}

/** Creates only private TEST files. It neither launches the Host nor opens a provider. */
export async function prepareDesktopBackendFixture(
  repo: string,
  options: {
    candidateRuntime?: CandidateRuntimePaths;
    diagnosticHostEntry?: { path: string; sha256: string };
    approvalUi?: boolean;
    nativeChatAttachments?: boolean;
    nativeGroupChats?: boolean;
    seedUiTask?: boolean;
    seedUiPreferences?: boolean;
    seedCodexApiKey?: boolean;
    launchDialog?: boolean;
    creation?: boolean;
    reviewUi?: boolean;
    nativeReviewUi?: boolean;
    stoppedImportUi?: boolean;
    pnpmEntry: string;
    nativeCodex?: { path: string; sha256: string };
    nativeClaude?: { path: string; sha256: string; modelUrl?: string };
  }
) {
  const node =
    options.candidateRuntime?.nodeExecutable ??
    (await realpath(join(repo, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node')));
  const hostEntry =
    options.candidateRuntime?.hostEntry ??
    (await realpath(
      options.diagnosticHostEntry?.path ?? join(repo, 'packages/legacy-agent-host/dist/cli.js')
    ));
  if (
    options.diagnosticHostEntry &&
    (options.candidateRuntime ||
      !options.diagnosticHostEntry.path.startsWith('/private/tmp/TEST-') ||
      hostEntry !== options.diagnosticHostEntry.path ||
      (await fileDigest(hostEntry)) !== options.diagnosticHostEntry.sha256)
  )
    throw new Error('Invalid TEST diagnostic Host entry');
  const nodeSha256 = await fileDigest(node);
  const hostEntrySha256 = await fileDigest(hostEntry);
  const pnpmEntry = await realpath(options.pnpmEntry);
  const corepackPackagePath = join(dirname(pnpmEntry), '../package.json');
  const corepackLibraryPath = join(dirname(pnpmEntry), 'lib/corepack.cjs');
  const corepackPackage = JSON.parse(await readFile(corepackPackagePath, 'utf8')) as {
    name?: string;
    version?: string;
  };
  if (corepackPackage.name !== 'corepack' || typeof corepackPackage.version !== 'string')
    throw new Error('selected package manager must be pinned Corepack');
  const corepackPackageSha256 = await fileDigest(corepackPackagePath);
  const corepackLibrarySha256 = await fileDigest(corepackLibraryPath);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-desktop-backend-')));
  for (const directory of [
    'home',
    'config',
    'config/codex',
    'config/opencode',
    'claude',
    'userData',
    'workspace',
    'hoststore',
    'tmp',
    'bin',
    'cache',
    'data',
  ])
    await mkdir(join(root, directory), { mode: 0o700 });
  if (options.seedUiTask || options.seedUiPreferences)
    await writeFile(
      join(root, 'claude/agent-teams-config.json'),
      JSON.stringify({ general: { appLocale: 'en', agentLanguage: 'en', theme: 'dark' } }),
      { mode: 0o600 }
    );
  // The outer and nested pnpm invocations use the same selected Corepack bytes
  // and private HOME/cache. PATH must never select an unrelated global shim.
  const pnpmStubSource = options.candidateRuntime
    ? "#!/bin/sh\nprintf 'TEST refuses package-manager execution in packed app\\n' >&2\nexit 78\n"
    : `#!/bin/sh\nexec ${quoteShellArgument(node)} ${quoteShellArgument(pnpmEntry)} "$@"\n`;
  await writeFile(join(root, 'bin/pnpm'), pnpmStubSource, { mode: 0o700 });
  if (options.approvalUi) {
    for (const [name, content] of [
      ['approval-preview.txt', 'TEST_ORIGINAL_PRIVATE_BYTES\n'],
      ['approval-auto.txt', 'TEST_AUTO_ORIGINAL\n'],
      ['approval-auto-next.txt', 'TEST_AUTO_NEXT_ORIGINAL\n'],
    ])
      await writeFile(join(root, 'workspace', name!), content!, { mode: 0o600, flag: 'wx' });
  }
  if (options.candidateRuntime)
    await writeFile(
      join(root, 'bin/node'),
      "#!/bin/sh\nprintf 'TEST refuses Node resolution from PATH\\n' >&2\nexit 78\n",
      { mode: 0o700, flag: 'wx' }
    );
  const assertNativeGroupFixture = () => {
    if (!options.nativeGroupChats) return;
    if (
      !options.nativeClaude?.modelUrl ||
      options.nativeChatAttachments ||
      options.launchDialog ||
      options.creation
    )
      throw new Error(
        'Native group proof requires its own captured localhost conversation fixture'
      );
  };
  assertNativeGroupFixture();
  const namespace = basename(root);
  const owner = {
    ownerId: `TEST-desktop-owner-${namespace}`,
    revision: 'TEST-desktop-revision-1',
    storageRoot: join(root, 'hoststore'),
    profileId: `TEST-desktop-profile-${namespace}`,
    protocolVersion: 1 as const,
    buildId: options.diagnosticHostEntry
      ? 'TEST-desktop-diagnostic-host'
      : 'TEST-desktop-real-host',
    nodeSha256,
    hostEntrySha256,
  };
  const scope = {
    projectId: `TEST-project-${namespace}`,
    workspaceId: `TEST-workspace-${namespace}`,
    teamId: 'TEST-desktop-team',
    runId: `TEST-run-${namespace}`,
    memberId: 'human',
    generation: '1',
  };
  const profile: TeamHostProfile = {
    schemaVersion: 1,
    ...(options.candidateRuntime
      ? { processCustody: options.candidateRuntime.processCustody }
      : {}),
    owner,
    principalId: 'TEST-human',
    ...(options.creation ? { creation: { contextIds: ['local'] } } : {}),
    teams: [
      {
        scope,
        binding: {
          backendId: owner.ownerId,
          teamId: scope.teamId,
          teamName: 'test-desktop-backend',
        },
        members: [
          {
            memberId: 'alice-id',
            name: 'alice',
            role: options.nativeChatAttachments || options.nativeGroupChats ? 'lead' : 'member',
          },
        ],
        grants: [
          {
            principalId: 'TEST-human',
            memberName: 'user',
            permissions: ['read', 'task.write', 'message.write', 'admin'],
          },
        ],
      },
    ],
  };
  if (options.reviewUi || options.nativeReviewUi) {
    profile.reviewTransport = 'review-v1';
    profile.teams[0]!.members[0]!.role = 'lead';
    profile.teams[0]!.savedSettings = { cwd: join(root, 'workspace') };
  }
  if (options.nativeClaude) {
    const binary = await realpath(options.nativeClaude.path);
    if (
      binary !== options.nativeClaude.path ||
      (await fileDigest(binary)) !== options.nativeClaude.sha256 ||
      options.nativeClaude.sha256 !==
        'ea3ea3c08d2a9634a4651e687fcf900d410c489bce2b00f22bd7352b91ba704f'
    )
      throw new Error('Unqualified TEST Claude executable');
    for (const directory of [
      'native-claude',
      'native-claude/home',
      'native-claude/config',
      'native-claude/tmp',
    ])
      await mkdir(join(root, directory), { mode: 0o700 });
    if (options.nativeClaude.modelUrl) {
      const url = new URL(options.nativeClaude.modelUrl);
      if (
        url.protocol !== 'http:' ||
        url.hostname !== '127.0.0.1' ||
        !url.port ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        throw new Error('Only a captured local TEST model server is permitted');
    }
    const team = profile.teams[0]!;
    if (options.nativeChatAttachments) {
      // Ordinary Launch saves this intent; this TEST uses explicit prelaunch setup instead.
      // Match that setup's selected Claude model/effort before any SDK allocation.
      team.savedSettings = {
        cwd: join(root, 'workspace'),
        providerId: 'anthropic',
        model: 'claude-opus-4-6',
        effort: 'medium',
      };
    }
    if (options.launchDialog) {
      team.members[0]!.role = 'lead';
      team.savedSettings = {
        cwd: join(root, 'workspace'),
        providerId: 'anthropic',
        model: 'claude-sonnet-4-6',
        effort: 'low',
        fastMode: 'off',
        skipPermissions: true,
        limitContext: true,
        syncModelsWithLead: true,
        prompt: '',
      };
    }
    team.members[0]!.delivery = {
      ...team.binding,
      runId: scope.runId,
      memberId: 'alice-id',
      generation: '1',
    };
    team.grants.push({
      principalId: 'alice-session',
      memberName: 'alice',
      permissions: ['read', 'task.write', 'message.write'],
    });
    profile.runtime = {
      members: [
        {
          provider: 'claude',
          teamId: scope.teamId,
          memberId: 'alice-id',
          principalId: 'alice-session',
          sessionId: 'TEST-native-stop-session',
          generation: 1,
          configRevision: 'TEST-native-stop-config',
          cwd: join(root, 'workspace'),
          model: 'claude-sonnet-4-6',
          accountBinding: 'TEST-LOCALHOST-ONLY',
          executable: { path: options.nativeClaude.path, sha256: options.nativeClaude.sha256 },
          environment: {
            HOME: join(root, 'native-claude/home'),
            CLAUDE_CONFIG_DIR: join(root, 'native-claude/config'),
            TMPDIR: join(root, 'native-claude/tmp'),
            PATH: dirname(node) + ':/usr/bin:/bin',
            SHELL: '/bin/sh',
            ANTHROPIC_API_KEY: 'TEST-LOCALHOST-ONLY',
            ANTHROPIC_BASE_URL: options.nativeClaude.modelUrl ?? 'http://127.0.0.1:9',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
            DISABLE_AUTOUPDATER: '1',
            DISABLE_TELEMETRY: '1',
            DISABLE_ERROR_REPORTING: '1',
            NO_COLOR: '1',
          },
          nativeTools: options.nativeClaude.modelUrl
            ? options.approvalUi
              ? ['Read', 'Write', 'Bash', 'AskUserQuestion']
              : options.nativeReviewUi
                ? ['Read', 'Edit', 'Write', 'Bash']
                : ['Bash']
            : [],
          autoAllowedTools: options.approvalUi
            ? []
            : options.nativeClaude.modelUrl
              ? options.nativeReviewUi
                ? ['Read', 'Edit', 'Write', 'Bash']
                : ['Bash']
              : [],
          ...(options.nativeClaude.modelUrl
            ? {
                nativeOptions: {
                  ...(options.nativeReviewUi ? { settingSources: ['project'] } : {}),
                  projectInstructions: { append: CONTEXT_MARKER },
                },
              }
            : {}),
          limits: {
            queuedInputs: 2,
            inputBytes: 8192,
            outputBytes: 1_000_000,
            outputEvents: 1500,
            pendingInteractions: 4,
            timeoutMs: 45_000,
          },
        },
      ],
    };
    if (options.nativeGroupChats) {
      assertNativeGroupFixture();
      const alice = profile.runtime.members[0]!;
      if (alice.provider !== 'claude')
        throw new Error('Native group setup must retain actual captured Claude actors');
      const bob = structuredClone(alice);
      bob.memberId = 'bob-id';
      bob.principalId = 'bob-session';
      bob.sessionId = 'TEST-native-group-bob';
      bob.configRevision = 'TEST-native-group-bob-config';
      bob.accountBinding = 'TEST-LOCALHOST-BOB-ONLY';
      for (const directory of [
        'native-claude-bob',
        'native-claude-bob/home',
        'native-claude-bob/config',
        'native-claude-bob/tmp',
      ])
        await mkdir(join(root, directory), { mode: 0o700 });
      bob.environment = {
        ...bob.environment,
        HOME: join(root, 'native-claude-bob/home'),
        CLAUDE_CONFIG_DIR: join(root, 'native-claude-bob/config'),
        TMPDIR: join(root, 'native-claude-bob/tmp'),
      };
      bob.nativeOptions = {
        ...bob.nativeOptions,
        projectInstructions: { append: GROUP_BOB_CONTEXT },
      };
      alice.nativeOptions = {
        ...alice.nativeOptions,
        projectInstructions: { append: CONTEXT_MARKER + '\n' + GROUP_ALICE_CONTEXT },
      };
      profile.runtime.members.push(bob);
      team.members.push({
        memberId: 'bob-id',
        name: 'bob',
        role: 'member',
        delivery: {
          ...team.binding,
          runId: scope.runId,
          memberId: 'bob-id',
          generation: '1',
        },
      });
      team.grants.push({
        principalId: 'bob-session',
        memberName: 'bob',
        permissions: ['read', 'task.write', 'message.write'],
      });
    }
    if (options.launchDialog) {
      const member = profile.runtime.members[0]!;
      if (options.creation) profile.runtime.providerTemplates = [structuredClone(member)];
      profile.management = [
        {
          provider: 'claude',
          sdkRevision: '0.3.305',
          profileId: 'TEST-claude-management',
          accountBinding: member.accountBinding,
          configRevision: 'TEST-claude-management-config',
          configNamespace: 'custom-directory',
          cwd: member.cwd,
          environment: member.environment,
          executable: member.executable,
          settingSources: [],
          timeoutMs: 15000,
          modelProbeTimeoutMs: 30000,
        },
      ];
    }
  }
  if (options.nativeCodex) {
    const binary = await realpath(options.nativeCodex.path);
    if (
      binary !== options.nativeCodex.path ||
      (await fileDigest(binary)) !== options.nativeCodex.sha256 ||
      options.nativeCodex.sha256 !==
        '8238273076041e55beded03ba1d51e034f997b7d100b0642d36daf036620fe57'
    )
      throw new Error('Unqualified TEST Codex executable');
    await writeFile(
      join(root, 'config/codex/config.toml'),
      'model = "TEST-model"\nmodel_provider = "TEST_fixture"\ncheck_for_update_on_startup = false\ncli_auth_credentials_store = "file"\n[analytics]\nenabled = false\n[otel]\nexporter = "none"\nmetrics_exporter = "none"\n[features]\nremote_models = false\napps = false\nplugins = false\nshell_snapshot = false\nskip_host_skill_discovery = true\n[model_providers.TEST_fixture]\nname = "TEST fixture"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n'.replace(
        'requires_openai_auth = false',
        options.seedCodexApiKey ? 'requires_openai_auth = true' : 'requires_openai_auth = false'
      ),
      { mode: 0o600 }
    );
    if (options.seedCodexApiKey)
      await writeFile(
        join(root, 'config/codex/auth.json'),
        JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'TEST-ONLY-NOT-A-REAL-KEY' }),
        { mode: 0o600 }
      );
    profile.management = [
      {
        provider: 'codex',
        protocolRevision: '0.162.0',
        profileId: 'TEST-codex-metadata',
        accountBinding: 'TEST-no-credentials',
        configRevision: 'TEST-codex-config',
        timeoutMs: 10000,
        cwd: join(root, 'workspace'),
        executable: options.nativeCodex,
        environment: {
          HOME: join(root, 'home'),
          CODEX_HOME: join(root, 'config/codex'),
          TMPDIR: join(root, 'tmp'),
          XDG_CONFIG_HOME: join(root, 'config'),
          XDG_DATA_HOME: join(root, 'data'),
          XDG_CACHE_HOME: join(root, 'cache'),
          PATH: dirname(node) + ':/usr/bin:/bin',
          SHELL: '/bin/sh',
        },
      },
    ];
  }
  let uiSeed: { taskId: string; subject: string; commandId: string } | undefined;
  if (options.seedUiTask) {
    const lease = acquireProfileWriterLease(owner.storageRoot);
    try {
      lease.assertCurrent();
      const selected = profile.teams[0]!;
      const team = createFilesystemTeamOwner({
        root: owner.storageRoot,
        binding: selected.binding,
        members: selected.members,
        grants: selected.grants,
        ...(selected.savedSettings ? { savedSettings: selected.savedSettings } : {}),
      }).connect(profile.principalId);
      const subject = 'TEST persisted Host sidebar seed';
      const commandId = 'TEST-ui-offline-seed';
      const receipt = team.execute({ commandId, operation: 'task.create', payload: { subject } });
      if (receipt.phase !== 'completed') throw new Error('TEST canonical seed did not complete');
      const tasks = team.listTasks();
      if (tasks.length !== 1 || tasks[0]!.subject !== subject)
        throw new Error('TEST canonical seed mismatch');
      uiSeed = { taskId: tasks[0]!.id, subject, commandId };
      await writeFile(join(root, 'ui-seed-receipt.json'), JSON.stringify(receipt, null, 2), {
        mode: 0o600,
      });
    } finally {
      lease.release();
    }
  }
  if (options.reviewUi) {
    if (!uiSeed) throw new Error('Review UI needs its canonical captured Task seed');
    await prepareDesktopReviewLedger(root, uiSeed.taskId);
  }
  if (options.nativeReviewUi) await prepareNativeReviewWorkspace(root);
  if (options.stoppedImportUi) await prepareDesktopStoppedImport(root);
  const profilePath = join(root, 'host-profile.json');
  const profileBytes = JSON.stringify(profile);
  await writeFile(profilePath, profileBytes, { mode: 0o600 });
  readTeamHostProfile(profilePath, digest(profileBytes));
  const ownerRef = { ownerId: owner.ownerId, revision: owner.revision };
  const handleId = `TEST-desktop-handle-${namespace}`;
  const descriptor = {
    schemaVersion: 1,
    defaultOwner: ownerRef,
    ...(options.creation
      ? {
          creation: {
            owner: ownerRef,
            contextIds: ['local'],
            ...(options.stoppedImportUi
              ? { importAuthority: { principalId: profile.principalId } }
              : {}),
          },
        }
      : {}),
    owners: [
      {
        ...ownerRef,
        storageRoot: owner.storageRoot,
        profile: {
          profileId: owner.profileId,
          ...(options.reviewUi || options.nativeReviewUi ? { reviewTransport: 'review-v1' } : {}),
          nodeExecutable: node,
          nodeVersion: options.candidateRuntime?.nodeVersion ?? 'v24.21.0',
          nodeSha256,
          hostEntry,
          hostEntrySha256,
          expectedBuildId: owner.buildId,
          cwd: join(root, 'workspace'),
          env: {
            HOME: join(root, 'home'),
            TMPDIR: join(root, 'tmp'),
            PATH: `${dirname(node)}:/usr/bin:/bin`,
            LEGACY_AGENT_HOST_PROFILE_PATH: profilePath,
            LEGACY_AGENT_HOST_PROFILE_SHA256: digest(profileBytes),
          },
          // This TEST profile verifies workflows, not startup latency. Cold source
          // startup competes with Electron builds; timeout semantics have focused tests.
          startupTimeoutMs: 60_000,
          requestTimeoutMs: 60_000,
          writeTimeoutMs: 5000,
          shutdownTimeoutMs: 10_000,
        },
      },
    ],
    ...(options.nativeCodex || options.launchDialog
      ? {
          management: [
            {
              runtimeId: options.launchDialog ? 'claude' : 'codex',
              owner: ownerRef,
              contextId: 'local',
              projectPath: null,
              profileId: options.launchDialog ? 'TEST-claude-management' : 'TEST-codex-metadata',
              configRevision: options.launchDialog
                ? 'TEST-claude-management-config'
                : 'TEST-codex-config',
            },
          ],
        }
      : {}),
    handles: [
      {
        handleId,
        owner: ownerRef,
        contextId: 'local',
        label: 'TEST private backend',
        members: [
          { memberId: 'alice-id', label: 'alice' },
          ...(options.nativeGroupChats ? [{ memberId: 'bob-id', label: 'bob' }] : []),
        ],
        scope,
      },
    ],
  };
  const descriptorPath = join(root, 'desktop-descriptor.json');
  const descriptorBytes = JSON.stringify(descriptor);
  await writeFile(descriptorPath, descriptorBytes, { mode: 0o600 });

  const lock = JSON.parse(await readFile(join(repo, 'runtime.lock.json'), 'utf8')) as {
    cliVersion: string;
  };
  const sentinelLog = join(root, 'sentinel-invocations.ndjson');
  // No inherited environment or user config. The sentinel can never run an agent.
  const sentinelSource = `${desktopNodeScriptHeader(node)}import {appendFileSync} from 'node:fs';
import {basename} from 'node:path';
const args=process.argv.slice(2),allowed=${options.candidateRuntime ? 'false' : "args.length===1&&args[0]==='--version'"};
appendFileSync(${JSON.stringify(sentinelLog)},JSON.stringify({executable:basename(process.argv[1]),allowed,argc:args.length,flags:args.filter(x=>x.startsWith('-')).map(x=>x.split('=')[0]).slice(0,16)})+'\\n',{mode:0o600});
if(allowed){console.log(${JSON.stringify(lock.cliVersion + ' (TEST sentinel)')});process.exit(0)}
process.stderr.write('TEST sentinel refuses native agent invocation\\n');process.exit(78);
`;
  for (const name of [
    'claude',
    'codex',
    'opencode',
    'gemini',
    'claude-multimodel',
    'terminal-daemon',
  ])
    await writeFile(join(root, 'bin', name), sentinelSource, { mode: 0o700 });
  // cliPathMerge prefers this selected TEST vendor directory even before the
  // shell environment cache is warm; keep cold discovery behind the same guard.
  const vendorBin = join(root, 'claude/local/node_modules/.bin');
  await mkdir(vendorBin, { recursive: true, mode: 0o700 });
  for (const name of ['claude', 'codex', 'opencode', 'gemini', 'claude-multimodel'])
    await writeFile(join(vendorBin, name), sentinelSource, { mode: 0o700 });
  // Startup's shell environment resolver may otherwise source login files and
  // replace the isolated PATH/HOME. This TEST executable performs no shell eval.
  const shellProbeSource = `${desktopNodeScriptHeader(node)}import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2),allowed=args.length===2&&['-lic','-ic'].includes(args[0])&&args[1]==='env -0';
appendFileSync(${JSON.stringify(sentinelLog)},JSON.stringify({executable:'shell-env',allowed,argc:args.length,flags:args.filter(x=>x.startsWith('-'))})+'\\n',{mode:0o600});
if(!allowed){process.stderr.write('TEST shell refuses execution\\n');process.exit(78)}
process.stdout.write(Object.entries(process.env).map(([k,v])=>k+'='+v).join('\\0')+'\\0');
`;
  await writeFile(join(root, 'bin/shell-env'), shellProbeSource, { mode: 0o700 });
  return {
    root,
    node,
    hostEntry,
    handleId,
    sentinelLog,
    uiSeed,
    packageManager: {
      entry: pnpmEntry,
      packagePath: corepackPackagePath,
      libraryPath: corepackLibraryPath,
      version: corepackPackage.version,
    },
    pins: {
      nodeSha256,
      hostEntrySha256,
      corepackPackageSha256,
      corepackLibrarySha256,
      pnpmStubSha256: digest(pnpmStubSource),
      profileSha256: digest(profileBytes),
      descriptorSha256: digest(descriptorBytes),
      sentinelSha256: digest(sentinelSource),
      shellProbeSha256: digest(shellProbeSource),
    },
    descriptorPath,
    profilePath,
    appEnvironment: desktopBackendEnvironment(root, node, descriptorPath, digest(descriptorBytes)),
  };
}

export function desktopBackendEnvironment(
  root: string,
  node: string,
  descriptorPath: string,
  descriptorSha256: string
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
