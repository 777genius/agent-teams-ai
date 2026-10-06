import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Session } from 'node:inspector/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { macCallFunction, macSerializedFunction } from './mac-serialization.mts';
import { Cdp, waitFor } from './cdp.mts';

// A named nested callback gets the same real esbuild transformation as the
// transport hook. Evaluate it in a foreign realm with no compiler globals.
function callback(value: number) {
  const increment = (input: number) => input + 1;
  return increment(value);
}
void test('compiled callback executes in an isolated signed-app-style lexical realm', () => {
  const originalName = () => {
    throw new Error('Foreign app helper must never be invoked');
  };
  const realm = { __name: originalName };
  // Only this module's fixed callback executes, in a bounded isolated realm.
  // eslint-disable-next-line sonarjs/code-eval
  const result: unknown = runInNewContext(`(${macSerializedFunction(callback)})(41)`, realm, {
    timeout: 500,
  });
  assert.equal(result, 42);
  assert.equal(realm.__name, originalName);
});

void test('CDP argument calls preserve the actual paused entry lexical frame', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'TEST-cdp-bundled-singleton-'));
  const packageDirectory = path.join(fixture, 'node_modules', 'electron-updater');
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(
    path.join(packageDirectory, 'index.js'),
    'exports.autoUpdater=Object.assign(new (require("node:events").EventEmitter)(),{identity:"separate installed-package singleton"});'
  );
  const main = path.join(fixture, 'index.cjs');
  await writeFile(
    main,
    'function __TEST_entry(){const __TEST_entrySecret="original entry lexical value";const originalReadyGetter=()=>autoUpdater;\ndebugger;\nconst autoUpdater=Object.assign(new (require("node:events").EventEmitter)(),{identity:"genuine bundled singleton"});globalThis.__TEST_readyResult=globalThis.__TEST_readyCallback();originalReadyGetter().emit("update-available",{version:"TEST-target"});setInterval(()=>{},1000); }\n__TEST_entry();'
  );
  const child = spawn(process.execPath, ['--inspect-brk=127.0.0.1:0', main], {
    cwd: fixture,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  let launchError: Error | undefined;
  child.stderr.on('data', (value: Buffer) => {
    stderr += value.toString();
  });
  child.on('error', (error) => {
    launchError = error;
  });
  let client: Cdp | undefined;
  try {
    const url = await waitFor(
      () => {
        if (launchError) throw launchError;
        assert.equal(child.exitCode, null, 'Owned TEST Node inspector must remain alive');
        return Promise.resolve(
          /Debugger listening on (ws:\/\/127\.0\.0\.1:\S+)/.exec(stderr)?.[1] ?? null
        );
      },
      'owned TEST Node inspector',
      10_000
    );
    client = await Cdp.connect(url);
    const paused = () =>
      Promise.resolve(
        (client?.events.find((event) => event.method === 'Debugger.paused')?.params as
          | { callFrames: { callFrameId: string; functionName: string }[] }
          | undefined) ?? null
      );
    await client.send('Debugger.enable');
    await client.send('Runtime.runIfWaitingForDebugger');
    const initial = await waitFor(paused, 'owned TEST Node initial pause', 10_000);
    if (initial.callFrames[0]?.functionName !== '__TEST_entry') {
      client.events.length = 0;
      await client.send('Debugger.resume');
    }
    const entry = await waitFor(paused, 'owned TEST Node lexical entry pause', 10_000);
    const frame = entry.callFrames[0];
    assert(frame);
    assert.equal(frame.functionName, '__TEST_entry');
    assert.equal(await client.evaluate('typeof __TEST_entrySecret'), 'undefined');
    const input = '");throw new Error("argument executed");//';
    assert.deepEqual(
      await macCallFunction(
        client,
        '(()=>{const capturedSecret=__TEST_entrySecret;const capturedRequire=require;return value=>({secret:capturedSecret,requireType:typeof capturedRequire,value});})()',
        [input],
        frame.callFrameId
      ),
      { secret: 'original entry lexical value', requireType: 'function', value: input }
    );
    await macCallFunction(
      client,
      '(()=>{const originalRequire=require;const getUpdater=()=>autoUpdater;return ()=>{globalThis.__TEST_readyEvents=[];globalThis.__TEST_readyCallback=()=>{const updater=getUpdater();updater.on("update-available",value=>globalThis.__TEST_readyEvents.push(value.version));return updater.identity;};return "registered";};})()',
      [],
      frame.callFrameId
    );
    assert.equal(
      await client.evaluate('autoUpdater.identity', frame.callFrameId).then(
        () => false,
        () => true
      ),
      true,
      'Original bundled singleton is still in TDZ at the selected frame'
    );
    assert.equal(
      await client.evaluate('require("electron-updater").autoUpdater.identity', frame.callFrameId),
      'separate installed-package singleton'
    );
    // The singleton declaration is still in TDZ at the pause. Genuine access
    // happens only when the original entry invokes its ready callback.
    await client.send('Debugger.resume');
    const resumedClient = client;
    assert.equal(
      await waitFor(
        async () =>
          (await resumedClient.evaluate<string | undefined>('globalThis.__TEST_readyResult')) ??
          null,
        'original ready getter',
        5000
      ),
      'genuine bundled singleton'
    );
    assert.deepEqual(await client.evaluate('globalThis.__TEST_readyEvents'), ['TEST-target']);
  } finally {
    client?.close();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitFor(
        () => Promise.resolve(child.exitCode !== null || child.signalCode !== null ? true : null),
        'owned TEST Node inspector exit',
        5000
      );
    }
    await rm(fixture, { recursive: true, force: true });
  }
});

