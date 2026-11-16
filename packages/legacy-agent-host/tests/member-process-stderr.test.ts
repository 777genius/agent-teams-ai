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

test('standalone stderr uses selected private values without a Team endpoint', async () => {
  const f = fixture(), context = {
    profile: f.context.profile, observeProcessOutput: f.context.observeProcessOutput,
  };
  assert.equal('endpoint' in context, false);
  observeMemberProcessStderr(f.child, context, ['--token', 'TEST_STANDALONE_ARG_CANARY']);
  assert.equal(f.observations.length, 0, 'no diagnostic is synthesized before original stderr arrives');
  const canaries = ['TEST_ENV_FIRST_CANARY', 'TEST_ENV_SECOND_CANARY', 'TEST_HEADER_PRIVATE_CANARY',
    'TEST_CUSTOM_HEADER_CANARY', 'TEST_MCP_ENV_CANARY', 'TEST_MCP_ARG_CANARY', 'TEST_STANDALONE_ARG_CANARY'];
  f.child.stderr.write(`TEST standalone startup\n${canaries.join('\n')}\nTEST standalone final tail`);
  f.child.stdout.write('TEST_STANDALONE_PROTOCOL_CANARY');
  const ended = once(f.child.stderr, 'end'); f.child.stderr.end(); await ended;
  f.child.emit('close', 0, null); f.child.stderr.emit('close');
  const retained = JSON.stringify(f.observations);
  for (const canary of [...canaries, 'TEST_STANDALONE_PROTOCOL_CANARY'])
    assert.equal(retained.includes(canary), false, canary);
  assert.deepEqual(f.observations[0], { kind: 'process-output', stream: 'stderr', text: 'TEST standalone startup' });
  assert.deepEqual(f.observations.at(-1), { kind: 'process-output', stream: 'stderr', text: 'TEST standalone final tail' });
  assert.equal(f.observations.filter(value => value.kind === 'process-output' && value.text === 'TEST standalone final tail').length, 1);
  assert.equal(f.child.stderr.listenerCount('data'), 0);
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

test('held escaped, URI and whitespace-normalized values and quoted assignments cannot leave secret suffixes', async () => {
  const f = fixture(), secret = 'alpha"TEST_PRIVATE_SUFFIX';
  observeMemberProcessStderr(f.child, {
    ...f.context, endpoint: { ...f.context.endpoint, url: 'http://127.0.0.1:12345/TEST-private' },
    profile: { ...f.context.profile, environment: { API_KEY: secret,
      AUTH_TOKEN: 'TEST_PRIVATE_FIRST\nTEST_PRIVATE_SECOND', PASSWORD: 'TEST  SPACED  SECRET' } },
  }, []);
  const output = ['TEST ordinary diagnostic', 'opaque=' + JSON.stringify(secret),
    'opaque=' + encodeURIComponent(secret), 'TEST_PRIVATE_FIRST\nTEST_PRIVATE_SECOND',
    'TEST  SPACED  SECRET', 'http://127.0.0.1:12345/TEST-private',
    'password=' + JSON.stringify('TEST_UNHELD_PREFIX"TEST_UNHELD_SUFFIX')].join('\n');
  for (let at = 0; at < output.length; at += 7) f.child.stderr.write(output.slice(at, at + 7));
  const ended = once(f.child.stderr, 'end'); f.child.stderr.end(); await ended;
  const retained = JSON.stringify(f.observations);
  assert.ok(retained.includes('TEST ordinary diagnostic'));
  for (const fragment of ['alpha', 'TEST_PRIVATE_SUFFIX', 'TEST_PRIVATE_FIRST', 'TEST_PRIVATE_SECOND',
    'SPACED', 'SECRET', '127.0.0.1:12345', 'TEST_UNHELD_PREFIX', 'TEST_UNHELD_SUFFIX'])
    assert.equal(retained.includes(fragment), false, fragment);
});

for (const [secret, output] of [['ABABAB', 'ABABABAB'], ['a', 'aaaa']] as const) {
  test(`overlapping held values are masked in one pass: ${secret}`, async () => {
    const f = fixture();
    observeMemberProcessStderr(f.child, { ...f.context,
      profile: { ...f.context.profile, environment: { API_KEY: secret } } }, []);
    f.child.stderr.write(output + '\n');
    const ended = once(f.child.stderr, 'end'); f.child.stderr.end(); await ended;
    assert.deepEqual(f.observations, [{ kind: 'process-output', stream: 'stderr', text: '[redacted]' }]);
  });
}

for (const oversized of [false, true]) {
  test(`long split ANSI does not lose a dump opener before ${oversized ? 'discard' : 'flush'}`, async () => {
    const f = fixture(); f.attach();
    f.child.stderr.write('environment\u001b[' + '1;'.repeat(300));
    f.child.stderr.write('m dump ' + (oversized ? 'x'.repeat(25 * 1024) : '') + '\n');
    f.child.stderr.write('TEST_DUMP_CONTINUATION_CANARY\n--- End ---\nTEST safe\n');
    const ended = once(f.child.stderr, 'end'); f.child.stderr.end(); await ended;
    assert.equal(JSON.stringify(f.observations).includes('TEST_DUMP_CONTINUATION_CANARY'), false);
    assert.equal(f.observations.at(-1)?.kind, 'process-output');
    assert.ok(f.observations.some(value => value.kind === 'process-output' && value.text === 'TEST safe'));
  });
}

test('dump detection continues through already discarded oversized fragments', async () => {
  const f = fixture(); f.attach();
  f.child.stderr.write('x'.repeat(25 * 1024));
  f.child.stderr.write(' environ'); f.child.stderr.write('ment dump\nTEST_DISCARDED_DUMP_CANARY\n');
  f.child.stderr.write('--- End ---\nTEST safe\n');
  const ended = once(f.child.stderr, 'end'); f.child.stderr.end(); await ended;
  assert.equal(JSON.stringify(f.observations).includes('TEST_DISCARDED_DUMP_CANARY'), false);
  assert.ok(f.observations.some(value => value.kind === 'process-output' && value.text === 'TEST safe'));
});

for (const [secret, text] of [
  ['s', 'password="TEST_UNHELD_CANARY"'],
  ['a', 'Bearer TEST_UNHELD_CANARY'],
  ['h', 'http://user:TEST_UNHELD_CANARY@example.invalid/visible'],
] as const) {
  test(`a short held value cannot destroy sensitive syntax before classification: ${secret}`, async () => {
    const f = fixture();
    observeMemberProcessStderr(f.child, { ...f.context,
      profile: { ...f.context.profile, environment: { API_KEY: secret } } }, []);
    f.child.stderr.write(text + '\n');
    const ended = once(f.child.stderr, 'end'); f.child.stderr.end(); await ended;
    assert.equal(JSON.stringify(f.observations).includes('TEST_UNHELD_CANARY'), false);
  });
}

test('syntax redaction cannot expose fragments of a transformed held value', async () => {
  const f = fixture();
  observeMemberProcessStderr(f.child, { ...f.context,
    endpoint: { ...f.context.endpoint, url: 'http://127.0.0.1:12345/TEST_PRIVATE_PATH?token=TEST_PRIVATE_QUERY' },
    profile: { ...f.context.profile, environment: { API_KEY: 'TEST_PREFIX password=TEST_INNER TEST_SUFFIX', SHORT_TOKEN: 'a' } },
  }, []);
  f.child.stderr.write('url http://127.0.0.1:12345/TEST_PRIVATE_PATH?token=TEST_PRIVATE_QUERY\n');
  f.child.stderr.write('opaque TEST_PREFIX password=TEST_INNER TEST_SUFFIX\n');
  const ended = once(f.child.stderr, 'end'); f.child.stderr.end(); await ended;
  const retained = JSON.stringify(f.observations);
  for (const canary of ['127.0.0.1:12345', 'TEST_PRIVATE_PATH', 'TEST_PRIVATE_QUERY', 'TEST_PREFIX', 'TEST_INNER', 'TEST_SUFFIX'])
    assert.equal(retained.includes(canary), false, canary);
  assert.equal(retained.includes('[red[redacted]'), false, 'existing markers are not expanded by short held values');
});

for (const alreadyDiscarded of [false, true]) {
  test(`an ANSI prefix larger than the line budget remains fail-closed (${alreadyDiscarded})`, async () => {
    const f = fixture(); f.attach();
    if (alreadyDiscarded) f.child.stderr.write('x'.repeat(25 * 1024));
    f.child.stderr.write('environment\u001b[' + '1;'.repeat(13 * 1024));
    f.child.stderr.write('m dump\nTEST_LONG_CSI_DUMP_CANARY\n--- End ---\nTEST safe\n');
    const ended = once(f.child.stderr, 'end'); f.child.stderr.end(); await ended;
    assert.equal(JSON.stringify(f.observations).includes('TEST_LONG_CSI_DUMP_CANARY'), false);
    assert.ok(f.observations.some(value => value.kind === 'process-output' && value.text === 'TEST safe'));
  });
}

for (const [label, separator] of [['space', ' '], ['tab', '\t'], ['mixed', ' \t  ']] as const) {
  test(`held whitespace values cannot leak after contextual syntax redaction (${label})`, async () => {
    const f = fixture();
    observeMemberProcessStderr(f.child, { ...f.context,
      profile: { ...f.context.profile, environment: { API_KEY: 'TEST_HELD_PREFIX TEST_HELD_SUFFIX' } } }, []);
    const output = `Bearer TEST_HELD_PREFIX${separator}TEST_HELD_SUFFIX\n`;
    for (let at = 0; at < output.length; at += 7) f.child.stderr.write(output.slice(at, at + 7));
    const ended = once(f.child.stderr, 'end'); f.child.stderr.end(); await ended;
    const retained = JSON.stringify(f.observations);
    assert.equal(retained.includes('TEST_HELD_SUFFIX'), false, 'the complete already-held value stays private');
    assert.equal(retained.includes('TEST_HELD_PREFIX'), false);
    assert.deepEqual(f.observations, [{ kind: 'process-output', stream: 'stderr', text: '[redacted]' }]);
  });
}

test('safe diagnostics and unambiguous held-value context remain readable', async () => {
  const f = fixture();
  observeMemberProcessStderr(f.child, { ...f.context,
    profile: { ...f.context.profile, environment: { API_KEY: 'TEST_HELD_PREFIX TEST_HELD_SUFFIX' } } }, []);
  f.child.stderr.write('TEST ordinary public diagnostic\n');
  f.child.stderr.write('prefix TEST_HELD_PREFIX TEST_HELD_SUFFIX suffix\n');
  f.child.stderr.write('status password=TEST_UNHELD_VALUE tail\n');
  const ended = once(f.child.stderr, 'end'); f.child.stderr.end(); await ended;
  assert.deepEqual(f.observations, [
    { kind: 'process-output', stream: 'stderr', text: 'TEST ordinary public diagnostic' },
    { kind: 'process-output', stream: 'stderr', text: 'prefix [redacted] suffix' },
    { kind: 'process-output', stream: 'stderr', text: 'status [redacted] tail' },
  ]);
});
