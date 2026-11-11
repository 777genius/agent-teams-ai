import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DIRECT_SHELL_EFFECT_FILE, DIRECT_SHELL_EXPECTED,
  probeNativeDirectShellEffect } from './opencode-v2-direct-shell-probe.mjs';

const rules = [
  { action: 'shell', resource: '*', effect: 'allow' },
  { action: 'external_directory', resource: '*', effect: 'deny' },
];
function fake({ status = 204, foreign = false, foreignAfterShell = false,
                unreadableAfterShell = false, throwOnShell = false,
                cleanupStatus = 204 } = {}) {
  const calls = [];
  const base = '/api/session/ses_TEST_direct_shell';
  async function call(path, method = 'GET', body) {
    calls.push({ path, method, body });
    if (path === '/api/session' && method === 'POST')
      return { status: 200, data: { data: { id: 'ses_TEST_direct_shell' } } };
    if (path === base && method === 'GET') {
      const afterMutation = calls.some(x => x.path === base + '/shell' && x.method === 'POST');
      if (afterMutation && unreadableAfterShell) throw Error('TEST_postmutation_readback_lost');
      return { status: 200, data: { data: {
        id: foreign || (afterMutation && foreignAfterShell)
          ? 'ses_FOREIGN' : 'ses_TEST_direct_shell',
        location: { directory: '/TEST/workspace' }, permissions: rules,
      } } };
    }
    if (path === base + '/shell' && method === 'POST') {
      if (throwOnShell) throw Error('TEST_lost_mutation_ack');
      return { status };
    }
    if (path === base && method === 'DELETE') return { status: cleanupStatus };
    throw Error('TEST_unexpected_native_call');
  }
  return { call, calls };
}
function counted(calls, suffix, method = 'POST') {
  return calls.filter(item => item.path.endsWith(suffix) && item.method === method).length;
}
test('one owned direct shell file effect is not a model/tool authorization certificate', async () => {
  const { call, calls } = fake();
  const result = await probeNativeDirectShellEffect(
    call, '/TEST/workspace', async file => {
      assert.equal(file, DIRECT_SHELL_EFFECT_FILE);
      return calls.some(x => x.path.endsWith('/shell') && x.method === 'POST')
        ? DIRECT_SHELL_EXPECTED : undefined;
    });
  assert.deepEqual(result, { attempted: true, outcome: 'effect-confirmed', status: 204,
    responseUncertain: false, modelTurnProven: false,
    toolPermissionEnforcementProven: false });
  assert.equal(counted(calls, '/shell'), 1);
  assert.equal(counted(calls, '/ses_TEST_direct_shell', 'DELETE'), 1);
  assert.match(calls.find(x => x.path.endsWith('/shell')).body.command, /TEST_V2_NATIVE_DIRECT_SHELL_EFFECT/);
});
test('unsupported direct shell endpoint is HOLD with no mutation replay', async () => {
  const { call, calls } = fake({ status: 404 });
  const result = await probeNativeDirectShellEffect(call, '/TEST/workspace', async () => undefined);
  assert.equal(result.outcome, 'hold');
  assert.equal(result.status, 404);
  assert.equal(result.modelTurnProven, false);
  assert.equal(counted(calls, '/shell'), 1);
  assert.equal(counted(calls, '/ses_TEST_direct_shell', 'DELETE'), 1);
});
test('success without an actual file effect is HOLD, not fabricated proof', async () => {
  const { call, calls } = fake();
  let reads = 0;
  const result = await probeNativeDirectShellEffect(call, '/TEST/workspace',
    async () => { reads++; return undefined; }, async () => {});
  assert.equal(reads, 13, 'one preflight absence and twelve read-only post-mutation checks');
  assert.equal(result.outcome, 'hold');
  assert.equal(counted(calls, '/shell'), 1);
});
test('uncertain HTTP ACK remains HOLD even if the TEST file was written', async () => {
  const { call, calls } = fake({ throwOnShell: true });
  const result = await probeNativeDirectShellEffect(call, '/TEST/workspace',
    async () => calls.some(x => x.path.endsWith('/shell') && x.method === 'POST')
      ? DIRECT_SHELL_EXPECTED : undefined);
  assert.equal(result.outcome, 'hold');
  assert.equal(result.responseUncertain, true);
  assert.equal(result.status, null);
  assert.equal(counted(calls, '/shell'), 1);
  assert.equal(counted(calls, '/ses_TEST_direct_shell', 'DELETE'), 1);
});
test('foreign-session native readback refuses shell mutation but cleans once', async () => {
  const { call, calls } = fake({ foreign: true });
  await assert.rejects(probeNativeDirectShellEffect(call, '/TEST/workspace',
    async () => DIRECT_SHELL_EXPECTED), /TEST_direct_shell_session_not_owned/);
  assert.equal(counted(calls, '/shell'), 0);
  assert.equal(counted(calls, '/ses_TEST_direct_shell', 'DELETE'), 1);
});
test('unexpected workspace contents never count as successful direct shell', async () => {
  const { call, calls } = fake();
  await assert.rejects(probeNativeDirectShellEffect(call, '/TEST/workspace',
    async () => calls.some(x => x.path.endsWith('/shell') && x.method === 'POST')
      ? 'FORGED' : undefined), /TEST_direct_shell_unexpected_file_effect/);
  assert.equal(counted(calls, '/shell'), 1);
  assert.equal(counted(calls, '/ses_TEST_direct_shell', 'DELETE'), 1);
});
test('uncertain cleanup is an error even after native shell success', async () => {
  const { call, calls } = fake({ cleanupStatus: 503 });
  await assert.rejects(probeNativeDirectShellEffect(call, '/TEST/workspace',
    async () => calls.some(x => x.path.endsWith('/shell') && x.method === 'POST')
      ? DIRECT_SHELL_EXPECTED : undefined), /TEST_direct_shell_session_cleanup_unconfirmed/);
  assert.equal(counted(calls, '/shell'), 1);
  assert.equal(counted(calls, '/ses_TEST_direct_shell', 'DELETE'), 1);
});

