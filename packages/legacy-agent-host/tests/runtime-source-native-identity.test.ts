import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireProfileWriterLease } from '../dist/adapters/profile/ProfileWriterLease.js';
import { FileManagementCommandStore } from '../dist/adapters/providers/FileManagementCommandStore.js';
import { RuntimeSourceNativeVersion } from '../dist/adapters/providers/RuntimeSourceNativeVersion.js';
import { RuntimeSourceIndex } from '../dist/composition/RuntimeSourceIndex.js';
import { assertRuntimeSourceNativePolicy } from '../dist/composition/runtimeSourceQualification.js';
import { assertRuntimeSourceQualification } from '../dist/composition/verifyRuntimeSourceCandidate.js';
import { providerManagementProfileSchema } from '../dist/management/profile.js';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type {
  RuntimeSourceCandidate,
  RuntimeSourceGrant,
} from '../dist/composition/runtimeSourceContracts.js';
import type { TestContext } from 'node:test';

function fixture(t: TestContext, provider: 'codex' | 'claude' | 'opencode' = 'codex') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-source-native-')));
  const lease = acquireProfileWriterLease(root),
    marker = join(root, 'TEST-version-reads');
  t.after(() => {
    lease.release();
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'config'));
  const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const binary = (name: string, version: string, mutate = false) => {
    const path = join(root, name);
    const output =
      provider === 'codex'
        ? `codex-cli ${version}`
        : provider === 'claude'
          ? `${version} (Claude Code)`
          : version;
    const bytes = [
      '#!/bin/sh',
      `# ${name}`,
      'test -z "$TEST_SECRET_AUTH$NODE_OPTIONS$BUN_OPTIONS" || exit 9',
      `printf '%s\\n' ${quoted(name)} >> ${quoted(marker)}`,
      ...(mutate ? ['printf "\\n# changed bytes\\n" >> "$0"'] : []),
      `printf '%s\\n' ${quoted(output)}`,
      '',
    ].join('\n');
    writeFileSync(path, bytes, { mode: 0o700 });
    return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const version = provider === 'codex' ? '0.162.0' : provider === 'claude' ? '2.1.34' : '1.19.4';
  const original = binary('TEST-seed', version);
  const profile: TeamHostProfile = {
    schemaVersion: 1,
    principalId: 'TEST-human',
    teams: [],
    creation: { contextIds: ['TEST-context'] },
    owner: {
      ownerId: 'TEST-owner',
      revision: 'TEST-owner-revision',
      profileId: 'TEST-bootstrap',
      storageRoot: root,
      protocolVersion: 1,
      buildId: 'TEST-build',
      nodeSha256: 'a'.repeat(64),
      hostEntrySha256: 'b'.repeat(64),
    },
    management: [
      providerManagementProfileSchema.parse({
        provider,
        executable: original,
        cwd: root,
        accountBinding: 'TEST-account',
        profileId: 'TEST-profile',
        configRevision: 'TEST-config',
        timeoutMs: 1000,
        environment: {
          HOME: root,
          PATH: '/usr/bin:/bin',
          CODEX_HOME: join(root, 'config'),
          CLAUDE_CONFIG_DIR: join(root, 'config'),
          TEST_SECRET_AUTH: 'TEST-must-not-reach-version-child',
          NODE_OPTIONS: '--require /TEST/not-allowed',
          BUN_OPTIONS: '--preload /TEST/not-allowed',
        },
        ...(provider === 'codex'
          ? { protocolRevision: '0.162.0' as const }
          : provider === 'claude'
            ? { sdkRevision: '0.3.305' as const, configNamespace: 'custom-directory' as const }
            : { endpoint: 'http://127.0.0.1:19182', nativeGeneration: 'v1' as const }),
      }),
    ],
  };
  const grant: RuntimeSourceGrant = {
    targetId: 'c'.repeat(64),
    ownerId: profile.owner.ownerId,
    ownerRevision: profile.owner.revision,
    contextId: 'TEST-context',
    projectPath: root,
    runtimeId: provider,
    profileId: 'TEST-profile',
    configRevision: 'TEST-config',
    teamScopes: [],
  };
  const assertWriter = () => lease.assertCurrent();
  const index = new RuntimeSourceIndex(profile, assertWriter),
    store = new FileManagementCommandStore(root);
  const candidate = (
    name: string,
    expected = version,
    reported = expected,
    mutate = false
  ): RuntimeSourceCandidate => {
    const executable = binary(name, reported, mutate);
    return {
      sourceKind: 'app-managed',
      executable,
      nativeCli: {
        executable,
        version: expected,
        ...(provider === 'opencode' ? { generation: 'v1' as const } : {}),
      },
    };
  };
  const input = (name: string, selected = candidate(name)) => ({
    grant,
    commandId: name,
    expectedRevision: index.current({ grant }).revision,
    candidate: selected,
  });
  return {
    root,
    profile,
    grant,
    index,
    store,
    assertWriter,
    candidate,
    input,
    reads: () => (existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n') : []),
  };
}

test(
  'new qualified native bytes publish only after exact owned version and cleanup; cold replay never repeats the child',
  {
    skip:
      process.platform === 'win32'
        ? 'POSIX process fixture; Windows native broker qualification runs in its own native lane'
        : false,
  },
  async (t) => {
    const f = fixture(t),
      input = f.input('TEST-selected');
    const result = await f.index.publish(input, () => {
      assert.equal(f.reads().length, 1);
    });
    assert.equal(result.phase, 'published');
    assert.equal(result.selection?.cliVersion, '0.162.0');
    assert.deepEqual(f.reads(), ['TEST-selected']);
    assert.deepEqual(
      await new RuntimeSourceIndex(f.profile, f.assertWriter).publish(input, () =>
        assert.fail('re-admission')
      ),
      result
    );
    assert.deepEqual(f.reads(), ['TEST-selected']);
    const receipt = f.store.read(input.commandId)!;
    assert.equal(receipt.resourceHeld, false);
    assert.equal(JSON.stringify(receipt).includes('TEST-must-not-reach-version-child'), false);
    await f.index.close();
  }
);

test(
  'version policy, exact native output and post-read bytes are independent gates',
  {
    skip: process.platform === 'win32' ? 'POSIX process fixture' : false,
  },
  async (t) => {
    const f = fixture(t),
      initial = f.index.current({ grant: f.grant });
    await assert.rejects(
      f.index.publish(
        f.input('TEST-unqualified', f.candidate('TEST-unqualified', '0.163.0')),
        () => {}
      ),
      { reason: 'unqualified-version' }
    );
    assert.deepEqual(f.reads(), []);
    const mismatch = await f.index.publish(
      f.input('TEST-mismatch', f.candidate('TEST-mismatch', '0.162.0', '0.161.0')),
      () => assert.fail('native mismatch')
    );
    assert.equal(mismatch.phase, 'held');
    assert.equal(mismatch.reason, 'native-version-mismatch');
    await assert.rejects(
      f.index.publish(
        f.input('TEST-mutating', f.candidate('TEST-mutating', '0.162.0', '0.162.0', true)),
        () => assert.fail('changed bytes')
      ),
      { reason: 'source-changed' }
    );
    assert.deepEqual(f.index.current({ grant: f.grant }), initial);
    assert.equal(f.store.read('TEST-mutating')?.resourceHeld, false);
    await f.index.close();
  }
);

test(
  'verified pre-publication recovery reuses its original native observation without another version process',
  {
    skip: process.platform === 'win32' ? 'POSIX process fixture' : false,
  },
  async (t) => {
    const f = fixture(t),
      input = f.input('TEST-before-admission');
    await assert.rejects(
      f.index.publish(input, () => {
        throw new Error('TEST-interrupted-after-verification');
      })
    );
    assert.equal(f.index.lookup({ grant: f.grant, commandId: input.commandId })?.phase, 'verified');
    assert.equal(
      (await new RuntimeSourceIndex(f.profile, f.assertWriter).publish(input, () => {})).phase,
      'published'
    );
    assert.deepEqual(f.reads(), ['TEST-before-admission']);
    await f.index.close();
  }
);

test('unknown cleanup is retained; only the original live handle may settle it without rerunning native verification', async (t) => {
  const f = fixture(t),
    input = f.input('TEST-held');
  let runs = 0,
    closes = 0;
  const index = new RuntimeSourceIndex(f.profile, f.assertWriter, {
    createNativeCheck: () => ({
      run: async () => {
        runs++;
        return { nativeVersion: '0.162.0' };
      },
      close: async () => ++closes > 1,
    }),
  });
  assert.deepEqual(await index.publish(input, () => assert.fail('cleanup not confirmed')), {
    commandId: input.commandId,
    phase: 'held',
    reason: 'cleanup-unconfirmed',
  });
  const cold = new RuntimeSourceIndex(f.profile, f.assertWriter, {
    createNativeCheck: () => {
      assert.fail('cold recovery cannot adopt or relaunch');
    },
  });
  assert.equal((await cold.publish(input, () => assert.fail('cold publication'))).phase, 'held');
  const held = f.store.read(input.commandId)!;
  if (held.kind !== 'runtime.source') assert.fail('Expected source receipt');
  const { reason: _reason, nativeVersion: _version, seedNativeVersion: _seed, ...claimed } = held;
  // Fault injection at the durable claim boundary: no observation or cleanup was recorded.
  f.store.write({ ...claimed, phase: 'verifying', resourceHeld: true });
  assert.deepEqual(cold.lookup({ grant: f.grant, commandId: input.commandId }), {
    commandId: input.commandId,
    phase: 'held',
    reason: 'native-outcome-unknown',
  });
  assert.equal((await cold.publish(input, () => assert.fail('unknown claim'))).phase, 'held');
  f.store.write(held);
  assert.equal((await index.publish(input, () => {})).phase, 'published');
  assert.equal(runs, 1);
  assert.equal(closes, 2);
  await index.close();
});

test('Host shutdown seals admission, drains the original version child and persists confirmed cleanup under its lease', {
  skip: process.platform === 'win32' ? 'POSIX process fixture' : false,
}, async t => {
  const f = fixture(t), input = f.input('TEST-shutdown');
  let sealed = false, signalStarted!: () => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  const index = new RuntimeSourceIndex(f.profile, () => {
    f.assertWriter();
    if (sealed) throw new Error('TEST-Host-sealed');
  }, {
    assertCleanupWriter: f.assertWriter,
    createNativeCheck: (seed, candidate, current) => {
      const native = new RuntimeSourceNativeVersion(seed, candidate, current);
      return {
        run: () => { const running = native.run(); signalStarted(); return running; },
        close: () => native.close(),
      };
    },
  });
  const pending = index.publish(input, () => assert.fail('shutdown cannot publish'));
  await started;
  sealed = true;
  await index.close();
  assert.equal((await pending).phase, 'held');
  const receipt = f.store.read(input.commandId)!;
  assert.equal(receipt.resourceHeld, false);
  assert.equal(receipt.phase, 'held');
  const cold = new RuntimeSourceIndex(f.profile, f.assertWriter, {
    createNativeCheck: () => { assert.fail('shutdown replay cannot allocate'); },
  });
  assert.equal((await cold.publish(input, () => assert.fail('shutdown replay'))).phase, 'held');
});

test(
  'Claude native qualification compares its original CLI version, never the SDK revision',
  {
    skip: process.platform === 'win32' ? 'POSIX process fixture' : false,
  },
  async (t) => {
    const f = fixture(t, 'claude');
    const refused = await f.index.publish(
      f.input('TEST-new-version', f.candidate('TEST-new-version', '2.1.35')),
      () => assert.fail('unqualified CLI')
    );
    assert.equal(refused.reason, 'unqualified-version');
    assert.deepEqual(f.reads(), ['TEST-seed']);
    const accepted = await f.index.publish(f.input('TEST-new-bytes'), () => {});
    assert.equal(accepted.phase, 'published');
    assert.deepEqual(f.reads(), ['TEST-seed', 'TEST-seed', 'TEST-new-bytes']);
    await f.index.close();
  }
);

test(
  'supported V1 native updates change the selected CLI while preserving the engine generation',
  {
    skip: process.platform === 'win32' ? 'POSIX process fixture' : false,
  },
  async (t) => {
    const f = fixture(t, 'opencode');
    const selected = await f.index.publish(
      f.input('TEST-v1-update', f.candidate('TEST-v1-update', '1.19.5')),
      () => {}
    );
    assert.equal(selected.phase, 'published');
    assert.equal(selected.selection?.cliVersion, '1.19.5');
    assert.equal(selected.selection?.nativeGeneration, 'v1');
    assert.equal(selected.selection?.engineVersion, undefined);
    await assert.rejects(
      f.index.publish(
        f.input('TEST-v1-too-old', f.candidate('TEST-v1-too-old', '1.15.9')),
        () => {}
      ),
      { reason: 'unqualified-version' }
    );
    assert.deepEqual(f.reads(), ['TEST-v1-update']);
    await f.index.close();
  }
);

test(
  'V2 CLI policy cannot substitute another engine, cross generation or qualify unsupported engine versions',
  {
    skip:
      process.platform === 'linux' && process.arch === 'arm64'
        ? 'V2 is not qualified on linux-arm64'
        : false,
  },
  (t) => {
    const f = fixture(t, 'opencode'),
      seed = providerManagementProfileSchema.parse({
        ...f.profile.management![0]!,
        nativeGeneration: 'v2',
        protocolRevision: '2.1.4',
        nativeModel: { providerId: 'TEST-provider', modelId: 'TEST-model' },
        environment: {
          HOME: f.root,
          PATH: '/usr/bin',
          XDG_CONFIG_HOME: f.root,
          XDG_DATA_HOME: f.root,
          XDG_CACHE_HOME: f.root,
        },
        embedded: {
          version: '2.1.4',
          directory: f.root,
          manifestSha256: 'a'.repeat(64),
          platform: process.platform,
          arch: process.arch,
          externalDirectory: 'deny',
        },
      });
    const cli = f.candidate('TEST-v2-cli', '2.9.0');
    const selected: RuntimeSourceCandidate = {
      ...cli,
      executable: seed.executable,
      nativeCli: { ...cli.nativeCli!, generation: 'v2' },
    };
    assert.doesNotThrow(() => assertRuntimeSourceQualification(seed, selected));
    assert.throws(
      () => assertRuntimeSourceQualification(seed, { ...selected, executable: cli.executable }),
      { code: 'held' }
    );
    assert.throws(
      () =>
        assertRuntimeSourceNativePolicy(seed, {
          ...selected,
          nativeCli: { ...selected.nativeCli!, generation: 'v1' },
        }),
      { reason: 'generation-change-unqualified' }
    );
    assert.throws(
      () =>
        assertRuntimeSourceNativePolicy(seed, {
          ...selected,
          nativeCli: { ...selected.nativeCli!, version: '3.0.0' },
        }),
      { reason: 'unqualified-version' }
    );
    assert.throws(() =>
      providerManagementProfileSchema.parse({ ...seed, protocolRevision: '2.2.0' })
    );
    assert.deepEqual(
      f.reads(),
      [],
      'policy checks do not allocate a native process or qualify inference'
    );
  }
);