// A real V8 inspector catches argument/code mixing, loss of the captured lexical
// function, ignored runtime exceptions, and retained CDP object handles.
void test('CDP keeps hostile values separate from trusted code and releases actual closures', async () => {
  const session = new Session();
  session.connect();
  const trace: { method: string; params: Record<string, unknown> }[] = [];
  const client: Pick<Cdp, 'send'> = {
    async send<T>(method: string, params: Record<string, unknown> = {}) {
      trace.push({ method, params });
      const result: unknown = await session.post(method, params);
      return result as T;
    },
  };
  const hostile = '");globalThis.__TEST_macCdpInjection=true;//\u2028\u2029';
  const paths = { feed: [hostile], installer: '\\";throw new Error("input executed");//' };
  const expression =
    '(()=>{const owner="captured original lexical closure";return (value,paths)=>({owner,value,paths,injected:globalThis.__TEST_macCdpInjection===true});})()';
  try {
    const result = await macCallFunction<{
      owner: string;
      value: string;
      paths: typeof paths;
      injected: boolean;
    }>(client, expression, [hostile, paths]);
    assert.deepEqual(result, {
      owner: 'captured original lexical closure',
      value: hostile,
      paths,
      injected: false,
    });
    assert.equal(trace[0]?.method, 'Runtime.evaluate');
    assert.equal(trace[0]?.params.expression, expression);
    const call = trace.find((entry) => entry.method === 'Runtime.callFunctionOn');
    assert(call);
    assert.deepEqual(call.params.arguments, [{ value: hostile }, { value: paths }]);
    assert.equal(call.params.objectId, trace.at(-1)?.params.objectId);
    assert.equal(trace.at(-1)?.method, 'Runtime.releaseObject');
    await assert.rejects(
      session.post('Runtime.getProperties', { objectId: String(call.params.objectId) }),
      /Could not find object with given id/
    );

    trace.length = 0;
    await assert.rejects(
      macCallFunction(client, '()=>{throw new Error("actual CDP callback failure");}', []),
      /actual CDP callback failure/
    );
    const failedCall = trace.find((entry) => entry.method === 'Runtime.callFunctionOn');
    assert(failedCall);
    assert.equal(trace.at(-1)?.method, 'Runtime.releaseObject');
    assert.equal(trace.at(-1)?.params.objectId, failedCall.params.objectId);
    await assert.rejects(
      session.post('Runtime.getProperties', { objectId: String(failedCall.params.objectId) }),
      /Could not find object with given id/
    );
    await assert.rejects(
      macCallFunction(client, '(()=>{throw new Error("actual CDP factory failure");})()', []),
      /actual CDP factory failure/
    );
  } finally {
    await session.post('Runtime.evaluate', {
      expression: 'delete globalThis.__TEST_macCdpInjection',
    });
    session.disconnect();
  }
});
