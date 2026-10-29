import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { candidateDigest } from './candidate-closure.ts';
import { desktopNodeScriptHeader, prepareDesktopBackendFixture } from './desktop-backend-fixture.ts';
import { captureCandidateElectron, readCapturedCandidateElectron } from './candidate-electron.ts';
import { prepareDesktopSkillsFixture } from './desktop-skills-fixture.ts';
import { readCandidateRuntimePaths } from './candidate-runtime-paths.ts';

test('candidate reader refuses old or rebound code-mode metadata before native bridge admission', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST candidate helper census ')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const native = 'host/packages/native/claude';
  await mkdir(join(root, 'host/packages/native'), { recursive: true });
  await writeFile(join(root, native), 'TEST-claude', { mode: 0o755 });
  const manifest = {
    schemaVersion: 2, platform: `${process.platform}-${process.arch}`,
    node: { version: '24.21.0', binarySha256: 'a'.repeat(64) }, hostEntrySha256: 'b'.repeat(64),
    packages: [
      { name: '@anthropic-ai/claude-agent-sdk', version: 'TEST-1', path: 'packages/sdk', files: [], dependencies: {} },
      { name: `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`, version: 'TEST-1', path: 'packages/native',
        files: [{ path: 'claude', executable: true, sha256: await candidateDigest(join(root, native)) }], dependencies: {} },
    ],
    artifacts: ['@agent-teams/provider-implementations', '@agent-teams/provider-session-contracts'].map(name => ({ name, sha256: 'c'.repeat(64) })),
    nativeArtifacts: {
      captureSha256: 'd'.repeat(64),
      codex: { path: 'native/codex/codex', sha256: 'e'.repeat(64), protocolRevision: '0.162.0',
        codeModeHost: { path: 'native/codex/foreign-helper', sha256: 'f'.repeat(64) } },
      opencode: { path: 'native/opencode/opencode', sha256: '0'.repeat(64), protocolRevision: '1.19.4' },
      processCustody: { directory: 'intentionally-unavailable-bridge', library: 'registered-process.node',
        manifestSha256: '1'.repeat(64), binarySha256: '2'.repeat(64) },
    },
  };
  const check = async (value: unknown) => {
    const path = join(root, 'candidate.json'); await writeFile(path, JSON.stringify(value));
    await assert.rejects(readCandidateRuntimePaths(root, await candidateDigest(path)), /Codex code-mode/);
  };
  await check(manifest);
  const { codeModeHost: _missing, ...mainOnly } = manifest.nativeArtifacts.codex;
  await check({ ...manifest, nativeArtifacts: { ...manifest.nativeArtifacts, codex: mainOnly } });
});