test('a preexisting marker cannot counterfeit a fresh native shell effect', async () => {
  const { call, calls } = fake();
  await assert.rejects(probeNativeDirectShellEffect(call, '/TEST/workspace',
    async () => DIRECT_SHELL_EXPECTED), /TEST_direct_shell_stale_effect_preexisting/);
  assert.equal(counted(calls, '/shell'), 0);
  assert.equal(counted(calls, '/ses_TEST_direct_shell', 'DELETE'), 1);
});

// False attestation guard: same TEST file is insufficient if the native
// session has changed identity after the one authorized shell submission.
test('post-mutation foreign session never qualifies an observed file effect', async () => {
  const { call, calls } = fake({ foreignAfterShell: true });
  const result = await probeNativeDirectShellEffect(call, '/TEST/workspace',
    async () => calls.some(x => x.path.endsWith('/shell') && x.method === 'POST')
      ? DIRECT_SHELL_EXPECTED : undefined);
  assert.equal(result.outcome, 'hold');
  assert.equal(counted(calls, '/shell'), 1);
  assert.equal(counted(calls, '/ses_TEST_direct_shell', 'GET'), 2);
  assert.equal(counted(calls, '/ses_TEST_direct_shell', 'DELETE'), 1);
});

test('post-mutation unreadable session remains HOLD, without retry', async () => {
  const { call, calls } = fake({ unreadableAfterShell: true });
  const result = await probeNativeDirectShellEffect(call, '/TEST/workspace',
    async () => calls.some(x => x.path.endsWith('/shell') && x.method === 'POST')
      ? DIRECT_SHELL_EXPECTED : undefined);
  assert.equal(result.outcome, 'hold');
  assert.equal(counted(calls, '/shell'), 1);
  assert.equal(counted(calls, '/ses_TEST_direct_shell', 'GET'), 2);
  assert.equal(counted(calls, '/ses_TEST_direct_shell', 'DELETE'), 1);
});
