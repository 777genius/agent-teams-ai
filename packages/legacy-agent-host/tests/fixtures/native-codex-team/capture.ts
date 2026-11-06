import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CAPTURE_TURN,
  CAPTURE_ASSIGNMENT,
  CAPTURE_BEFORE,
  CAPTURE_AFTER,
  CAPTURE_FAILED_AFTER,
  CONTEXT_MARKER,
  record,
  startCodexModel,
} from './model.ts';
import { assertFailedToolCapture, type NativeCaptureFixture } from '../native-input-capture.ts';

const createCaptureFixture = (failedShell = false): NativeCaptureFixture => ({
  failedShell,
  provider: 'codex',
  memberName: 'bob',
  goFlag: failedShell ? 'LEGACY_NATIVE_CODEX_FAILED_CAPTURE_GO' : 'LEGACY_NATIVE_CODEX_CAPTURE_GO',
  binaryEnv: 'LEGACY_NATIVE_CODEX_PATH',
  binarySha256: '8238273076041e55beded03ba1d51e034f997b7d100b0642d36daf036620fe57',
  turn: CAPTURE_TURN,
  assignmentTurn: CAPTURE_ASSIGNMENT,
  before: CAPTURE_BEFORE,
  after: failedShell ? CAPTURE_FAILED_AFTER : CAPTURE_AFTER,
  steps: failedShell ? 4 : 5,
  taskStatus: 'completed',
  sources: [
    'tests/native-codex-capture.native.ts',
    'tests/fixtures/native-codex-team/model.ts',
    'tests/fixtures/native-codex-team/capture.ts',
  ],
  startModel: (options) => startCodexModel({ captureFileUpdate: { ...options, failedShell } }),
  async memberProfile({
    root,
    workspace,
    modelUrl,
    native,
    teamId,
    memberId,
    principalId,
    sessionId,
    environment,
  }) {
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
set = { HOME = ${JSON.stringify(join(root, 'home'))}, TMPDIR = ${JSON.stringify(join(root, 'tmp'))}, PATH = "/usr/bin:/bin" }
[model_providers.TEST_fixture]
name = "TEST local fixture"
base_url = ${JSON.stringify(modelUrl + '/v1')}
env_key = "TEST_CODEX_FIXTURE_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`,
      { mode: 0o600 }
    );

    return {
      teamId,
      memberId,
      principalId,
      provider: 'codex',
      protocolRevision: '0.162.0',
      sessionId,
      generation: 1,
      configRevision: 'TEST-config-1',
      cwd: workspace,
      model: 'mock-model',
      accountBinding: 'TEST-dummy-account',
      executable: native,
      environment: {
        ...environment,
        CODEX_HOME: join(root, 'codex-home'),
        XDG_CONFIG_HOME: join(root, 'xdg-config'),
        XDG_DATA_HOME: join(root, 'xdg-data'),
        XDG_CACHE_HOME: join(root, 'xdg-cache'),
        TEST_CODEX_FIXTURE_KEY: 'TEST-LOCALHOST-ONLY',
      },
      nativeOptions: {
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        modelProvider: 'TEST_fixture',
        developerInstructions: `${CONTEXT_MARKER}. You are bob of test-native-capture working only in ${workspace}.`,
      },
      limits: {
        queuedInputs: 2,
        inputBytes: 8192,
        outputBytes: 1_000_000,
        outputEvents: 1500,
        pendingInteractions: 4,
        timeoutMs: failedShell ? 180_000 : 45_000,
      },
    };
  },
  assertNativeEvent(event) {
    if (failedShell) {
      const cause = assertFailedToolCapture(event, 'codex', CAPTURE_BEFORE, CAPTURE_FAILED_AFTER);
      assert.equal(cause.inputOutcome, 'completed');
      assert.equal(event.toolUseId, 'native_' + CAPTURE_TURN + '_1');
      assert.equal(cause.itemId, event.toolUseId);
      for (const key of ['threadId', 'turnId', 'windowRef'])
        assert.ok(typeof cause[key] === 'string' && cause[key]);
      assert.equal(cause.status, 'failed');
      return;
    }
    const cause = record(record(event.causalBinding).native),
      proof = record(event.nativeCaptureProof);
    assert.equal(cause.provider, 'codex');
    assert.equal(proof.kind, 'codex-update-patch-v1');
    for (const key of ['threadId', 'turnId', 'windowRef']) {
      assert.equal(typeof proof[key], 'string');
      assert.ok(proof[key]);
      assert.equal(cause[key], proof[key]);
    }
    assert.deepEqual(proof.itemIds, ['native_' + CAPTURE_TURN + '_2']);
    assert.deepEqual(cause.itemIds, proof.itemIds);
    assert.equal(event.toolUseId, (proof.itemIds as string[]).at(-1));
  },
});

export const codexCaptureFixture = createCaptureFixture();
export const codexFailedShellCaptureFixture = createCaptureFixture(true);