test(
  'packed paths with spaces come only from captured resources; private runtime dirs remain caller-owned',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64' },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST packed candidate ')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bundleRoot = join(root, 'App Bundle.app');
    const resources = join(bundleRoot, 'Contents/Resources/legacy-agent-host');
    const files = [
      ['node/v24.21.0/TEST/node', 'TEST-node', true],
      ['host/packages/0000/dist/cli.js', 'TEST-host', false],
      ['host/packages/0001/sdk.mjs', 'TEST-sdk', false],
      ['host/packages/0002/claude', 'TEST-native', true],
      ['native/codex/codex', 'TEST-codex', true],
      ['native/opencode/opencode', 'TEST-opencode', true],
      ['process-custody/registered-process.node', 'TEST-M19-native', false],
      ['native/codex/codex-code-mode-host', 'TEST-code-mode-host', true],
    ] as const;
    for (const [name, bytes, executable] of files) {
      const target = join(resources, name);
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, bytes);
      await chmod(target, executable ? 0o755 : 0o644);
    }
    const packages = await Promise.all(
      [
        ['@agent-teams/legacy-agent-host', '0000', 'dist/cli.js', false],
        ['@anthropic-ai/claude-agent-sdk', '0001', 'sdk.mjs', false],
        [
          `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`,
          '0002',
          'claude',
          true,
        ],
      ].map(async ([name, id, file, executable]) => ({
        name,
        version: 'TEST-1',
        path: `packages/${id}`,
        dependencies: {},
        missingOptional: [],
        files: [
          {
            path: file,
            executable,
            sha256: await candidateDigest(join(resources, `host/packages/${id}/${file}`)),
          },
        ],
      }))
    );
    const bridge = {
      schemaVersion: 1,
      abi: 'napi-8',
      platform: 'darwin',
      architecture: 'arm64',
      osBuild: '24G90',
      library: 'registered-process.node',
      binarySha256: await candidateDigest(join(resources, files[6][0])),
    };
    await writeFile(join(resources, 'process-custody/manifest.json'), JSON.stringify(bridge));
    const manifest = {
      schemaVersion: 2,
      artifacts: [
        { name: '@agent-teams/provider-implementations', sha256: 'd'.repeat(64) },
        { name: '@agent-teams/provider-session-contracts', sha256: 'e'.repeat(64) },
      ],
      nativeArtifacts: {
        captureSha256: 'c'.repeat(64),
        codex: {
          path: files[4][0],
          sha256: await candidateDigest(join(resources, files[4][0])),
          protocolRevision: '0.162.0',
          codeModeHost: { path: files[7][0], sha256: await candidateDigest(join(resources, files[7][0])) },
        },
        opencode: {
          path: files[5][0],
          sha256: await candidateDigest(join(resources, files[5][0])),
          protocolRevision: '1.19.4',
        },
        processCustody: {
          directory: 'process-custody',
          manifestSha256: await candidateDigest(join(resources, 'process-custody/manifest.json')),
          library: 'registered-process.node',
          binarySha256: bridge.binarySha256,
        },
      },
      platform: `${process.platform}-${process.arch}`,
      node: {
        version: '24.21.0',
        binarySha256: await candidateDigest(join(resources, files[0][0])),
      },
      nodeExecutable: files[0][0],
      hostEntry: files[1][0],
      hostEntrySha256: await candidateDigest(join(resources, files[1][0])),
      packages,
    };
    const path = join(resources, 'candidate.json');
    await writeFile(path, JSON.stringify(manifest));
    const digest = await candidateDigest(path);
    const selected = await readCandidateRuntimePaths(resources, digest);
    await mkdir(join(bundleRoot, 'Contents/MacOS'));
    const appExecutable = join(bundleRoot, 'Contents/MacOS/Test App');
    const appAsar = join(bundleRoot, 'Contents/Resources/app.asar');
    await writeFile(appExecutable, 'TEST-app-unrunnable-bytes');
    await chmod(appExecutable, 0o755);
    await writeFile(appAsar, 'TEST-ASAR-unrunnable-bytes');
    const capturePath = join(root, 'packed-capture.json');
    const captureOptions = {
      bundleRoot,
      executableName: 'Test App',
      candidateManifestSha256: digest,
      output: capturePath,
    };
    const capture = await captureCandidateElectron(captureOptions);
    await assert.rejects(captureCandidateElectron(captureOptions), { code: 'EEXIST' });
    const packed = await readCapturedCandidateElectron(capture);
    assert.equal(packed.executable, appExecutable);
    assert.equal(packed.runtime.hostEntry, selected.hostEntry);
    const corepack = join(root, 'TEST-corepack');
    await mkdir(join(corepack, 'dist/lib'), { recursive: true });
    await writeFile(
      join(corepack, 'package.json'),
      JSON.stringify({ name: 'corepack', version: 'TEST-1' })
    );
    await writeFile(join(corepack, 'dist/pnpm.js'), 'TEST-package-manager-never-executed');
    await writeFile(join(corepack, 'dist/lib/corepack.cjs'), 'TEST-corepack-never-executed');
    await writeFile(
      join(root, 'runtime.lock.json'),
      JSON.stringify({ cliVersion: 'TEST-version' })
    );
    const fixture = await prepareDesktopBackendFixture(root, {
      candidateRuntime: selected,
      pnpmEntry: join(corepack, 'dist/pnpm.js'),
    });
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const profile = JSON.parse(await readFile(fixture.profilePath, 'utf8'));
    const descriptor = JSON.parse(await readFile(fixture.descriptorPath, 'utf8'));
    assert.equal(fixture.node, selected.nodeExecutable);
    assert.equal(fixture.hostEntry, selected.hostEntry);
    assert.equal(profile.owner.nodeSha256, selected.nodeSha256);
    assert.equal(profile.owner.hostEntrySha256, selected.hostEntrySha256);
    assert.deepEqual(profile.processCustody, selected.processCustody);
    assert.equal(descriptor.owners[0].profile.nodeExecutable, selected.nodeExecutable);
    assert.equal(descriptor.owners[0].profile.hostEntry, selected.hostEntry);

    // Only harmless generated TEST shims run: no app, Host, provider or model launch.
    const pinnedNode = await realpath(process.execPath);
    const nodeDirectory = join(root, "Node's App Bundle.app/Contents/Node runtime");
    await mkdir(nodeDirectory, { recursive: true });
    const spacedNode = join(nodeDirectory, 'node');
    await symlink(pinnedNode, spacedNode);
    const probe = join(root, 'TEST argv probe');
    await writeFile(
      probe,
      desktopNodeScriptHeader(spacedNode) +
        'process.stdout.write(JSON.stringify({script:process.argv[1],args:process.argv.slice(2)}));\n',
      { mode: 0o700 }
    );
    const args = ['TEST spaces', "TEST apostrophe's", '--TEST=value with spaces', '$TEST;`literal`'];
    const probed = spawnSync(probe, args, { env: { HOME: root, PATH: '/TEST-NO-PATH' }, encoding: 'utf8', timeout: 5000 });
    assert.equal(probed.error, undefined);
    assert.equal(probed.status, 0, probed.stderr);
    assert.deepEqual(JSON.parse(probed.stdout), { script: probe, args });
    const executableFixture = await prepareDesktopBackendFixture(root, {
      candidateRuntime: { ...selected, nodeExecutable: spacedNode },
      pnpmEntry: join(corepack, 'dist/pnpm.js'),
    });
    t.after(() => rm(executableFixture.root, { recursive: true, force: true }));
    const env = { ...executableFixture.appEnvironment, PATH: '/TEST-NO-PATH' };
    const refused = spawnSync(join(executableFixture.root, 'bin/codex'), ['--version'], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(refused.error, undefined);
    assert.equal(refused.status, 78);
    assert.match(refused.stderr, /TEST sentinel refuses native agent invocation/);
    const allowed = spawnSync(join(executableFixture.root, 'bin/shell-env'), ['-lic', 'env -0'], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(allowed.error, undefined);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.ok(allowed.stdout.split('\0').includes('HOME=' + env.HOME));
    const rejectedShell = spawnSync(join(executableFixture.root, 'bin/shell-env'), ['-lic', 'TEST refuses evaluation'], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(rejectedShell.error, undefined);
    assert.equal(rejectedShell.status, 78);
    const invocations = (await readFile(executableFixture.sentinelLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(invocations, [
      { executable: 'codex', allowed: false, argc: 1, flags: ['--version'] },
      { executable: 'shell-env', allowed: true, argc: 2, flags: ['-lic'] },
      { executable: 'shell-env', allowed: false, argc: 2, flags: ['-lic'] },
    ]);
    await prepareDesktopSkillsFixture(executableFixture);
    for (const [name, args] of [
      ['skills-claude-management', ['auth', 'status', '--json']],
      ['skills-codex-management', ['app-server', '--listen', 'stdio://']],
    ] as const) {
      const metadata = spawnSync(join(executableFixture.root, 'bin', name), [...args], { env, encoding: 'utf8', timeout: 5000 });
      assert.equal(metadata.error, undefined);
      assert.equal(metadata.status, 78);
      assert.match(metadata.stderr, /TEST refuses metadata process/);
    }
    const metadataRows = (await readFile(executableFixture.sentinelLog, 'utf8')).trim().split('\n').slice(3).map(line => JSON.parse(line));
    assert.deepEqual(metadataRows, [
      { executable: 'skills-claude-management', allowed: false, skillsMetadataRefusal: true, operation: 'auth.status', argc: 3, flags: ['--json'] },
      { executable: 'skills-codex-management', allowed: false, skillsMetadataRefusal: true, operation: 'app-server.read', argc: 3, flags: ['--listen'] },
    ]);

    assert.match(packed.rendererUrl, /^file:/);
    assert.ok(packed.rendererUrl.includes('App%20Bundle.app'));
    await writeFile(appAsar, 'CHANGED-ASAR');
    await assert.rejects(readCapturedCandidateElectron(capture), /output mismatch/);
    await writeFile(appAsar, 'TEST-ASAR-unrunnable-bytes');
    const descriptorProfile = {
      ...selected,
      cwd: join(root, 'TEST-workspace'),
      env: { HOME: join(root, 'TEST-private-home') },
    };
    assert.equal(selected.nodeExecutable, join(resources, files[0][0]));
    assert.equal(selected.claudeExecutable, join(resources, files[3][0]));
    assert.equal(selected.codexExecutable, join(resources, files[4][0]));
    assert.equal(selected.openCodeExecutable, join(resources, files[5][0]));
    assert.equal(selected.processCustody.directory, join(resources, 'process-custody'));
    for (const item of [files[4], files[5], files[6], files[7]]) {
      await writeFile(join(resources, item[0]), 'CHANGED-native-bytes');
      await assert.rejects(readCandidateRuntimePaths(resources, digest), /file mismatch/);
      await writeFile(join(resources, item[0]), item[1]);
    }
    assert.equal(descriptorProfile.env.HOME, join(root, 'TEST-private-home'));
    assert.ok(!JSON.stringify(selected).includes('TEST-private-home'));
    await assert.rejects(readCandidateRuntimePaths(resources, '0'.repeat(64)), /manifest mismatch/);
    await writeFile(join(resources, files[2][0]), 'CHANGED-sdk');
    await assert.rejects(readCandidateRuntimePaths(resources, digest), /file mismatch/);
  }
);
