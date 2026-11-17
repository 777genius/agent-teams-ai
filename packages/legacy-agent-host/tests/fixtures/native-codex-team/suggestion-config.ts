import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CodexMemberProfile } from '../../../dist/composition/runtimeProfile.js';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const digestFile = async (path: string) => {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest('hex');
};

/** Reuse the original finite CI inventory; never resolve Codex from ambient PATH. */
export async function readCodexSuggestionInputs() {
  assert.equal(process.platform, 'darwin');
  assert.equal(process.arch, 'arm64');
  const supplied = process.env.LEGACY_CODEX_CANDIDATE_INPUTS;
  assert.ok(supplied);
  assert.match(
    supplied,
    /^\/private\/tmp\/TEST-stage1-inputs-[^/]+\/codex-0\.169\.0\/input-pins\.json$/u
  );
  assert.equal(await realpath(supplied), supplied);
  const stage = dirname(supplied),
    stageInfo = await lstat(stage);
  assert.ok(stageInfo.isDirectory() && (stageInfo.mode & 0o777) === 0o700);
  assert.equal(stageInfo.uid, process.getuid?.());
  const bytes = await readFile(supplied);
  assert.ok(bytes.byteLength <= 256 * 1024);
  const pins = record(JSON.parse(bytes.toString('utf8')));
  assert.equal(pins.kind, 'TEST_CODEX_CANDIDATE_INPUTS_V1');
  assert.equal(pins.version, '0.169.0');
  assert.equal(pins.target, 'aarch64-apple-darwin');
  const archive = {
    name: 'codex-npm-darwin-arm64-0.169.0.tgz',
    bytes: 153831622,
    sha256: 'd67d443253294438a21fde15753d7c1174e6a32147d842eb84428479d664c93d',
  };
  assert.deepEqual(pins.archive, archive);
  assert.equal((await lstat(join(stage, archive.name))).size, archive.bytes);
  assert.equal(await digestFile(join(stage, archive.name)), archive.sha256);
  assert.ok(Array.isArray(pins.files) && pins.files.length > 0 && pins.files.length <= 512);
  const files = pins.files.map(record);
  const manifestSha256 = createHash('sha256').update(bytes).digest('hex');
  const verify = async () => {
    assert.equal(await digestFile(supplied), manifestSha256);
    for (const row of files) {
      assert.ok(
        typeof row.path === 'string' &&
          row.path.startsWith('package/') &&
          row.path.split('/').every((part) => part && part !== '.' && part !== '..') &&
          !/[\\\u0000-\u001f\u007f]/u.test(row.path)
      );
      const path = join(stage, row.path),
        info = await lstat(path);
      assert.equal(await realpath(path), path);
      assert.ok(info.isFile() && info.nlink === 1);
      assert.equal(info.size, row.bytes);
      assert.equal(info.mode & 0o777, row.mode);
      assert.equal(await digestFile(path), row.sha256);
    }
  };
  await verify();
  const binary = 'package/vendor/aarch64-apple-darwin/bin/codex';
  const selected = files.filter((row) => row.path === binary);
  assert.equal(selected.length, 1);
  assert.match(String(selected[0]!.sha256), /^[a-f0-9]{64}$/u);
  return {
    executable: { path: join(stage, binary), sha256: String(selected[0]!.sha256) },
    verify,
    manifestSha256,
  };
}

/** Fresh member-owned config; actual provider consumes the original captured profile. */
export async function createCodexSuggestionProfile(options: {
  root: string;
  node: string;
  modelUrl: string;
  executable: { path: string; sha256: string };
  teamId: string;
  memberId: string;
  principalId: string;
  sessionId: string;
}): Promise<CodexMemberProfile> {
  assert.match(options.root, /\/TEST-[^/]+(?:\/[^/]+)?$/u);
  assert.match(options.modelUrl, /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/u);
  const { root } = options;
  for (const directory of [
    'home',
    'codex-home',
    'tmp',
    'workspace',
    'xdg-config',
    'xdg-data',
    'xdg-cache',
  ])
    await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
  const environment = {
    HOME: join(root, 'home'),
    CODEX_HOME: join(root, 'codex-home'),
    TMPDIR: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_DATA_HOME: join(root, 'xdg-data'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'),
    PATH: `${dirname(options.node)}:/usr/bin:/bin`,
    SHELL: '/bin/sh',
    TEST_CODEX_FIXTURE_KEY: 'TEST-LOCALHOST-ONLY',
  };
  await writeFile(
    join(root, 'codex-home/config.toml'),
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
set = { HOME = ${JSON.stringify(environment.HOME)}, TMPDIR = ${JSON.stringify(environment.TMPDIR)}, PATH = "/usr/bin:/bin" }
[model_providers.TEST_fixture]
name = "TEST local fixture"
base_url = ${JSON.stringify(options.modelUrl + '/v1')}
env_key = "TEST_CODEX_FIXTURE_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`,
    { mode: 0o600, flag: 'wx' }
  );
  return {
    teamId: options.teamId,
    memberId: options.memberId,
    principalId: options.principalId,
    sessionId: options.sessionId,
    generation: 1,
    configRevision: 'TEST-codex-suggestions',
    provider: 'codex',
    protocolRevision: '0.169.0',
    cwd: join(root, 'workspace'),
    model: 'mock-model',
    accountBinding: `TEST-no-vendor-auth-${createHash('sha256').update(root).digest('hex')}`,
    executable: options.executable,
    environment,
    nativeOptions: {
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      modelProvider: 'TEST_fixture',
      developerInstructions: `TEST isolated original member ${options.memberId}.`,
    },
    limits: {
      queuedInputs: 2,
      inputBytes: 8192,
      outputBytes: 1_000_000,
      outputEvents: 1500,
      pendingInteractions: 2,
      timeoutMs: 40_000,
    },
  };
}
