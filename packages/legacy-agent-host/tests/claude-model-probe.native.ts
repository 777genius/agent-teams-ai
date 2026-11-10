import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CapturedProcess } from '../dist/adapters/providers/CapturedProcess.js';
import { ClaudeManagementHost } from '../dist/adapters/providers/ClaudeManagementHost.js';
import { startNativeClaudeModelProbeFixture } from './fixtures/native-claude-model-probe.ts';
import { treeHash } from './fixtures/native-host.ts';

import type { ChildProcess } from 'node:child_process';
import type { ClaudeManagementProfile } from '../dist/management/profile.js';

test(
  'explicit Claude model test uses actual SDK text/result and physically releases success and cancellation',
  {
    skip: process.env.CLAUDE_MODEL_PROBE_NATIVE_GO !== '1',
    timeout: 120000,
  },
  async () => {
    const executable = realpathSync(process.env.CLAUDE_PATH!);
    const binarySha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
    assert.equal(binarySha256, process.env.CLAUDE_SHA);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-claude-model-probe-')));
    for (const name of ['workspace', 'home', 'config'])
      mkdirSync(join(root, name), { mode: 0o700 });
    const marker = join(root, 'unexpected-hook');
    writeFileSync(
      join(root, 'config/settings.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: 'command', command: '/usr/bin/touch "$CLAUDE_MODEL_PROBE_HOOK_MARKER"' },
              ],
            },
          ],
        },
      }),
      { mode: 0o600 }
    );
    const model = await startNativeClaudeModelProbeFixture();
    const children: ChildProcess[] = [];
    const hosts: ClaudeManagementHost[] = [];
    let completed = false;
    const receipt = join(root, 'receipt.json');
    console.log(JSON.stringify({ attempt: receipt }));
    const sourceSha256 = await treeHash(join(import.meta.dirname, '../src'), '.ts');
    const distSha256 = await treeHash(join(import.meta.dirname, '../dist'), '.js');
    const profile: ClaudeManagementProfile = {
      provider: 'claude',
      sdkRevision: '0.3.305',
      profileId: 'TEST-claude',
      accountBinding: 'TEST-api',
      configRevision: 'TEST-probe',
      cwd: join(root, 'workspace'),
      configNamespace: 'custom-directory',
      settingSources: ['user'],
      timeoutMs: 15000,
      modelProbeTimeoutMs: 30000,
      executable: { path: executable, sha256: binarySha256 },
      environment: {
        HOME: join(root, 'home'),
        CLAUDE_CONFIG_DIR: join(root, 'config'),
        PATH: '/usr/bin:/bin',
        ANTHROPIC_BASE_URL: model.endpoint,
        ANTHROPIC_API_KEY: 'TEST-local-no-vendor-access',
        CLAUDE_MODEL_PROBE_HOOK_MARKER: marker,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        DISABLE_AUTOUPDATER: '1',
      },
    };
    const create = () => {
      const host = new ClaudeManagementHost(
        profile,
        () => true,
        (selected, current) => {
          const custody = new CapturedProcess(selected, current);
          return {
            launch(request) {
              const child = custody.launch(request);
              children.push(child);
              return child;
            },
            seal: () => custody.seal(),
            isRunning: () => custody.isRunning(),
            confirmStopped: () => custody.confirmStopped(),
          };
        }
      );
      hosts.push(host);
      return host;
    };
    try {
      assert.equal(await create().probe('claude-opus-4-6', new AbortController().signal), true);
      assert.equal(model.observations.length, 1);
      model.setNext('hold');
      const abort = new AbortController();
      const cancelling = create().probe('claude-opus-4-6', abort.signal);
      await Promise.race([
        model.waitForHeld(),
        cancelling.then(() => {
          throw new Error('Probe ended before held request');
        }),
      ]);
      assert.deepEqual(model.failures, []);
      abort.abort();
      await assert.rejects(cancelling);
      await model.waitForDisconnect();
      assert.equal(model.observations.length, 2);
      assert.equal(existsSync(marker), false);
      for (const host of hosts) assert.equal(await host.close(), true);
      for (const child of children) {
        assert.ok(child.pid);
        assert.ok(child.exitCode !== null || child.signalCode !== null);
        assert.throws(() => process.kill(-child.pid!, 0), { code: 'ESRCH' });
      }
      assert.equal(await treeHash(join(import.meta.dirname, '../src'), '.ts'), sourceSha256);
      assert.equal(await treeHash(join(import.meta.dirname, '../dist'), '.js'), distSha256);
      writeFileSync(
        receipt,
        JSON.stringify(
          {
            scope:
              'Actual SDK/native model probe with localhost inference, not vendor/Electron qualification',
            sourceSha256,
            distSha256,
            binarySha256,
            observations: model.observations,
            failures: model.failures,
            nativeProcesses: children.length,
            nativeGroupsAbsent: true,
            configuredHookEffectObserved: false,
          },
          null,
          2
        ),
        { mode: 0o600 }
      );
      console.log(JSON.stringify({ receipt, modelRequests: model.observations.length }));
      completed = true;
    } finally {
      const cleanup = await Promise.allSettled(hosts.map((host) => host.close()));
      if (!completed)
        writeFileSync(
          receipt,
          JSON.stringify(
            {
              status: 'INCOMPLETE',
              sourceSha256,
              distSha256,
              observations: model.observations,
              failures: model.failures,
              nativeProcesses: children.length,
              cleanup: cleanup.map((result) =>
                result.status === 'fulfilled' ? result.value : 'unknown'
              ),
            },
            null,
            2
          ),
          { mode: 0o600 }
        );
      await model.close();
      assert.equal(
        cleanup.every((result) => result.status === 'fulfilled' && result.value),
        true
      );
    }
  }
);
