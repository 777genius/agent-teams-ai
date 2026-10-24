import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { record } from '../native-claude-team/model.ts';
import {
  CAPTURE_TURN,
  CAPTURE_ASSIGNMENT,
  CAPTURE_BEFORE,
  CAPTURE_AFTER,
  CONTEXT_MARKER,
  startOpenCodeModel,
} from './model.ts';
import type { NativeCaptureFixture } from '../native-input-capture.ts';

/** Native 1.19.4 profile from the retained real read/edit metadata probe. */
export const opencodeCaptureFixture: NativeCaptureFixture = {
  provider: 'opencode',
  memberName: 'carol',
  goFlag: 'LEGACY_NATIVE_OPENCODE_CAPTURE_GO',
  binaryEnv: 'LEGACY_NATIVE_OPENCODE_PATH',
  binarySha256: '417af53923f3d529759ab85ce3e8dd09116f742efcd332de591d2da6ebae696b',
  turn: CAPTURE_TURN,
  assignmentTurn: CAPTURE_ASSIGNMENT,
  before: CAPTURE_BEFORE,
  after: CAPTURE_AFTER,
  steps: 3,
  taskStatus: 'in_progress',
  sources: [
    'tests/native-opencode-capture.native.ts',
    'tests/fixtures/native-opencode-team/model.ts',
    'tests/fixtures/native-opencode-team/capture.ts',
  ],
  startModel: (options) => startOpenCodeModel({ captureFileUpdate: options }),
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
    const nativeConfig = {
      autoupdate: false,
      share: 'disabled',
      enabled_providers: ['TEST-local'],
      model: 'TEST-local/TEST-model',
      small_model: 'TEST-local/TEST-model',
      permission: { '*': 'deny', read: 'allow', edit: 'allow' },
      agent: {
        title: { disable: true },
        summary: { disable: true },
        'TEST-member': { mode: 'primary' },
      },
      compaction: { auto: false },
      provider: {
        'TEST-local': {
          npm: '@ai-sdk/openai-compatible',
          name: 'TEST local',
          options: { baseURL: `${modelUrl}/v1`, apiKey: 'TEST-LOCALHOST-ONLY' },
          models: {
            'TEST-model': { name: 'TEST-model', limit: { context: 200000, output: 2000 } },
          },
        },
      },
    };
    const reservation = createServer();
    await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
    const address = reservation.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((done) => reservation.close(() => done()));
    return {
      teamId,
      memberId,
      principalId,
      provider: 'opencode',
      protocolRevision: '1.19.4',
      sessionId,
      generation: 1,
      configRevision: 'TEST-config-1',
      cwd: workspace,
      model: 'TEST-model',
      endpoint,
      accountBinding: 'TEST-dummy-account',
      executable: native,
      environment: {
        ...environment,
        XDG_CONFIG_HOME: join(root, 'xdg-config'),
        XDG_DATA_HOME: join(root, 'xdg-data'),
        XDG_CACHE_HOME: join(root, 'xdg-cache'),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(nativeConfig),
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_TELEMETRY: '1',
        OPENCODE_DISABLE_SHARE: '1',
        NO_COLOR: '1',
      },
      nativeOptions: {
        providerId: 'TEST-local',
        agent: 'TEST-member',
        instructions: `${CONTEXT_MARKER}. You are carol of test-native-capture working only in ${workspace}.`,
      },
      limits: {
        queuedInputs: 2,
        inputBytes: 8192,
        outputBytes: 1_000_000,
        outputEvents: 1500,
        pendingInteractions: 4,
        timeoutMs: 45_000,
      },
    };
  },
  assertNativeEvent(event) {
    const binding = record(event.causalBinding),
      cause = record(binding.native),
      proof = record(event.nativeCaptureProof);
    assert.equal(binding.toolName, 'opencode.fileChange');
    assert.equal(cause.provider, 'opencode');
    assert.equal(proof.kind, 'opencode-update-patch-v1');
    for (const key of ['nativeSessionId', 'nativeInputId', 'windowRef']) {
      assert.equal(typeof proof[key], 'string');
      assert.ok(proof[key]);
      assert.equal(cause[key], proof[key]);
    }
    assert.match(String(proof.nativeSessionId), /^ses_/);
    assert.match(String(proof.nativeInputId), /^msg_/);
    assert.ok(Array.isArray(proof.tools));
    assert.equal(proof.tools.length, 1);
    assert.deepEqual(cause.tools, proof.tools);
    const tool = record(proof.tools[0]);
    assert.match(String(tool.messageId), /^msg_/);
    assert.match(String(tool.partId), /^prt_/);
    assert.notEqual(tool.messageId, proof.nativeInputId);
    assert.equal(tool.callId, `TEST_${CAPTURE_TURN}_1`);
    assert.equal(event.toolUseId, tool.callId);
  },
};
