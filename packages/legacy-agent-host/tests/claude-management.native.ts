import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CapturedProcess } from '../dist/adapters/providers/CapturedProcess.js';
import { ClaudeManagementHost } from '../dist/adapters/providers/ClaudeManagementHost.js';
import { treeHash } from './fixtures/native-host.ts';

import type { ChildProcess } from 'node:child_process';
import type { ClaudeManagementProfile } from '../dist/management/profile.js';

test(
  'actual SDK initializes captured Claude metadata with no model request and releases its process',
  {
    skip: process.env.CLAUDE_METADATA_NATIVE_GO !== '1',
    timeout: 60000,
  },
  async () => {
    const executable = realpathSync(process.env.CLAUDE_PATH!);
    const digest = createHash('sha256').update(readFileSync(executable)).digest('hex');
    assert.equal(digest, process.env.CLAUDE_SHA);
    assert.match(digest, /^[a-f0-9]{64}$/);
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-claude-metadata-')));
    const cwd = join(root, 'workspace'),
      home = join(root, 'home'),
      config = join(root, 'config');
    for (const directory of [cwd, home, config]) mkdirSync(directory, { mode: 0o700 });
    const hookMarker = join(root, 'unexpected-hook-effect');
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/usr/bin/touch "$CLAUDE_METADATA_TEST_HOOK_MARKER"' }] }] } }), { mode: 0o600 });
    let requests = 0;
    const server = createServer((_request, response) => {
      requests++;
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ error: { type: 'TEST-no-inference', message: 'Metadata sends no input' } })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const children: ChildProcess[] = [];
    const sourceSha256 = await treeHash(join(import.meta.dirname, '../src'), '.ts');
    const distSha256 = await treeHash(join(import.meta.dirname, '../dist'), '.js');
    let host: ClaudeManagementHost | undefined;
    try {
      const profile: ClaudeManagementProfile = {
        provider: 'claude',
        sdkRevision: '0.3.305',
        profileId: 'TEST-claude',
        accountBinding: 'TEST-local',
        configRevision: 'TEST-metadata-v1',
        cwd,
        configNamespace: 'custom-directory',
        settingSources: ['user'],
        timeoutMs: 15000,
        executable: { path: executable, sha256: digest },
        environment: {
          HOME: home,
          PATH: '/usr/bin:/bin',
          CLAUDE_CONFIG_DIR: config,
          CLAUDE_METADATA_TEST_HOOK_MARKER: hookMarker,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
          ANTHROPIC_API_KEY: 'TEST-local-no-vendor-access',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
          DISABLE_AUTOUPDATER: '1',
        },
      };
      host = new ClaudeManagementHost(
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
      const value = await host.read();
      assert.ok(value.models.length > 0);
      assert.equal(value.profileId, profile.profileId);
      assert.equal(value.configRevision, profile.configRevision);
      assert.equal(Object.hasOwn(value.account, 'email'), false);
      assert.equal(Object.hasOwn(value, 'authenticated'), false);
      assert.equal(requests, 0);
      assert.equal(existsSync(hookMarker), false);
      assert.equal(children.length, 1);
      assert.equal(await host.close(), true);
      for (const child of children) {
        assert.ok(child.exitCode !== null || child.signalCode !== null);
        assert.ok(child.pid);
        assert.throws(() => process.kill(-child.pid!, 0), { code: 'ESRCH' });
      }
      assert.equal(await treeHash(join(import.meta.dirname, '../src'), '.ts'), sourceSha256);
      assert.equal(await treeHash(join(import.meta.dirname, '../dist'), '.js'), distSha256);
      writeFileSync(
        join(root, 'receipt.json'),
        JSON.stringify(
          {
            sourceSha256,
            distSha256,
            scope: 'Claude SDK metadata; no vendor auth/inference or Launch dialog acceptance',
            executableSha256: digest,
            node: process.version,
            models: value.models,
            account: value.account,
            modelRequests: requests,
            nativeProcesses: children.length,
            nativeGroupAbsent: true,
            configuredHookEffectObserved: false,
          },
          null,
          2
        ),
        { mode: 0o600 }
      );
      console.log(
        JSON.stringify({
          receipt: join(root, 'receipt.json'),
          modelCount: value.models.length,
          modelRequests: requests,
        })
      );
    } finally {
      if (host) assert.equal(await host.close(), true);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }
);
