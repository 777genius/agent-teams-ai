import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { URL } from 'node:url';

import {
  runMixedTeamSmoke,
} from '../../scripts/prove-opencode-mixed-team.mjs';

// These helpers have no application imports; Node's type stripping exercises the same
// predicates used by both paid suites without loading Vitest or any provider runtime.
async function importOfflineHelper(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  const source = fs.readFileSync(url, 'utf8').replaceAll('import.meta.url', JSON.stringify(url.href));
  const javascript = stripTypeScriptTypes(source);
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
}
const evidenceHelpers = await importOfflineHelper('../main/services/team/openCodeMixedTeamEvidence.ts');
const diagnosticsHelpers = await importOfflineHelper('../main/services/team/openCodeFullTeamProofDiagnostics.ts');

function passingProof() {
  const names = ['zai-one', 'zai-two', 'grok-one', 'grok-two'];
  const models = ['zai-coding-plan/model', 'xai/grok-test'];
  return {
    status: 'passed', cleanupConfirmed: true, models, runId: 'mixed-run',
    finalStopConfirmed: true, independentAssertionsPassed: true,
    sessions: names.map((name, i) => ({ name, model: models[i < 2 ? 0 : 1], sessionId: `session-${i}` })),
    tasks: names.map((owner, i) => ({ owner, taskId: `task-${i}` })),
    evidence: names.map((member, i) => ({ member, model: models[i < 2 ? 0 : 1], taskId: `task-${i}`,
      status: 'completed', sha256: 'a'.repeat(64), executionMarker: `EXEC:${member}:${i}-nonce` })),
    peerAcknowledgements: names.map((to, i) => ({ to, from: names[(i + 2) % 4], token: `ACK:${i}-nonce` })),
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-team-wrapper-TEST-'));
  const auth = path.join(root, 'auth.json');
  fs.writeFileSync(
    auth,
    JSON.stringify({
      'zai-coding-plan': { type: 'api', key: 'synthetic-secret' },
      xai: { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh' },
      unrelated: { type: 'api', key: 'unrelated-synthetic-secret' },
    })
  );
  fs.writeFileSync(path.join(root, 'vitest.mjs'), '// synthetic entry; never executed');
  return {
    root,
    env: {
      OPENCODE_E2E: '1',
      OPENCODE_E2E_MIXED_TEAM: '1',
      OPENCODE_E2E_ZAI_MODEL: 'zai-coding-plan/model',
      OPENCODE_E2E_SUPERGROK_MODEL: 'xai/grok-test',
      CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: process.execPath,
      CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH: process.execPath,
      OPENCODE_E2E_TEST_AUTH_PATH: auth,
    },
  };
}
function cleanup(input) {
  if (!input) return;
  fs.rmSync(path.dirname(input.env.HOME), { recursive: true, force: true });
  fs.rmSync(input.env.OPENCODE_E2E_PROOF_DIRECTORY, { recursive: true, force: true });
}

test('isolates auth/home/config and retains cleanup-confirmed proof after success', async () => {
  const { root, env } = fixture();
  let input;
  try {
    const status = await runMixedTeamSmoke({
      vitestEntryPath: path.join(root, 'vitest.mjs'),
      sourceEnv: {
        ...env,
        HOME: '/real-home',
        OPENCODE_CONFIG: '/real-config',
        ZAI_API_KEY: 'must-not-inherit',
      },
      log() {},
      preflight: async (value) => {
        input = value;
        await evidenceHelpers.assertOwnedSmokeEnvironment(value.env, 'MIXED');
        assert.deepEqual(value.requiredModels, ['zai-coding-plan/model', 'xai/grok-test']);
        assert.equal(value.projectPath, fs.realpathSync(value.projectPath));
        assert.equal(value.env.OPENCODE_E2E_OWNED_PROJECT_PATH, value.projectPath);
        assert.ok(value.env.CLAUDE_MULTIMODEL_DATA_HOME.startsWith(path.dirname(value.env.HOME)));
        assert.notEqual(value.env.CLAUDE_MULTIMODEL_DATA_HOME, value.env.HOME);
        assert.equal(value.env.OPENCODE_CONFIG, undefined);
        assert.equal(value.env.ZAI_API_KEY, undefined);
        assert.notEqual(value.env.HOME, '/real-home');
        assert.deepEqual(
          JSON.parse(fs.readFileSync(path.join(value.env.XDG_DATA_HOME, 'opencode/auth.json'))),
          {
            'zai-coding-plan': { type: 'api', key: 'synthetic-secret' },
            xai: { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh' },
          }
        );
        return { ok: true };
      },
      spawn: (_command, args, options) => {
        assert.equal(
          args.at(-1),
          'test/main/services/team/OpenCodeMixedTeamCollaboration.live.test.ts'
        );
        assert.equal(path.basename(args[args.indexOf('--config') + 1]), 'vitest.opencode-proof.config.ts');
        assert.equal(options.env.OPENCODE_E2E_MIXED_TEAM, '1');
        assert.equal(options.stdio, 'pipe');
        assert.equal(options.timeout, 30 * 60_000);
        fs.writeFileSync(
          path.join(options.env.OPENCODE_E2E_PROOF_DIRECTORY, 'proof.json'),
          JSON.stringify(passingProof())
        );
        return { status: 0 };
      },
    });
    assert.equal(status, 0);
    assert.equal(fs.existsSync(input.projectPath), true);
    assert.equal(fs.existsSync(input.env.HOME), true);
    assert.ok(fs.existsSync(path.join(input.env.OPENCODE_E2E_PROOF_DIRECTORY, 'proof.json')));
  } finally {
    cleanup(input);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails missing explicit prerequisites before launching or reading source credentials', async () => {
  const { root, env } = fixture();
  try {
    for (const key of [
      'OPENCODE_E2E_ZAI_MODEL',
      'OPENCODE_E2E_SUPERGROK_MODEL',
      'CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH',
      'CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH',
      'OPENCODE_E2E_TEST_AUTH_PATH',
    ]) {
      await assert.rejects(
        runMixedTeamSmoke({
      vitestEntryPath: path.join(root, 'vitest.mjs'),
          sourceEnv: { ...env, [key]: '' },
          preflight: () => assert.fail('must not launch'),
          spawn: () => assert.fail('must not launch'),
        })
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not count missing model or zero exit without proof as successful cleanup', async () => {
  const { root, env } = fixture();
  let input;
  try {
    const status = await runMixedTeamSmoke({
      vitestEntryPath: path.join(root, 'vitest.mjs'),
      sourceEnv: env,
      log() {},
      preflight: async (value) => {
        input = value;
        return { ok: false, reason: 'synthetic-secret' };
      },
      spawn: () => assert.fail('missing model must not fall back'),
    });
    assert.equal(status, 1);
    assert.ok(fs.existsSync(input.projectPath));
    cleanup(input);
    await assert.rejects(
      runMixedTeamSmoke({
      vitestEntryPath: path.join(root, 'vitest.mjs'),
        sourceEnv: env,
        log() {},
        preflight: async (value) => {
          input = value;
          return { ok: true };
        },
        spawn: () => ({ status: 0 }),
      })
    );
    assert.ok(fs.existsSync(input.projectPath));
  } finally {
    cleanup(input);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects external project and absent/non-OAuth SuperGrok before preflight', async () => {
  const { root, env } = fixture();
  try {
    const mustReject = (sourceEnv) =>
      assert.rejects(
        runMixedTeamSmoke({
      vitestEntryPath: path.join(root, 'vitest.mjs'),
          sourceEnv,
          log() {},
          preflight: () => assert.fail('must not launch'),
          spawn: () => assert.fail('must not launch'),
        })
      );
    await mustReject({ ...env, OPENCODE_E2E_PROJECT_PATH: root });
    for (const xai of [undefined, { type: 'api', key: 'synthetic-api-secret' }]) {
      fs.writeFileSync(
        env.OPENCODE_E2E_TEST_AUTH_PATH,
        JSON.stringify({ 'zai-coding-plan': { type: 'api', key: 'synthetic-secret' }, xai })
      );
      await mustReject(env);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('mixed wrapper requires both explicit opt-ins before credential access', async () => {
  const { root, env } = fixture();
  try {
    for (const key of ['OPENCODE_E2E', 'OPENCODE_E2E_MIXED_TEAM']) {
      await assert.rejects(runMixedTeamSmoke({
        vitestEntryPath: path.join(root, 'vitest.mjs'),
        sourceEnv: { ...env, [key]: '0', OPENCODE_E2E_TEST_AUTH_PATH: '/must-not-read' },
        preflight: () => assert.fail('must not launch'), spawn: () => assert.fail('must not launch'),
      }), /opt-in required/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mixed wrapper rejects wrong member/model/task/ACK and empty evidence despite zero exit', async () => {
  const { root, env } = fixture();
  let input;
  try {
    for (const mutate of [
      (proof) => { proof.evidence = [{}, {}, {}, {}]; },
      (proof) => { proof.evidence[0].model = 'zai-coding-plan/fallback'; },
      (proof) => { proof.evidence[0].taskId = 'foreign-task'; },
      (proof) => { proof.evidence[1] = proof.evidence[0]; },
      (proof) => { proof.sessions[1].sessionId = proof.sessions[0].sessionId; },
      (proof) => { proof.peerAcknowledgements[0].from = 'zai-two'; },
      (proof) => { proof.peerAcknowledgements[0].token += '-extra'; },
    ]) {
      await assert.rejects(runMixedTeamSmoke({
        vitestEntryPath: path.join(root, 'vitest.mjs'), sourceEnv: env, log() {},
        preflight: async (value) => { input = value; return { ok: true }; },
        spawn: (_command, _args, { env: runEnv }) => {
          const proof = passingProof(); mutate(proof);
          fs.writeFileSync(path.join(runEnv.OPENCODE_E2E_PROOF_DIRECTORY, 'proof.json'), JSON.stringify(proof));
          return { status: 0 };
        },
      }), /complete cleanup-confirmed proof/);
      assert.ok(fs.existsSync(input.env.HOME)); cleanup(input);
    }
  } finally { cleanup(input); fs.rmSync(root, { recursive: true, force: true }); }
});

function toolTranscript(name, input, output = '', overrides = {}) {
  return { data: { sessionId: 'session-1', messages: [{ role: 'assistant', providerId: 'selected',
    modelId: 'model', contentBlocks: [
      { type: 'tool_use', id: 'call-1', name, input },
      { type: 'tool_result', toolUseId: 'call-1', status: 'completed', isError: false, contentText: output },
    ], ...overrides }] } };
}

test('task completion requires the exact task, team and actor in a successful canonical tool', () => {
  const { successfulTools, hasTaskCompletion } = evidenceHelpers;
  const input = { teamName: 'test-team', taskId: 'task-1', actor: 'alice' };
  assert.equal(hasTaskCompletion(successfulTools(toolTranscript('agent-teams_task_complete', input)), 'test-team', 'task-1', 'alice'), true);
  for (const bad of [
    { ...input, taskId: 'task-10', note: 'task-1' },
    { ...input, teamName: 'foreign-team' }, { ...input, actor: 'bob' },
    { note: JSON.stringify(input) },
  ]) assert.equal(hasTaskCompletion(successfulTools(toolTranscript('agent-teams_task_complete', bad)), 'test-team', 'task-1', 'alice'), false);
  assert.equal(hasTaskCompletion(successfulTools(toolTranscript('fake_task_complete_suffix', input)), 'test-team', 'task-1', 'alice'), false);
  const failed = toolTranscript('agent-teams_task_complete', input);
  failed.data.messages[0].contentBlocks[1].isError = true;
  assert.equal(hasTaskCompletion(successfulTools(failed), 'test-team', 'task-1', 'alice'), false);
});

test('ACK proof checks exact sender, recipient and payload rather than incidental strings', () => {
  const { successfulTools, hasMessage } = evidenceHelpers;
  const input = { teamName: 'test-team', from: 'alice', to: 'bob', text: 'ACK:nonce' };
  const accepted = (name, args) => hasMessage(successfulTools(toolTranscript(name, args)), 'test-team', 'alice', 'bob', 'ACK:nonce');
  assert.equal(accepted('mcp__agent-teams__message_send', input), true);
  for (const bad of [
    { ...input, text: 'ACK:nonce-extra' }, { ...input, to: 'user' },
    { ...input, from: 'bob' }, { ...input, teamName: 'foreign-team' },
    { ...input, text: 'unrelated', summary: 'ACK:nonce' },
  ]) assert.equal(accepted('agent-teams_message_send', bad), false);
  assert.equal(accepted('fake_message_send', input), false);
});

test('execution markers cannot come from user echoes, tool names or longer output lines', () => {
  const { successfulTools, hasExecution } = evidenceHelpers;
  assert.equal(hasExecution(successfulTools(toolTranscript('bash', { command: 'node test.cjs' }, 'preamble\r\nEXEC:nonce\r\n')), 'EXEC:nonce'), true);
  for (const raw of [
    toolTranscript('fake_bash_tool', {}, 'EXEC:nonce'),
    toolTranscript('bash', {}, 'command: echo EXEC:nonce'),
    toolTranscript('bash', {}, 'EXEC:nonce-extra'),
    toolTranscript('bash', {}, 'EXEC:nonce', { role: 'user' }),
  ]) assert.equal(hasExecution(successfulTools(raw), 'EXEC:nonce'), false);
});

test('model and session proof reject missing attribution, stale sessions and mixed inference', () => {
  const { assertTranscriptModel, assertTranscriptSession } = evidenceHelpers;
  const transcript = toolTranscript('bash', {}, 'proof');
  assert.doesNotThrow(() => assertTranscriptModel(transcript, 'selected/model'));
  assert.doesNotThrow(() => assertTranscriptSession(transcript, 'session-1'));
  assert.throws(() => assertTranscriptSession(transcript, 'stale-session'));
  for (const added of [
    { role: 'assistant', contentBlocks: [] },
    { role: 'assistant', providerId: 'selected', modelId: 'fallback' },
  ]) assert.throws(() => assertTranscriptModel({ data: { ...transcript.data, messages: [...transcript.data.messages, added] } }, 'selected/model'));
  assert.throws(() => assertTranscriptSession({ data: { messages: transcript.data.messages } }, 'session-1'));
  transcript.data.messages[0].sessionId = 'another-session';
  assert.throws(() => assertTranscriptSession(transcript, 'session-1'));
});

test('Stop proof rejects empty snapshots, missing members and unrelated runs', () => {
  const { assertStoppedSnapshot } = evidenceHelpers;
  const snapshot = { runId: 'run-1', members: { alice: { alive: false }, bob: { alive: false } } };
  assert.doesNotThrow(() => assertStoppedSnapshot(snapshot, 'run-1', ['alice', 'bob']));
  assert.doesNotThrow(() => assertStoppedSnapshot({ ...snapshot, runId: null }, 'run-1', ['alice', 'bob']));
  for (const bad of [null, {}, { ...snapshot, members: {} },
    { ...snapshot, runId: 'other-run' }, { ...snapshot, members: { alice: { alive: false } } },
    { ...snapshot, members: { alice: { alive: false }, bob: { alive: true } } },
  ]) assert.throws(() => assertStoppedSnapshot(bad, 'run-1', ['alice', 'bob']));
});

test('partial harness setup closes its owned resource and redacts setup/close failures', async () => {
  const { closeOnSetupFailure } = evidenceHelpers;
  let closes = 0;
  const resource = { close: async () => { closes++; } };
  const value = await closeOnSetupFailure(resource, async () => 'ready');
  assert.equal(value, 'ready'); assert.equal(closes, 0);
  await assert.rejects(closeOnSetupFailure(resource, async () => { throw new Error('synthetic-provider-secret'); }),
    (error) => error.message === 'Owned control API setup failed');
  assert.equal(closes, 1);
  await assert.rejects(closeOnSetupFailure({ close: async () => { throw new Error('synthetic-close-secret'); } },
    async () => { throw new Error('synthetic-provider-secret'); }),
  (error) => error.message === 'Owned control API setup failed; close not confirmed');
});

test('diagnostics tolerate cyclic/non-JSON errors and omit raw delivery details', () => {
  const { classifyFailure } = diagnosticsHelpers;
  const circular = {}; circular.self = circular;
  for (const value of [circular, 1n, { toJSON() { throw new Error('synthetic-secret'); } }]) {
    assert.equal(classifyFailure(value), 'unclassified');
  }
  const metadata = evidenceHelpers.relayMetadata({ attempted: 1, lastDelivery: {
    reason: 'synthetic-secret', ledgerStatus: 'accepted', accepted: true, acceptanceUnknown: true,
  } });
  assert.equal(JSON.stringify(metadata).includes('synthetic-secret'), false);
  assert.equal(metadata.acceptanceUnknown, true);
  assert.equal(metadata.terminalFailure, false);
});

test('mixed timeout never retries uncertain provider effects or prints raw errors', async () => {
  const { root, env } = fixture();
  let input, spawns = 0;
  const logs = [];
  try {
    await assert.rejects(runMixedTeamSmoke({
      vitestEntryPath: path.join(root, 'vitest.mjs'), sourceEnv: env,
      log(message) { logs.push(message); },
      preflight: async (value) => { input = value; return { ok: true }; },
      spawn: () => { spawns++; return { status: null, error: new Error('synthetic-provider-secret') }; },
    }), /Live test process failed; inspect owned state/);
    assert.equal(spawns, 1);
    assert.equal(logs.join('\n').includes('synthetic-provider-secret'), false);
    assert.ok(fs.existsSync(input.env.HOME));
  } finally { cleanup(input); fs.rmSync(root, { recursive: true, force: true }); }
});

test('failed proof persistence still resets process-wide Claude path isolation', async () => {
  let resets = 0;
  await assert.rejects(evidenceHelpers.finalizeProof(
    async () => { throw new Error('synthetic-write-failure'); }, () => { resets++; }
  ), /synthetic-write-failure/);
  assert.equal(resets, 1);
  await evidenceHelpers.finalizeProof(async () => {}, () => { resets++; });
  assert.equal(resets, 2);
});

// Opaque custody fixtures deliberately model no runtime authority or admission rules.
function custodySnapshot(target) {
  const stat = fs.lstatSync(target);
  return { mode: stat.mode, ino: stat.ino, dev: stat.dev,
    contents: stat.isDirectory()
      ? Object.fromEntries(fs.readdirSync(target).sort().map((name) => [name, custodySnapshot(path.join(target, name))]))
      : fs.readFileSync(target).toString('base64') };
}

for (const raw of ['unchanged', 'rotated', 'missing', 'malformed', 'empty']) {
  for (const outcome of ['passed', 'preflight-failed', 'preflight-threw', 'child-failed', 'child-threw',
    'terminated', 'missing-proof', 'cleanup-missing', 'stop-missing']) {
    test(`Mixed OAuth custody: ${raw}, ${outcome}`, async () => {
      const { root, env } = fixture();
      const store = JSON.parse(fs.readFileSync(env.OPENCODE_E2E_TEST_AUTH_PATH, 'utf8'));
      store.xai = { type: 'oauth', access: 'synthetic-C0', refresh: 'synthetic-refresh' };
      const original = JSON.stringify(store);
      fs.writeFileSync(env.OPENCODE_E2E_TEST_AUTH_PATH, original);

      let input, before, projectBefore, spawns = 0;
      const logs = [];
      const stage = (value) => {
        input = value;
        const runEnv = value.env;
        for (const [key, name] of [
          ['XDG_DATA_HOME', 'sidecar'], ['XDG_STATE_HOME', 'receipt'], ['HOME', 'nativehistory'],
          ['CLAUDE_MULTIMODEL_DATA_HOME', 'fence'], ['CLAUDE_MULTIMODEL_CACHE_HOME', 'ledger'],
          ['TMPDIR', 'profiles'],
        ]) fs.writeFileSync(path.join(runEnv[key], name), `opaque-synthetic-${name}\0`, { mode: 0o600 });
        fs.writeFileSync(path.join(value.projectPath, 'identity'), 'synthetic-project', { mode: 0o600 });
        const auth = path.join(runEnv.XDG_DATA_HOME, 'opencode/auth.json');
        if (raw === 'missing') fs.unlinkSync(auth);
        if (raw === 'malformed') fs.writeFileSync(auth, '{synthetic-invalid');
        if (raw === 'empty') fs.writeFileSync(auth, '{}');
        if (raw === 'rotated') {
          const selected = JSON.parse(fs.readFileSync(auth, 'utf8'));
          selected.xai.refresh = 'synthetic-rotated';
          fs.writeFileSync(auth, JSON.stringify(selected));
        }
        before = custodySnapshot(runEnv.OPENCODE_E2E_OWNED_ROOT);
        projectBefore = custodySnapshot(value.projectPath);
      };
      try {
        const run = runMixedTeamSmoke({ sourceEnv: env, vitestEntryPath: path.join(root, 'vitest.mjs'),
          log: (message) => logs.push(message),
          preflight: async (value) => {
            stage(value);
            if (outcome === 'preflight-threw') throw new Error('synthetic-preflight-error');
            return { ok: outcome !== 'preflight-failed' };
          },
          spawn: () => {
            spawns++;
            if (outcome === 'child-threw') throw new Error('synthetic-child-error');
            if (outcome !== 'missing-proof') {
              const proof = passingProof();
              if (outcome === 'cleanup-missing') delete proof.cleanupConfirmed;
              if (outcome === 'stop-missing') delete proof.finalStopConfirmed;
              fs.writeFileSync(path.join(input.env.OPENCODE_E2E_PROOF_DIRECTORY, 'proof.json'), JSON.stringify(proof));
            }
            return { status: outcome === 'child-failed' ? 7 : outcome === 'terminated' ? null : 0,
              stderr: 'synthetic-provider-error' };
          },
        });
        if (['preflight-threw', 'child-threw', 'missing-proof', 'cleanup-missing', 'stop-missing'].includes(outcome))
          await assert.rejects(run);
        else assert.equal(await run, outcome === 'passed' ? 0 : outcome === 'child-failed' ? 7 : 1);
        assert.equal(spawns, outcome.startsWith('preflight-') ? 0 : 1);
        assert.deepEqual(custodySnapshot(input.env.OPENCODE_E2E_OWNED_ROOT), before);
        assert.deepEqual(custodySnapshot(input.projectPath), projectBefore);
        if (process.platform !== 'win32') {
          assert.equal(before.mode & 0o777, 0o700);
          assert.equal(before.contents['.opencode-proof-owned.json'].mode & 0o777, 0o600);
          assert.equal(projectBefore.mode & 0o777, 0o700);
          assert.equal(projectBefore.contents['.opencode-proof-project.json'].mode & 0o777, 0o600);
        }
        assert.equal(fs.readFileSync(env.OPENCODE_E2E_TEST_AUTH_PATH, 'utf8'), original);
        assert.doesNotMatch(logs.join('\n'), /synthetic|handoff|exported|valid|reusable|Rotated selected auth/i);
        if (outcome === 'passed') {
          assert.ok(logs.some((line) => line.includes(`owned OAuth state retained: ${input.env.OPENCODE_E2E_OWNED_ROOT}, project ${input.projectPath}`)));
        } else assert.ok(logs.some((line) => line.startsWith('Smoke failed;')));

      } finally {
        if (input) fs.rmSync(input.projectPath, { recursive: true, force: true });
        cleanup(input); fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
