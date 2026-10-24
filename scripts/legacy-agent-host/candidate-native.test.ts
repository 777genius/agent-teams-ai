import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { candidateDigest } from './candidate-closure.ts';
import { stageCandidateNativeArtifacts } from './candidate-native.ts';

test(
  'explicit native capture relocates both providers and exact M19 pair without running bytes',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64' },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST candidate natives ')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, 'TEST source');
    const bridge = join(source, 'bridge');
    const output = join(root, 'App Resources/legacy-agent-host');
    await mkdir(bridge, { recursive: true });
    await mkdir(output, { recursive: true });
    for (const name of ['codex', 'opencode']) {
      await writeFile(join(source, name), `TEST-${name}-bytes; deliberately not executable code`);
      await chmod(join(source, name), 0o755);
    }
    await writeFile(
      join(bridge, 'registered-process.node'),
      'TEST-M19-bytes; deliberately not a native library'
    );
    const manifest = {
      schemaVersion: 1,
      abi: 'napi-8',
      platform: 'darwin',
      architecture: 'arm64',
      osBuild: '24G90',
      library: 'registered-process.node',
      binarySha256: await candidateDigest(join(bridge, 'registered-process.node')),
    };
    await writeFile(join(bridge, 'manifest.json'), JSON.stringify(manifest));
    const capture = {
      schemaVersion: 1,
      platform: `${process.platform}-${process.arch}`,
      codex: {
        path: join(source, 'codex'),
        sha256: await candidateDigest(join(source, 'codex')),
        protocolRevision: '0.162.0',
      },
      opencode: {
        path: join(source, 'opencode'),
        sha256: await candidateDigest(join(source, 'opencode')),
        protocolRevision: '1.19.4',
      },
      processCustody: {
        directory: bridge,
        manifestSha256: await candidateDigest(join(bridge, 'manifest.json')),
      },
    };
    const path = join(root, 'capture.json');
    await writeFile(path, JSON.stringify(capture));
    const selected = { path, sha256: await candidateDigest(path) };
    await assert.rejects(
      stageCandidateNativeArtifacts(output, { path, sha256: '0'.repeat(64) }, capture.platform),
      /capture mismatch/
    );
    const actual = await stageCandidateNativeArtifacts(output, selected, capture.platform);
    await rm(source, { recursive: true });
    assert.equal(await candidateDigest(join(output, actual.codex.path)), capture.codex.sha256);
    assert.equal(
      await candidateDigest(join(output, actual.opencode.path)),
      capture.opencode.sha256
    );
    assert.equal(
      await candidateDigest(
        join(output, actual.processCustody.directory, actual.processCustody.library)
      ),
      manifest.binarySha256
    );
    assert.equal(
      await candidateDigest(join(output, actual.processCustody.directory, 'manifest.json')),
      capture.processCustody.manifestSha256
    );
    assert.ok(!(await readFile(join(output, actual.codex.path), 'utf8')).startsWith('#!'));
    assert.ok(
      !JSON.stringify(actual).includes(source),
      'candidate manifest has no source dependency'
    );
  }
);
