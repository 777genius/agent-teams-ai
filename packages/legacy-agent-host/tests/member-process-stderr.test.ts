import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { observeMemberProcessStderr } from '../dist/adapters/providers/observeMemberProcessStderr.js';
import type { RuntimeProcessOutput } from '../dist/runtime/providerActivityContracts.js';

function fixture() {
  const child = Object.assign(new ChildProcess(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
  const observations: RuntimeProcessOutput[] = [];
  const context = {
    endpoint: { bearerToken: 'TEST_TEAM_PRIVATE_CANARY' },
    profile: {
      environment: { TEST_PRIVATE_KEY: 'TEST_ENV_FIRST_CANARY\nTEST_ENV_SECOND_CANARY', PUBLIC_PATH: '/TEST-visible' },
      capturedMcpServers: {
        selected: { type: 'http' as const, url: 'https://test.invalid/mcp',
          headers: { Authorization: 'Bearer TEST_HEADER_PRIVATE_CANARY', 'X-Private': 'TEST_CUSTOM_HEADER_CANARY' } },
        local: { type: 'stdio' as const, command: '/TEST-command',
          env: { SERVICE_PASSWORD: 'TEST_MCP_ENV_CANARY' }, args: ['--token', 'TEST_MCP_ARG_CANARY'] },
      },
    },
    observeProcessOutput: (value: RuntimeProcessOutput) => { observations.push(value); },
  };
  return { child, context, observations, attach: () => observeMemberProcessStderr(child, context,
    ['--password', 'TEST_ARG_CANARY', '--token="TEST_QUOTED_CANARY"']) };
}

test('original stderr captures startup and tail while redacting selected values across UTF-8 chunks', async () => {
  const f = fixture(); f.attach();
  const canaries = [f.context.endpoint.bearerToken, 'TEST_ENV_FIRST_CANARY', 'TEST_ENV_SECOND_CANARY',
    'TEST_HEADER_PRIVATE_CANARY', 'TEST_CUSTOM_HEADER_CANARY', 'TEST_MCP_ENV_CANARY',
    'TEST_MCP_ARG_CANARY', 'TEST_ARG_CANARY', 'TEST_QUOTED_CANARY'];
  const output = `é密😀 startup /TEST-visible\n${canaries.join('\n')}\n` +
    `TEST_TEAM_\u001b[31mPRIVATE_CANARY\u001b[0m\nfinal tail`;
  for (const byte of Buffer.from(output)) f.child.stderr.write(Buffer.from([byte]));
  f.child.stdout.write('TEST_NATIVE_PROTOCOL_CANARY');
  f.child.stdin.write('TEST_PRIVATE_INPUT_CANARY');
  const ended = once(f.child.stderr, 'end'); f.child.stderr.end(); await ended;
  f.child.emit('close', 0, null); f.child.stderr.emit('close');
  const retained = JSON.stringify(f.observations);
  for (const canary of [...canaries, 'TEST_NATIVE_PROTOCOL_CANARY', 'TEST_PRIVATE_INPUT_CANARY'])
    assert.equal(retained.includes(canary), false, canary);
  assert.deepEqual(f.observations[0], { kind: 'process-output', stream: 'stderr', text: 'é密😀 startup /TEST-visible' });
  assert.deepEqual(f.observations.at(-1), { kind: 'process-output', stream: 'stderr', text: 'final tail' });
  assert.equal(f.observations.filter(value => value.kind === 'process-output' && value.text === 'final tail').length, 1);
  assert.equal(f.child.stderr.listenerCount('data'), 0);
  assert.equal(f.child.listenerCount('close'), 0);
});

test('invalid UTF-8 and NUL are readable diagnostics, including a final incomplete sequence', async () => {
  const f = fixture(); f.attach();
  f.child.stderr.write(Buffer.from([0x61, 0x00, 0xff, 0x0a, 0xf0, 0x9f]));
  const ended = once(f.child.stderr, 'end'); f.child.stderr.end(); await ended;
  assert.deepEqual(f.observations, [
    { kind: 'process-output', stream: 'stderr', text: 'a\uFFFD\uFFFD' },
    { kind: 'process-output', stream: 'stderr', text: '\uFFFD' },
  ]);
});

test('decoded UTF-8 and NUL expansion cannot exceed the retained text byte limit', async () => {
  const f = fixture(); f.attach();
  f.child.stderr.write(Buffer.alloc(10 * 1024, 0xff));
  f.child.stderr.write('\n');
  f.child.stderr.write(Buffer.alloc(10 * 1024));
  f.child.stderr.write('\nvisible after expansion\n');
  const ended = once(f.child.stderr, 'end'); f.child.stderr.end(); await ended;
  assert.deepEqual(f.observations, [
    { kind: 'gap', reason: 'oversized' },
    { kind: 'gap', reason: 'oversized' },
    { kind: 'process-output', stream: 'stderr', text: 'visible after expansion' },
  ]);
});

test('oversized lines discard their complete suffix and preserve a multiline dump opener', async () => {
  const f = fixture(); f.attach();
  f.child.stderr.write('prefix ' + 'x'.repeat(24 * 1024));
  f.child.stderr.write('TEST_OVERSIZED_SECRET_SUFFIX\nvisible after oversized\n');
  f.child.stderr.write('configuration dump ' + 'x'.repeat(24 * 1024));
  f.child.stderr.write('\nTEST_UNCAPTURED_DUMP_SECRET\n}\nordinary continuation\n--- End ---\nvisible after dump');
  const ended = once(f.child.stderr, 'end'); f.child.stderr.end(); await ended;
  assert.deepEqual(f.observations, [
    { kind: 'gap', reason: 'oversized' },
    { kind: 'process-output', stream: 'stderr', text: 'visible after oversized' },
    { kind: 'gap', reason: 'oversized' },
    { kind: 'process-output', stream: 'stderr', text: 'visible after dump' },
  ]);
});

test('dump continuations stay suppressed through ordinary newlines and oversized fragments', async () => {
  const f = fixture(); f.attach();
  f.child.stderr.write('auth = {\nTEST_DUMP_SECRET\n}\nnot an end marker\n');
  f.child.stderr.write('x'.repeat(24 * 1024 + 1) + '\nTEST_MORE_DUMP_SECRET\n--- Errors ---\nsafe\n');
  const ended = once(f.child.stderr, 'end'); f.child.stderr.end(); await ended;
  assert.deepEqual(f.observations, [
    { kind: 'process-output', stream: 'stderr', text: '[configuration/auth/environment dump hidden]' },
    { kind: 'gap', reason: 'oversized' },
    { kind: 'process-output', stream: 'stderr', text: 'safe' },
  ]);
});

test('observer errors and reentrant close cannot change stream outcomes or duplicate a tail', () => {
  const f = fixture();
  let calls = 0;
  f.context.observeProcessOutput = (value) => {
    f.observations.push(value);
    if (++calls === 1) throw new Error('TEST observation unavailable');
    f.child.emit('close', 0, null);
  };
  f.attach();
  assert.doesNotThrow(() => f.child.stderr.write('first\nsecond\nlate\n'));
  assert.deepEqual(f.observations.map(value => value.kind === 'process-output' ? value.text : value.kind), ['first', 'second']);
  assert.equal(f.child.stderr.listenerCount('data'), 0);
});

test('a bounded escape-heavy line remains subject to the existing serialized journal limit', async () => {
  const f = fixture(); f.attach();
  f.child.stderr.write('\\'.repeat(24 * 1024));
  const ended = once(f.child.stderr, 'end'); f.child.stderr.end(); await ended;
  assert.equal(f.observations.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(f.observations[0])) > 32 * 1024);
  const withoutObserver = fixture();
  observeMemberProcessStderr(withoutObserver.child, {
    profile: withoutObserver.context.profile, endpoint: withoutObserver.context.endpoint,
  }, []);
  assert.equal(withoutObserver.child.stderr.listenerCount('data'), 0);
});
