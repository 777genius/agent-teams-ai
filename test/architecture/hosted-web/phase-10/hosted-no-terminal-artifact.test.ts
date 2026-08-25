// @vitest-environment node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HOSTED_RENDERER_GRAPH_MANIFEST,
  PNPM_INSTALL_METADATA,
  pruneForbiddenHostedPackages,
  verifyHostedNoTerminalArtifact,
  verifyHostedNoTerminalDockerfile,
  verifyHostedRendererGraph,
  // @ts-expect-error The repository-owned JavaScript artifact verifier has no declaration file.
} from '../../../../scripts/ci/verify-hosted-no-terminal-artifact.mjs';

const fixtures: string[] = [];
const verifierPath = 'scripts/ci/verify-hosted-no-terminal-artifact.mjs';

function writeFixture(root: string, artifactPath: string, contents = ''): string {
  const path = join(root, ...artifactPath.split('/'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

function createArtifactFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'hosted-no-terminal-artifact-'));
  fixtures.push(root);
  writeFixture(
    root,
    'node_modules/better-sqlite3/index.js',
    `module.exports = class Database {
      constructor(filename) {
        if (filename !== ':memory:') throw new Error('unexpected database');
      }
      prepare(sql) {
        if (sql !== 'SELECT 1 AS value') throw new Error('unexpected query');
        return { get: () => ({ value: 1 }) };
      }
      close() {}
    };\n`
  );
  writeFixture(
    root,
    'node_modules/better-sqlite3/package.json',
    '{"name":"better-sqlite3","main":"index.js"}\n'
  );
  writeFixture(root, 'dist-standalone/index.cjs', "require('better-sqlite3');\n");
  return root;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeHostedRendererGraphFixture(
  root: string,
  options: {
    readonly moduleId?: string;
    readonly importedSpecifier?: string;
    readonly chunkImport?: string;
    readonly chunkSource?: string;
  } = {}
): void {
  const chunkSource = options.chunkSource ?? 'console.log("hosted renderer");\n';
  const moduleId = options.moduleId ?? 'src/renderer/hosted/main.tsx';
  writeFixture(root, 'out/renderer/index.html', '<div id="root"></div>\n');
  writeFixture(root, 'out/renderer/assets/main-proof.js', chunkSource);
  const graph = {
    schemaVersion: 1,
    entryHtml: 'index.html',
    chunks: [
      {
        fileName: 'assets/main-proof.js',
        imports: options.chunkImport ? [options.chunkImport] : [],
        dynamicImports: [],
        moduleIds: [moduleId],
        sha256: sha256(chunkSource),
      },
    ],
    modules: [
      {
        id: moduleId,
        importedSpecifiers: options.importedSpecifier ? [options.importedSpecifier] : [],
        resolvedImports: [],
        resolvedDynamicImports: [],
      },
    ],
  };
  writeFixture(
    root,
    `out/renderer/${HOSTED_RENDERER_GRAPH_MANIFEST}`,
    `${JSON.stringify({ ...graph, graphSha256: sha256(JSON.stringify(graph)) }, null, 2)}\n`
  );
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

describe('Phase 10 hosted production artifact terminal exclusion', () => {
  it('makes pruning and final verification part of the Docker build without desktop mutation', () => {
    const dockerfile = readFileSync('docker/Dockerfile', 'utf8');
    const result = verifyHostedNoTerminalDockerfile(dockerfile);

    expect(result).toEqual({ ok: true, violations: [] });
    expect(dockerfile).toContain('pnpm rebuild better-sqlite3');
    expect(dockerfile).not.toMatch(
      /pnpm rebuild[^\n]*(?:node-pty|ssh2|cpu-features|terminal-platform-node|@terminal-platform)/
    );
    expect(dockerfile).not.toMatch(
      /require(?:\.resolve)?\s*\(\s*['"](?:node-pty|ssh2|cpu-features|terminal-platform-node|@terminal-platform)/
    );
    expect(dockerfile.match(/verify-hosted-no-terminal-artifact\.mjs --root \/app/g)).toHaveLength(
      2
    );
    expect(dockerfile).toContain('--prune --require-better-sqlite3');
    expect(dockerfile).toContain('--require-better-sqlite3 --require-hosted-renderer-graph');
    expect(dockerfile).toContain('COPY --from=prod-deps /app/node_modules ./node_modules');

    const finalStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM base\n'));
    expect(finalStage).toContain('COPY --from=prod-deps /app/package.json ./');
    expect(finalStage).not.toContain('/app/pnpm-lock.yaml');
    expect(finalStage).not.toMatch(/COPY[^\n]*(?:resources|vendor)\/terminal-platform/);
  });

  it('builds standalone from the dedicated hosted entry before the unchanged server config', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['standalone:build']).toBe(
      'node --max-old-space-size=8192 ./node_modules/vite/bin/vite.js build --config docker/vite.hosted-renderer.config.ts && node --max-old-space-size=8192 ./node_modules/vite/bin/vite.js build --config docker/vite.standalone.config.ts'
    );

    const config = readFileSync('docker/vite.hosted-renderer.config.ts', 'utf8');
    const hostedMain = readFileSync('src/renderer/hosted/main.tsx', 'utf8');
    const workspace = readFileSync('src/renderer/components/team/HostedTeamWorkspace.tsx', 'utf8');
    expect(config).toContain("resolve(ROOT, 'src/renderer/hosted')");
    expect(config).toContain("resolve(ROOT, 'out/renderer')");
    expect(config).toContain('createHostedRendererGraphProofPlugin()');
    expect(config).toMatch(
      /plugins:\s*\[\s*createHostedRendererGraphProofPlugin\(\),\s*createHostedTaskBoardRendererBoundaryPlugin\(\)/u
    );
    expect(config).toContain(
      'export { createHostedTaskBoardTransport, HOSTED_TASK_BOARD_PAGE_HTTP_PATH }'
    );
    expect(config).toContain("enforce: 'pre'");
    expect(hostedMain).toContain('<LocalizationProvider appConfig={null}>');
    expect(hostedMain).toContain('<HostedAuthGate>');
    expect(hostedMain).toContain('<HostedApplicationShell />');
    expect(hostedMain).not.toMatch(
      /@renderer\/(?:App|main|store|notifications|sentry|telemetry)|@features\/app-close-coordination/iu
    );
    expect(workspace).toContain('createHostedTeamLifecycleTransport');
    expect(workspace).toContain('HostedTeamMessagePanel');
    expect(workspace).toContain('createHostedTeamMessageTransport');
    expect(workspace).toContain("from '@features/team-message-delivery/renderer'");
    expect(workspace).not.toContain('HostedTeamConsoleMessagePanel');
    expect(workspace).not.toContain('createHostedTeamConsoleMessageTransport');
    expect(workspace).toContain('<HostedTaskBoardPage');
    expect(workspace).toContain('key={selectedTeamId}');
    expect(workspace).not.toContain("from '@renderer/api'");
  });

  it('requires a content-bound graph row for every final hosted JavaScript chunk', () => {
    const root = createArtifactFixture();
    writeHostedRendererGraphFixture(root);

    expect(verifyHostedRendererGraph(root)).toMatchObject({ ok: true, violations: [] });
    expect(
      verifyHostedNoTerminalArtifact(root, {
        requireBetterSqlite3: true,
        requireHostedRendererGraph: true,
      })
    ).toMatchObject({
      ok: true,
      hostedRendererGraph: { ok: true, violations: [] },
      violations: [],
    });

    writeFixture(root, 'out/renderer/assets/unrepresented.js', 'void 0;\n');
    expect(verifyHostedRendererGraph(root).violations).toContain(
      'hosted_renderer_graph_chunk_inventory_mismatch'
    );
  });

  it('rejects forbidden resolved module IDs, specifiers and changed chunk bytes', () => {
    const forbiddenModuleRoot = createArtifactFixture();
    writeHostedRendererGraphFixture(forbiddenModuleRoot, {
      moduleId: 'src/renderer/api/httpClient.ts',
    });
    expect(verifyHostedRendererGraph(forbiddenModuleRoot).violations).toContain(
      'hosted_renderer_graph_forbidden_reference:broad_renderer_api:src/renderer/api/httpClient.ts'
    );

    const forbiddenNotificationRoot = createArtifactFixture();
    writeHostedRendererGraphFixture(forbiddenNotificationRoot, {
      moduleId: 'src/renderer/components/notifications/NotificationsView.tsx',
    });
    expect(verifyHostedRendererGraph(forbiddenNotificationRoot).violations).toContain(
      'hosted_renderer_graph_forbidden_reference:desktop_renderer_notifications:src/renderer/components/notifications/NotificationsView.tsx'
    );

    const forbiddenTerminalRoot = createArtifactFixture();
    writeHostedRendererGraphFixture(forbiddenTerminalRoot, {
      moduleId: 'src/renderer/components/runtime/providerTerminalCommands.ts',
    });
    expect(verifyHostedRendererGraph(forbiddenTerminalRoot).violations).toContain(
      'hosted_renderer_graph_forbidden_reference:terminal_ui_or_runtime:src/renderer/components/runtime/providerTerminalCommands.ts'
    );

    const nonCanonicalModuleRoot = createArtifactFixture();
    writeHostedRendererGraphFixture(nonCanonicalModuleRoot, {
      moduleId: 'src/renderer/components/../api/httpClient.ts',
    });
    expect(verifyHostedRendererGraph(nonCanonicalModuleRoot).violations).toContain(
      'hosted_renderer_graph_module_invalid'
    );

    const forbiddenSpecifierRoot = createArtifactFixture();
    writeHostedRendererGraphFixture(forbiddenSpecifierRoot, {
      importedSpecifier: '@terminal-platform/workspace-core',
    });
    expect(verifyHostedRendererGraph(forbiddenSpecifierRoot).violations).toContain(
      'hosted_renderer_graph_forbidden_reference:terminal_ui_or_runtime:@terminal-platform/workspace-core'
    );

    const forbiddenChunkImportRoot = createArtifactFixture();
    writeHostedRendererGraphFixture(forbiddenChunkImportRoot, { chunkImport: 'node-pty' });
    expect(verifyHostedRendererGraph(forbiddenChunkImportRoot).violations).toContain(
      'hosted_renderer_graph_forbidden_reference:terminal_ui_or_runtime:node-pty'
    );

    const changedChunkRoot = createArtifactFixture();
    writeHostedRendererGraphFixture(changedChunkRoot);
    writeFixture(changedChunkRoot, 'out/renderer/assets/main-proof.js', 'changed after proof\n');
    expect(verifyHostedRendererGraph(changedChunkRoot).violations).toContain(
      'hosted_renderer_graph_chunk_digest_mismatch:assets/main-proof.js'
    );
  });

  it('reports forbidden direct, virtual-store, resource and runtime-load artifacts', () => {
    const root = createArtifactFixture();
    writeFixture(root, 'node_modules/node-pty/index.js');
    writeFixture(root, 'node_modules/ssh2/index.js');
    writeFixture(root, 'node_modules/.pnpm/cpu-features@0.0.10/index.js');
    writeFixture(root, 'node_modules/.pnpm/terminal-platform-node@file+vendor/index.js');
    writeFixture(root, 'node_modules/@terminal-platform/workspace-core/index.js');
    writeFixture(root, 'resources/terminal-platform/native/manifest.json', '{}\n');
    writeFixture(
      root,
      'out/renderer/assets/forbidden-loads.js',
      `require('node-pty');
       module.require('ssh2/lib/client');
       void import('cpu-features');
       const native = __require('terminal-platform-node');
       import runtime from '@terminal-platform/workspace-core';
       void native;
       void runtime;\n`
    );

    const result = verifyHostedNoTerminalArtifact(root, { requireBetterSqlite3: true });
    expect(result.ok).toBe(false);
    expect(result.forbiddenPaths.map((entry: { path: string }) => entry.path)).toEqual(
      expect.arrayContaining([
        'node_modules/.pnpm/cpu-features@0.0.10',
        'node_modules/.pnpm/terminal-platform-node@file+vendor',
        'node_modules/@terminal-platform',
        'node_modules/node-pty',
        'node_modules/ssh2',
        'resources/terminal-platform',
      ])
    );
    const forbiddenSpecifiers = result.forbiddenLoads.map(
      (entry: { specifier: string }) => entry.specifier
    );
    expect(forbiddenSpecifiers).toHaveLength(5);
    expect(forbiddenSpecifiers).toEqual(
      expect.arrayContaining([
        '@terminal-platform/workspace-core',
        'cpu-features',
        'node-pty',
        'ssh2/lib/client',
        'terminal-platform-node',
      ])
    );
    expect(result.betterSqlite3).toEqual({ functional: true, present: true });
  });

  it('fails closed for escaping symlinks and canonical in-root forbidden symlink targets', () => {
    const absoluteRoot = createArtifactFixture();
    const absoluteOutside = mkdtempSync(join(tmpdir(), 'hosted-no-terminal-outside-'));
    fixtures.push(absoluteOutside);
    writeFixture(absoluteOutside, 'native/index.js', 'module.exports = true;\n');
    const absoluteLink = join(absoluteRoot, 'node_modules', 'allowed-absolute');
    symlinkSync(absoluteOutside, absoluteLink, 'dir');

    const absoluteResult = verifyHostedNoTerminalArtifact(absoluteRoot);
    expect(absoluteResult.ok).toBe(false);
    expect(absoluteResult.forbiddenPaths).toContainEqual(
      expect.objectContaining({
        kind: 'symlink_target_outside_artifact',
        path: 'node_modules/allowed-absolute',
        target: absoluteOutside,
      })
    );

    const relativeRoot = createArtifactFixture();
    const relativeOutside = mkdtempSync(join(tmpdir(), 'hosted-no-terminal-outside-'));
    fixtures.push(relativeOutside);
    writeFixture(relativeOutside, 'native/index.js', 'module.exports = true;\n');
    const relativeLink = join(relativeRoot, 'node_modules', 'allowed-relative');
    symlinkSync(relative(dirname(relativeLink), relativeOutside), relativeLink, 'dir');

    const relativeResult = verifyHostedNoTerminalArtifact(relativeRoot);
    expect(relativeResult.ok).toBe(false);
    expect(relativeResult.forbiddenPaths).toContainEqual(
      expect.objectContaining({
        kind: 'symlink_target_outside_artifact',
        path: 'node_modules/allowed-relative',
        target: relative(dirname(relativeLink), relativeOutside),
      })
    );

    const inRoot = createArtifactFixture();
    writeFixture(inRoot, 'node_modules/node-pty/build/Release/pty.node', 'native payload\n');
    symlinkSync('node-pty', join(inRoot, 'node_modules', 'allowed-native'), 'dir');

    const inRootResult = verifyHostedNoTerminalArtifact(inRoot);
    expect(inRootResult.ok).toBe(false);
    expect(inRootResult.forbiddenPaths).toContainEqual({
      kind: 'forbidden_symlink_target',
      path: 'node_modules/allowed-native',
      target: 'node_modules/node-pty',
    });
  });

  it('rejects forbidden Docker rebuilds and inline requires', () => {
    const dockerfile = readFileSync('docker/Dockerfile', 'utf8');
    const forbiddenRebuild = dockerfile.replace(
      'pnpm rebuild better-sqlite3',
      'pnpm rebuild better-sqlite3 node-pty'
    );
    const forbiddenRequire = dockerfile.replace(
      'pnpm rebuild better-sqlite3 \\',
      `pnpm rebuild better-sqlite3 \\
  && node -e "require('ssh2')" \\`
    );

    expect(verifyHostedNoTerminalDockerfile(forbiddenRebuild).violations).toContain(
      'forbidden_runtime_rebuild'
    );
    expect(verifyHostedNoTerminalDockerfile(forbiddenRequire).violations).toContain(
      'forbidden_runtime_require'
    );
  });

  it('prunes direct and pnpm virtual-store payloads while retaining functional better-sqlite3', () => {
    const root = createArtifactFixture();
    for (const artifactPath of [
      'node_modules/node-pty/index.js',
      'node_modules/ssh2/index.js',
      'node_modules/.pnpm/node_modules/cpu-features/index.js',
      'node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/index.js',
      'node_modules/.pnpm/ssh2@1.17.0/node_modules/ssh2/index.js',
      'node_modules/.pnpm/cpu-features@0.0.10/node_modules/cpu-features/index.js',
      'node_modules/.pnpm/terminal-platform-node@file+vendor/node_modules/terminal-platform-node/index.js',
      'node_modules/.pnpm/@terminal-platform+workspace-core@file+vendor/index.js',
      'node_modules/@terminal-platform/workspace-core/index.js',
    ]) {
      writeFixture(root, artifactPath);
    }
    for (const metadataPath of PNPM_INSTALL_METADATA) {
      writeFixture(root, metadataPath, 'node-pty: present\n');
    }
    writeFixture(root, 'node_modules/allowed-package/index.js', 'module.exports = true;\n');

    const removed = pruneForbiddenHostedPackages(root);
    const result = verifyHostedNoTerminalArtifact(root, { requireBetterSqlite3: true });

    expect(removed).toEqual(expect.arrayContaining(PNPM_INSTALL_METADATA));
    expect(removed).toEqual(
      expect.arrayContaining([
        'node_modules/.pnpm/cpu-features@0.0.10',
        'node_modules/.pnpm/node-pty@1.1.0',
        'node_modules/.pnpm/ssh2@1.17.0',
        'node_modules/.pnpm/terminal-platform-node@file+vendor',
        'node_modules/@terminal-platform',
        'node_modules/node-pty',
        'node_modules/ssh2',
      ])
    );
    expect(result).toMatchObject({
      ok: true,
      betterSqlite3: { functional: true, present: true },
      forbiddenLoads: [],
      forbiddenPaths: [],
      violations: [],
    });
    expect(readFileSync(join(root, 'node_modules/allowed-package/index.js'), 'utf8')).toContain(
      'module.exports = true'
    );
  });

  it('runs the same prune and functional assertion through the Docker-facing CLI', () => {
    const root = createArtifactFixture();
    writeFixture(root, 'node_modules/node-pty/index.js');
    writeFixture(root, 'node_modules/.pnpm/cpu-features@0.0.10/index.js');
    writeFixture(root, 'node_modules/@terminal-platform/workspace-core/index.js');
    writeFixture(root, 'node_modules/.pnpm/lock.yaml', 'ssh2: present\n');

    const execution = spawnSync(
      process.execPath,
      [verifierPath, '--root', root, '--prune', '--require-better-sqlite3'],
      { encoding: 'utf8' }
    );

    expect(execution).toMatchObject({ status: 0, stderr: '' });
    expect(JSON.parse(execution.stdout)).toMatchObject({
      ok: true,
      betterSqlite3: { functional: true, present: true },
      forbiddenLoads: [],
      forbiddenPaths: [],
      violations: [],
      removed: expect.arrayContaining([
        'node_modules/.pnpm/cpu-features@0.0.10',
        'node_modules/.pnpm/lock.yaml',
        'node_modules/@terminal-platform',
        'node_modules/node-pty',
      ]),
    });
  });

  it('fails closed when better-sqlite3 is absent', () => {
    const root = createArtifactFixture();
    rmSync(join(root, 'node_modules/better-sqlite3'), { recursive: true });

    expect(verifyHostedNoTerminalArtifact(root)).toMatchObject({
      ok: false,
      betterSqlite3: {
        functional: false,
        present: false,
        violation: 'better_sqlite3_missing',
      },
    });
  });
});
