import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { verifyOpenCodeV2EmbeddedGraph } from '../dist/adapters/providers/OpenCodeV2EmbeddedGraph.js';

import type { TestContext } from 'node:test';
import type { OpenCodeV2EmbeddedSelection } from '../dist/adapters/providers/OpenCodeV2EmbeddedGraph.js';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const server = 'local-cli/node_modules/@opencode/server-v2.1.4';
const effect = 'local-cli/node_modules/effect';
const nativeTuple =
  (process.platform === 'linux' && process.arch === 'x64') ||
  (process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch));
const tupleOptions = { skip: !nativeTuple };

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-embedded-delivery-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = {
    [`${server}/package.json`]: JSON.stringify({
      name: '@opencode/server',
      version: '2.1.4',
      dependencies: { effect: '4.0.1' },
    }),
    [`${server}/dist/process.js`]: 'export const start = () => {};\n',
    [`${effect}/package.json`]: JSON.stringify({
      name: 'effect',
      version: '4.0.1',
      exports: './dist/index.js',
    }),
    [`${effect}/dist/index.js`]: 'export const TEST = true;\n',
  };
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), bytes, { mode: 0o600 });
  }
  const manifest = JSON.stringify({
    schemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    requiredBunVersion: process.platform === 'darwin' ? '1.4.4' : '1.3.11',
    engineVersions: ['2.1.4'],
    files: Object.entries(files).map(([name, bytes]) => ({
      path: name,
      bytes: Buffer.byteLength(bytes),
      sha256: hash(bytes),
      executable: false,
    })),
  });
  await writeFile(path.join(directory, 'opencode-v2-engine-manifest.json'), manifest);
  const selection: OpenCodeV2EmbeddedSelection = {
    directory,
    manifestSha256: hash(manifest),
    version: '2.1.4',
    platform: process.platform,
    arch: process.arch,
  };
  return { directory, selection, files };
}

test(
  'delivery byte validation resolves the server and its own Effect within the verified graph',
  tupleOptions,
  async (t) => {
    const { directory, selection } = await fixture(t);
    const graph = await verifyOpenCodeV2EmbeddedGraph(selection);
    assert.equal(graph.modulePath, path.join(directory, server, 'dist/process.js'));
    assert.equal(graph.effectPath, path.join(directory, effect, 'dist/index.js'));
    assert.equal(graph.requiredBunVersion, process.platform === 'darwin' ? '1.4.4' : '1.3.11');
  }
);

for (const mutation of [
  'file',
  'manifest',
  'unlisted-file',
  'unlisted-directory',
  'hardlink',
] as const) {
  test(
    `delivery byte validation rejects ${mutation} changes before engine import`,
    tupleOptions,
    async (t) => {
      const { directory, selection } = await fixture(t);
      const file = path.join(directory, effect, 'dist/index.js');
      if (mutation === 'file') await writeFile(file, 'export const TEST = false;\n');
      if (mutation === 'manifest')
        await writeFile(path.join(directory, 'opencode-v2-engine-manifest.json'), '{}');
      if (mutation === 'unlisted-file')
        await writeFile(path.join(directory, 'local-cli/foreign.js'), 'TEST');
      if (mutation === 'unlisted-directory') await mkdir(path.join(directory, 'foreign'));
      if (mutation === 'hardlink') {
        const target = path.join(directory, server, 'dist/process.js');
        await rm(target);
        await link(file, target);
      }
      await assert.rejects(verifyOpenCodeV2EmbeddedGraph(selection));
    }
  );
}

test('delivery validation rejects symlinked graph files', tupleOptions, async (t) => {
  const { directory, selection } = await fixture(t);
  const file = path.join(directory, effect, 'dist/index.js');
  const target = path.join(directory, server, 'dist/process.js');
  await rm(target);
  await symlink(file, target);
  await assert.rejects(verifyOpenCodeV2EmbeddedGraph(selection));
});

test(
  'delivery validation rejects a pinned manifest with unsafe or duplicated paths',
  tupleOptions,
  async (t) => {
    const { directory, selection } = await fixture(t);
    const manifestPath = path.join(directory, 'opencode-v2-engine-manifest.json');
    const original = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const name of [
      '../outside.js',
      'local-cli/../outside.js',
      'local-cli\\outside.js',
      original.files[0].path,
    ]) {
      const manifest = JSON.stringify({
        ...original,
        files: [
          ...original.files,
          {
            path: name,
            bytes: 0,
            sha256: hash(''),
            executable: false,
          },
        ],
      });
      await writeFile(manifestPath, manifest);
      await assert.rejects(
        verifyOpenCodeV2EmbeddedGraph({ ...selection, manifestSha256: hash(manifest) })
      );
    }
  }
);

test(
  'delivery validation refuses another tuple or cancellation without importing code',
  tupleOptions,
  async (t) => {
    const { selection } = await fixture(t);
    await assert.rejects(verifyOpenCodeV2EmbeddedGraph({ ...selection, arch: 'not-current' }));
    await assert.rejects(verifyOpenCodeV2EmbeddedGraph(selection, AbortSignal.abort()));
  }
);

test(
  'executor version remains pinned by the selected platform delivery, even with a valid manifest hash',
  tupleOptions,
  async (t) => {
    const { directory, selection } = await fixture(t);
    const manifestPath = path.join(directory, 'opencode-v2-engine-manifest.json');
    const original = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const requiredBunVersion of [
      '0.0.1',
      process.platform === 'darwin' ? '1.3.11' : '1.4.4',
    ]) {
      const manifest = JSON.stringify({ ...original, requiredBunVersion });
      await writeFile(manifestPath, manifest);
      await assert.rejects(
        verifyOpenCodeV2EmbeddedGraph({ ...selection, manifestSha256: hash(manifest) })
      );
    }
  }
);
