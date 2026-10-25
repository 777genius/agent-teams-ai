import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { startNativeTeamModel } from '../../packages/legacy-agent-host/tests/fixtures/native-claude-team/model.ts';
import {
  startCodexModel,
  CONTEXT_MARKER as codexContext,
} from '../../packages/legacy-agent-host/tests/fixtures/native-codex-team/model.ts';
import {
  startOpenCodeModel,
  CONTEXT_MARKER as openCodeContext,
} from '../../packages/legacy-agent-host/tests/fixtures/native-opencode-team/model.ts';
import { readTeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/readProfile.js';
import { desktopBackendEnvironment, digest, fileDigest } from './desktop-backend-fixture.ts';
import type { prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import type { TeamHostProfile } from '../../packages/legacy-agent-host/dist/composition/TeamHost.js';

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
export const mixedDesktopTeamName = 'test-created-native-mixed';
const codeXHash = '8238273076041e55beded03ba1d51e034f997b7d100b0642d36daf036620fe57';
const openCodeHash = '417af53923f3d529759ab85ce3e8dd09116f742efcd332de591d2da6ebae696b';

/** Identity is read from the original capture AND its live registered grant. */
export function readMixedCapturedPrincipal(
  root: string,
  provider: 'claude' | 'codex' | 'opencode'
) {
  assert.match(basename(root), /^TEST-desktop-backend-/);
  const state = record(
    JSON.parse(
      readFileSync(
        join(root, 'hoststore/teams', mixedDesktopTeamName, '.host-owner/state.json'),
        'utf8'
      )
    )
  );
  assert.ok(Array.isArray(state.runtimeCaptures) && state.runtimeCaptures.length === 1);
  assert.ok(Array.isArray(state.members) && state.members.length === 3);
  assert.ok(Array.isArray(state.grants));
  const members = state.members
    .map(record)
    .filter((member) =>
      provider === 'claude'
        ? member.role === 'lead' && record(state.savedSettings).providerId === 'anthropic'
        : record(member.settings).providerId === provider
    );
  assert.equal(members.length, 1, 'one canonical member for this TEST provider');
  const capture = record(state.runtimeCaptures[0]);
  assert.ok(Array.isArray(capture.members) && capture.members.length === 3);
  const bindings = capture.members
    .map(record)
    .filter((member) => member.memberId === members[0]!.memberId);
  assert.equal(bindings.length, 1);
  const binding = bindings[0]!;
  assert.equal(typeof binding.principalId, 'string');
  assert.equal(record(binding.delivery).runId, capture.launchId);
  assert.equal(record(binding.delivery).memberId, members[0]!.memberId);
  const grants = state.grants
    .map(record)
    .filter((grant) => grant.principalId === binding.principalId && grant.revoked !== true);
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.memberName, members[0]!.name);
  assert.ok(Array.isArray(grants[0]!.permissions));
  for (const permission of ['read', 'task.write', 'message.write', 'process.write'])
    assert.ok(grants[0]!.permissions.includes(permission));
  return String(grants[0]!.principalId);
}

/** Called only inside the explicitly authorized desktop proof; no agent starts here. */
export async function startDesktopMixedModels(root: () => string) {
  assert.equal(process.env.LEGACY_DESKTOP_BACKEND_GO, '1');
  const claude = await startNativeTeamModel({
    allowModelProbes: true,
    mixedGroups: true,
    uiGeneratedMessageIds: true,
    memberName: 'team-lead',
    principalId: () => readMixedCapturedPrincipal(root(), 'claude'),
  });
  let codex: Awaited<ReturnType<typeof startCodexModel>> | undefined;
  let opencode: Awaited<ReturnType<typeof startOpenCodeModel>> | undefined;
  try {
    codex = await startCodexModel({
      allowModelProbes: true,
    mixedGroups: true,
      principalId: () => readMixedCapturedPrincipal(root(), 'codex'),
    });
    opencode = await startOpenCodeModel({
      allowModelProbes: true,
    mixedGroups: true,
      principalId: () => readMixedCapturedPrincipal(root(), 'opencode'),
    });
    const selected = { claude, codex, opencode };
    let evidenceRoot: string | undefined;
    return {
      ...selected,
      retainEvidenceAt: async (root: string) => {
        assert.equal(evidenceRoot, undefined, 'one original TEST mixed model evidence root');
        assert.match(basename(root), /^TEST-desktop-backend-/);
        assert.equal(await realpath(root), root);
        evidenceRoot = root;
      },
      close: async () => {
        try {
          if (evidenceRoot) await writeFile(join(evidenceRoot, 'mixed-models.json'), JSON.stringify({
            schemaVersion: 1, phase: 'before-model-close', root: evidenceRoot,
            providers: Object.fromEntries(Object.entries(selected).map(([provider, model]) => [provider, {
              observations: model.observations, probes: model.probes, failures: model.failures,
              ...('unexpectedNoToolsRequests' in model ? { unexpectedNoToolsRequests: model.unexpectedNoToolsRequests } : {}),
            }])),
          }, null, 2), { mode: 0o600, flag: 'wx' });
        } finally {
          await Promise.all(Object.values(selected).map((model) => model.close()));
        }
      },
    };
  } catch (error) {
    await Promise.all([claude.close(), codex?.close(), opencode?.close()]);
    throw error;
  }
}
export type DesktopMixedModels = Awaited<ReturnType<typeof startDesktopMixedModels>>;

/** Private TEST files only, before an app/Host/capture exists. All source identities come from the selected base fixture. */
export async function prepareDesktopMixedNativeFixture(
  base: Awaited<ReturnType<typeof prepareDesktopBackendFixture>>,
  options: {
    codexPath: string;
    openCodePath: string;
    openCodeEndpoint: string;
    models: DesktopMixedModels;
  }
) {
  assert.match(basename(base.root), /^TEST-desktop-backend-/);
  assert.equal(await fileDigest(base.profilePath), base.pins.profileSha256);
  assert.equal(await fileDigest(base.descriptorPath), base.pins.descriptorSha256);
  const profile = JSON.parse(await readFile(base.profilePath, 'utf8')) as TeamHostProfile;
  assert.equal(profile.owner.storageRoot, join(base.root, 'hoststore'));
  assert.ok(profile.creation?.contextIds.includes('local'));
  const claude = profile.runtime?.providerTemplates?.find((item) => item.provider === 'claude');
  assert.ok(claude?.provider === 'claude');
  assert.equal(profile.runtime!.providerTemplates!.length, 1);
  claude.nativeOptions = { ...claude.nativeOptions, settingSources: [] };
  const endpoint = new URL(options.openCodeEndpoint);
  assert.equal(endpoint.protocol, 'http:');
  assert.equal(endpoint.hostname, '127.0.0.1');
  assert.equal(endpoint.origin, options.openCodeEndpoint);
  assert.ok(endpoint.port);
  for (const [path, sha] of [
    [options.codexPath, codeXHash],
    [options.openCodePath, openCodeHash],
  ]) {
    assert.ok(path && sha);
    assert.equal(await realpath(path), path);
    assert.equal(await fileDigest(path), sha);
  }
  const environment = async (provider: string) => {
    const folder = join(base.root, 'providers', provider);
    for (const name of ['home', 'config', 'data', 'cache', 'tmp'])
      await mkdir(join(folder, name), { recursive: true, mode: 0o700 });
    return {
      HOME: join(folder, 'home'),
      TMPDIR: join(folder, 'tmp'),
      XDG_CONFIG_HOME: join(folder, 'config'),
      XDG_DATA_HOME: join(folder, 'data'),
      XDG_CACHE_HOME: join(folder, 'cache'),
      PATH: dirname(base.node) + ':/usr/bin:/bin',
      SHELL: '/bin/sh',
    };
  };
  const codexEnvironment = {
    ...(await environment('codex')),
    CODEX_HOME: join(base.root, 'providers/codex/config'),
    TEST_CODEX_FIXTURE_KEY: 'TEST-LOCALHOST-ONLY',
  };
  await writeFile(
    join(codexEnvironment.CODEX_HOME, 'config.toml'),
    `model = "mock-model"
model_provider = "TEST_fixture"
approval_policy = "never"
sandbox_mode = "workspace-write"
web_search = "disabled"
check_for_update_on_startup = false
cli_auth_credentials_store = "file"
project_doc_max_bytes = 0
[analytics]
enabled = false
[otel]
exporter = "none"
metrics_exporter = "none"
[features]
code_mode = false
apps = false
plugins = false
remote_models = false
shell_snapshot = false
skip_host_skill_discovery = true
enable_request_compression = false
multi_agent = false
[shell_environment_policy]
inherit = "none"
set = { HOME = ${JSON.stringify(codexEnvironment.HOME)}, TMPDIR = ${JSON.stringify(codexEnvironment.TMPDIR)}, PATH = "/usr/bin:/bin" }
[model_providers.TEST_fixture]
name = "TEST fixture"
base_url = ${JSON.stringify(options.models.codex.url + '/v1')}
env_key = "TEST_CODEX_FIXTURE_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`,
    { mode: 0o600 }
  );
  const common = (provider: string) => ({
    teamId: 'TEST-template',
    memberId: `TEST-${provider}-template`,
    principalId: `TEST-${provider}-template`,
    sessionId: `TEST-${provider}-template`,
    generation: 0,
    configRevision: `TEST-${provider}-config`,
    cwd: join(base.root, 'workspace'),
    accountBinding: `TEST-${provider}-localhost-only`,
    limits: { ...claude.limits },
  });
  const codex = {
    ...common('codex'),
    provider: 'codex' as const,
    protocolRevision: '0.162.0' as const,
    model: 'mock-model',
    environment: codexEnvironment,
    executable: { path: options.codexPath, sha256: codeXHash },
    nativeOptions: {
      approvalPolicy: 'never' as const,
      sandbox: 'workspace-write' as const,
      modelProvider: 'TEST_fixture',
      developerInstructions: codexContext,
    },
  };
  const opencode = {
    ...common('opencode'),
    provider: 'opencode' as const,
    protocolRevision: '1.19.4' as const,
    endpoint: options.openCodeEndpoint,
    model: 'TEST-model',
    executable: { path: options.openCodePath, sha256: openCodeHash },
    environment: {
      ...(await environment('opencode')),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        autoupdate: false,
        share: 'disabled',
        enabled_providers: ['TEST-local'],
        model: 'TEST-local/TEST-model',
        small_model: 'TEST-local/TEST-model',
        permission: { '*': 'deny', bash: 'allow' },
        agent: {
          title: { disable: true },
          summary: { disable: true },
          'TEST-member': { mode: 'primary' },
        },
        compaction: { auto: false },
        provider: {
          'TEST-local': {
            npm: '@ai-sdk/openai-compatible',
            name: 'TEST fixture',
            options: {
              baseURL: options.models.opencode.url + '/v1',
              apiKey: 'TEST-LOCALHOST-ONLY',
            },
            models: {
              'TEST-model': { name: 'TEST-model', limit: { context: 200000, output: 2000 } },
            },
          },
        },
      }),
      OPENCODE_DISABLE_MODELS_FETCH: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_TELEMETRY: '1',
      OPENCODE_DISABLE_SHARE: '1',
      NO_COLOR: '1',
    },
    nativeOptions: {
      providerId: 'TEST-local',
      agent: 'TEST-member',
      instructions: openCodeContext,
    },
  };
  profile.runtime!.providerTemplates!.push(codex, opencode);
  const descriptor = record(JSON.parse(await readFile(base.descriptorPath, 'utf8')));
  assert.ok(Array.isArray(descriptor.management) && descriptor.management.length === 1);
  const selected = record(descriptor.management[0]);
  const management: NonNullable<TeamHostProfile['management']> = [
    {
      provider: 'codex',
      protocolRevision: '0.162.0',
      profileId: `${profile.owner.profileId}:codex`,
      accountBinding: codex.accountBinding,
      configRevision: 'TEST-codex-management',
      cwd: codex.cwd,
      environment: codex.environment,
      executable: codex.executable,
      modelProvider: codex.nativeOptions.modelProvider,
      timeoutMs: 15000,
      modelProbeTimeoutMs: 30000,
    },
    {
      provider: 'opencode',
      profileId: `${profile.owner.profileId}:opencode`,
      accountBinding: opencode.accountBinding,
      configRevision: 'TEST-opencode-management',
      cwd: opencode.cwd,
      environment: opencode.environment,
      executable: opencode.executable,
      endpoint: opencode.endpoint,
      timeoutMs: 15000,
      modelProbeTimeoutMs: 30000,
    },
  ];
  for (const item of management) {
    profile.management!.push(item);
    descriptor.management.push({
      ...selected,
      runtimeId: item.provider,
      profileId: item.profileId,
      configRevision: item.configRevision,
    });
  }
  const profileBytes = JSON.stringify(profile);
  await writeFile(base.profilePath, profileBytes, { mode: 0o600 });
  readTeamHostProfile(base.profilePath, digest(profileBytes));
  assert.ok(Array.isArray(descriptor.owners) && descriptor.owners.length === 1);
  const ownerProfile = record(record(descriptor.owners[0]).profile);
  ownerProfile.env = {
    ...record(ownerProfile.env),
    LEGACY_AGENT_HOST_PROFILE_SHA256: digest(profileBytes),
  };
  const descriptorBytes = JSON.stringify(descriptor);
  await writeFile(base.descriptorPath, descriptorBytes, { mode: 0o600 });
  return {
    ...base,
    pins: {
      ...base.pins,
      profileSha256: digest(profileBytes),
      descriptorSha256: digest(descriptorBytes),
    },
    appEnvironment: desktopBackendEnvironment(
      base.root,
      base.node,
      base.descriptorPath,
      digest(descriptorBytes)
    ),
  };
}

/** Reserve an owned ephemeral listener, then let only the captured native server claim it. */
export async function reserveMixedOpenCodeEndpoint() {
  const reservation = createServer();
  await new Promise<void>((done, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', done);
  });
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  const endpoint = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((done, reject) =>
    reservation.close((error) => (error ? reject(error) : done()))
  );
  return endpoint;
}
