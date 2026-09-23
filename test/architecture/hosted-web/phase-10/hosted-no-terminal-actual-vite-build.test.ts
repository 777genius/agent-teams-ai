// @vitest-environment node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  verifyHostedRendererGraph,
  // @ts-expect-error The repository-owned JavaScript artifact verifier has no declaration file.
} from '../../../../scripts/ci/verify-hosted-no-terminal-artifact.mjs';

describe('Hosted renderer actual Vite production output', () => {
  const root = mkdtempSync(join(tmpdir(), 'hosted-renderer-actual-build-'));
  const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

  afterAll(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it('binds the emitted HTML and static imports to the callable browser API', () => {
    const output = join(root, 'out/renderer');
    const execution = spawnSync(
      process.execPath,
      [
        './node_modules/vite/bin/vite.js',
        'build',
        '--config',
        'docker/vite.hosted-renderer.config.ts',
        '--outDir',
        output,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, AGENT_TEAMS_DISABLE_SOURCEMAPS: '1' },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      }
    );

    expect(execution.error).toBeUndefined();
    expect(execution.status, `${execution.stdout}\n${execution.stderr}`).toBe(0);
    expect(verifyHostedRendererGraph(root)).toMatchObject({ ok: true, violations: [] });

    // Keep all digests valid so this fails specifically on an import site added
    // after Vite's emitted program, beyond the leading static imports.
    const manifestPath = join(output, 'hosted-renderer-graph.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      chunks: {
        fileName: string;
        facadeModuleId: string | null;
        moduleIds: string[];
        sha256: string;
      }[];
      graphSha256: string;
    };
    const main = manifest.chunks.find((chunk) =>
      chunk.moduleIds.includes('src/renderer/hosted/main.tsx')
    );
    const installer = manifest.chunks.find(
      (chunk) =>
        chunk.facadeModuleId === 'src/renderer/hosted/hostedCoordinationEventStreamBrowserEntry.ts'
    );
    expect(main).toBeDefined();
    expect(installer).toBeDefined();
    if (!main || !installer) throw new Error('Actual Vite entry chunks missing');
    const mainPath = join(output, main.fileName);
    const originalMain = readFileSync(mainPath, 'utf8');
    for (const suffix of [
      `\nvoid import("./${basename(installer.fileName)}");\n`,
      '\nfunction lazy(){return `${`prefix` + import("./not-in-graph.js")}`};\n',
      '\n// comment ends at U+2028\u2028import("./not-in-graph.js");\n',
      '\nlet n=0; n++ / import("./not-in-graph.js") / 2;\n',
      '\nlet n=0; n++ / import("./not-in-graph.js") / 2; //"\n',
    ]) {
      const mutatedMain = originalMain + suffix;
      writeFileSync(mainPath, mutatedMain);
      main.sha256 = digest(mutatedMain);
      const graph = { ...manifest, graphSha256: undefined };
      writeFileSync(
        manifestPath,
        `${JSON.stringify({ ...graph, graphSha256: digest(JSON.stringify(graph)) })}\n`
      );
      const rejection = verifyHostedRendererGraph(root);
      expect(rejection.ok).toBe(false);
      expect(rejection.violations).toContain(
        `hosted_renderer_graph_emitted_static_edge_invalid:${main.fileName}`
      );
      expect(rejection.violations).not.toContain(
        `hosted_renderer_graph_chunk_digest_mismatch:${main.fileName}`
      );
    }
  }, 130_000);
});
