import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildAgentTeamsMcpArtifact } from './build-agent-teams-mcp-artifact.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('pins the built entry with a sha256sum-compatible digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-teams-mcp-artifact-test-'));
  try {
    const bytes = 'console.log("mcp")\n';
    const artifact = await buildAgentTeamsMcpArtifact({ root, build: async buildRoot => {
      await mkdir(join(buildRoot, 'mcp-server', 'dist'), { recursive: true });
      await writeFile(join(buildRoot, 'mcp-server', 'dist', 'index.js'), bytes);
    } });
    assert.deepEqual(artifact, { entry: join(root, 'mcp-server', 'dist', 'index.js'), sha256: sha256(bytes) });
    assert.equal(await readFile(`${artifact.entry}.sha256`, 'utf8'), `${sha256(bytes)}  index.js\n`);
    await assert.rejects(buildAgentTeamsMcpArtifact({ root: join(root, 'missing'), build: async () => {} }),
      /ENOENT/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('real pnpm build yields a self-contained entry matching its digest', async t => {
  const repository = fileURLToPath(new URL('../..', import.meta.url));
  const installed = await access(join(repository, 'mcp-server', 'node_modules', '.bin', 'tsup'))
    .then(() => true, () => false);
  if (!installed) {
    t.skip('requires installed workspace dependencies');
    return;
  }
  const artifact = await buildAgentTeamsMcpArtifact();
  const bytes = await readFile(artifact.entry);
  assert.equal(sha256(bytes), artifact.sha256);
  assert.equal(await readFile(`${artifact.entry}.sha256`, 'utf8'), `${artifact.sha256}  index.js\n`);
  // noExternal bundling: the host copy runs without any node_modules tree.
  assert.doesNotMatch(bytes.toString('utf8'), /from ["'](?:fastmcp|zod|agent-teams-controller)["']/u);
});
