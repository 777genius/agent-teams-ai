#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Builds the self-contained stdio agent-teams MCP bundle that host-local
 * hosted agents run under a pinned Node 24. The digest written next to it is
 * the pin the core issuer verifies before staging the entry for Owner.
 */
export async function buildAgentTeamsMcpArtifact({ root = repositoryRoot, build = runPnpmBuild } = {}) {
  await build(root);
  const entry = join(root, 'mcp-server', 'dist', 'index.js');
  const stat = await lstat(entry);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error('agent-teams-mcp-artifact-entry-invalid');
  }
  const sha256 = createHash('sha256').update(await readFile(entry)).digest('hex');
  // sha256sum -c compatible, so operators can verify the entry by hand.
  await writeFile(`${entry}.sha256`, `${sha256}  index.js\n`, { mode: 0o644 });
  return Object.freeze({ entry, sha256 });
}

function runPnpmBuild(root) {
  const result = spawnSync('pnpm', ['--filter', 'agent-teams-mcp', 'build'], {
    // Build logs go to stderr; stdout carries only the artifact JSON.
    cwd: root, stdio: ['ignore', 2, 2],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`agent-teams-mcp build exited with status ${String(result.status)}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const artifact = await buildAgentTeamsMcpArtifact();
  process.stdout.write(`${JSON.stringify(artifact)}\n`);
}
