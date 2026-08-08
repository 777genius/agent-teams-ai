import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('built state compatibility manifest', () => {
  it('generates a deterministic manifest with a matching detached digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-built-manifest-'));
    roots.push(root);
    const output = join(root, 'manifest.json');
    const command = [
      'scripts/hosted-web/phase-10/state-compatibility/generate-built-manifest.mjs',
      '--output',
      output,
    ];

    expect(spawnSync(process.execPath, command).status).toBe(0);
    const first = await readFile(output, 'utf8');
    expect(spawnSync(process.execPath, command).status).toBe(0);
    const second = await readFile(output, 'utf8');
    const digest = (await readFile(`${output}.sha256`, 'utf8')).trim();

    expect(second).toBe(first);
    expect(digest).toBe(createHash('sha256').update(second).digest('hex'));
    expect(JSON.parse(second)).toMatchObject({
      format: 'hosted-state-compatibility-manifest/v1',
      schemaVersion: 1,
      hostedStateSchemaVersion: 1,
      minimumReadableHostedStateVersion: 1,
      orderedMigrations: [],
    });
  });

  it('withholds startup and recovery exposure until the production composition lane mounts it', async () => {
    const dockerfile = await readFile('docker/Dockerfile', 'utf8');

    expect(dockerfile).not.toContain(
      'node scripts/hosted-web/phase-10/state-compatibility/generate-built-manifest.mjs'
    );
    expect(dockerfile).not.toContain(
      'COPY scripts/hosted-web/phase-10/state-compatibility/stopped-stack-recovery.mjs ./scripts/hosted-stopped-stack-recovery.mjs'
    );
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/hosted-entrypoint"]');
  });
});
