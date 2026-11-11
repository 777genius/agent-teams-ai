// TEST-only cancellation negatives for the real published OpenCode V2.0.21 server.
// Signal only a parent we own; the native worker is owned by its parent harness.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

for (const [signalName, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(signalName+' reaps the owned published server and emits a HOLD receipt', {
    timeout: 60_000,
  }, async () => {
    const head = process.env.OPENCODE_V2_TEST_SOURCE_HEAD;
    const prefix = process.env.OPENCODE_V2_TEST_SDK_PREFIX;
    assert.match(head ?? '', /^[a-f0-9]{40}$/);
    assert.ok(prefix?.startsWith('/'));
    assert.equal(process.platform, 'linux');
    const fixture = mkdtempSync(join(tmpdir(), 'TEST-v2-http-interrupt-'));
    const temp = join(fixture, 'tmp');
    const marker = join(fixture, 'ready.json');
    const receiptPath = join(fixture, 'interrupted.json');
    mkdirSync(temp);
    let parent, finished, primaryError;
    let interruptionSent = false;
    try {
      parent = spawn(process.execPath, [
        resolve('packages/legacy-agent-host/tests/opencode-v2-published-http-persist.mjs'),
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env, TMPDIR: temp,
          OPENCODE_V2_TEST_SOURCE_HEAD: head,
          OPENCODE_V2_TEST_SDK_PREFIX: prefix,
          OPENCODE_V2_TEST_HTTP_RECEIPT: receiptPath,
          OPENCODE_V2_TEST_READY_FILE: marker,
        },
        stdio: 'ignore',
      });
      finished = once(parent, 'exit');
      const deadline = Date.now() + 35_000;
      while (!existsSync(marker) && parent.exitCode === null && Date.now() < deadline)
        await delay(100);
      assert.equal(parent.exitCode, null, 'the parent must survive until native readiness');
      assert.ok(existsSync(marker), 'the real server must be ready before interruption');
      const owner = JSON.parse(readFileSync(marker, 'utf8'));
      assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 1);
      assert.match(owner.startIdentity, /^\d+$/);
      // Do not signal the native process/group here; its parent alone owns it.
      assert.equal(parent.kill(signalName), true, 'signal only the owned TEST parent');
      interruptionSent = true;
      const interruptTimeout = new AbortController();
      let code, signal;
      try {
        [code, signal] = await Promise.race([
          finished,
          delay(15_000, undefined, {signal:interruptTimeout.signal}).then(() => {
            throw Error('TEST_interrupt_cleanup_timeout');
          }),
        ]);
      } finally {
        interruptTimeout.abort();
      }
      assert.equal(signal, null);
      assert.equal(code, exitCode);
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      assert.equal(receipt.sourceHead, head);
      assert.equal(receipt.qualified, false);
      assert.equal(receipt.modelTurnProven, false);
      assert.equal(receipt.failure, 'TEST_interrupted_' + signalName);
      assert.equal(receipt.cleanup, true);
      assert.deepEqual(readdirSync(temp), [], 'owned temporary root was not removed');
      let groupAlive = false;
      try { process.kill(-owner.pid, 0); groupAlive = true; }
      catch (error) { if (error?.code !== 'ESRCH') throw error; }
      assert.equal(groupAlive, false, 'the TEST worker group must have exited');
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        // Never signal the detached native worker or another process group here:
        // only the spawned parent can attest cleanup of its owned worker.
        if (parent) {
          if (!interruptionSent && parent.exitCode === null && parent.signalCode === null)
            interruptionSent = parent.kill('SIGTERM');
          const timeout = new AbortController();
          try {
            await Promise.race([
              finished,
              delay(15_000, undefined, {signal:timeout.signal}).then(() => {
                throw Error('TEST_parent_cleanup_timeout_fixture_preserved');
              }),
            ]);
          } finally {
            timeout.abort();
          }
          // Missing/negative receipt or a surviving worker means ownership is
          // uncertain. Leave the fixture for diagnosis instead of deleting live
          // process resources.
          assert.ok(existsSync(receiptPath),
            'TEST parent cleanup receipt missing; fixture preserved');
          assert.equal(JSON.parse(readFileSync(receiptPath, 'utf8')).cleanup, true,
            'TEST parent cleanup not confirmed; fixture preserved');
          assert.deepEqual(readdirSync(temp), [],
            'TEST parent left temporary resources; fixture preserved');
          if (existsSync(marker)) {
            const ready = JSON.parse(readFileSync(marker, 'utf8'));
            assert.throws(() => process.kill(-ready.pid, 0), {code:'ESRCH'},
              'TEST worker group still exists; fixture preserved');
          }
        }
        rmSync(fixture, {recursive:true,force:true,maxRetries:5,retryDelay:100});
      } catch (cleanupError) {
        if (primaryError) throw new AggregateError(
          [primaryError, cleanupError],
          'TEST interruption and owned cleanup both failed; fixture retained for diagnosis'
        );
        throw cleanupError;
      }
    }
  });
}
