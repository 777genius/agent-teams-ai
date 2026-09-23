// @vitest-environment node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error The repository-owned JavaScript proof helper has no declaration file.
import { inspectHostedBrowserEventStreamProof } from '../../../../scripts/ci/hosted-browser-event-stream-proof.mjs';
// @ts-expect-error The repository-owned JavaScript inventory has no declaration file.
import { buildHostedRendererInventory } from '../../../../scripts/ci/hosted-browser-event-stream-runtime-inventory.mjs';
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
const hostedCsp =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; worker-src 'self' blob:";
const expectedBrowserApi = [
  {
    globalKey: 'createHostedCoordinationEventBootstrapTransport',
    moduleId:
      'src/features/coordination-events/renderer/transport/createHostedCoordinationEventBootstrapTransport.ts',
  },
  {
    globalKey: 'createHostedCoordinationEventTransport',
    moduleId:
      'src/features/coordination-events/renderer/transport/createHostedCoordinationEventTransport.ts',
  },
];

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

function updateGraphFixture(root: string, fileName: string, source: string): void {
  const renderer = join(root, 'out', 'renderer');
  writeFileSync(join(renderer, fileName), source);
  const path = join(renderer, HOSTED_RENDERER_GRAPH_MANIFEST);
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
    entryHtmlSha256: string;
    graphSha256: string;
    chunks: { fileName: string; sha256: string }[];
  };
  if (fileName === 'index.html') manifest.entryHtmlSha256 = sha256(source);
  else {
    const chunk = manifest.chunks.find((row) => row.fileName === fileName);
    if (!chunk) throw new Error('fixture chunk missing');
    chunk.sha256 = sha256(source);
  }
  const graph = { ...manifest, graphSha256: undefined };
  writeFileSync(path, `${JSON.stringify({ ...graph, graphSha256: sha256(JSON.stringify(graph)) })}\n`);
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
  const transportSource = options.chunkSource ?? 'export function createTransport() {}\n';
  const bootstrapSource = 'export function createBootstrap() {}\n';
  const browserEntrySource = [
    'import { createTransport as transport } from "./transport-proof.js";',
    'import { createBootstrap as bootstrap } from "./bootstrap-proof.js";',
    'Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: { createHostedCoordinationEventBootstrapTransport: bootstrap, createHostedCoordinationEventTransport: transport } });',
    '',
  ].join('\n');
  const mainSource = 'import "./browser-entry.js";\nconsole.log("hosted renderer");\n';
  const moduleId = options.moduleId ?? 'src/renderer/hosted/main.tsx';
  const indexHtml = `<!doctype html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="${hostedCsp}" /><title>Agent Teams AI</title><script type="module" crossorigin src="/assets/main-proof.js"></script></head><body><div id="root"></div></body></html>\n`;
  writeFixture(root, 'out/renderer/index.html', indexHtml);
  writeFixture(root, 'out/renderer/assets/browser-entry.js', browserEntrySource);
  writeFixture(root, 'out/renderer/assets/main-proof.js', mainSource);
  writeFixture(root, 'out/renderer/assets/bootstrap-proof.js', bootstrapSource);
  writeFixture(root, 'out/renderer/assets/transport-proof.js', transportSource);
  const graph = {
    schemaVersion: 4,
    entryHtml: 'index.html',
    entryHtmlSha256: sha256(indexHtml),
    expectedBrowserGlobal: '__agentTeamsHostedCoordinationEventStream',
    expectedBrowserApi,
    chunks: [
      {
        fileName: 'assets/browser-entry.js',
        isEntry: true,
        facadeModuleId: 'src/renderer/hosted/hostedCoordinationEventStreamBrowserEntry.ts',
        imports: ['assets/bootstrap-proof.js', 'assets/transport-proof.js'],
        dynamicImports: [],
        exports: [],
        moduleIds: ['src/renderer/hosted/hostedCoordinationEventStreamBrowserEntry.ts'],
        sha256: sha256(browserEntrySource),
      },
      {
        fileName: 'assets/main-proof.js',
        isEntry: true,
        facadeModuleId: 'src/renderer/hosted/main.tsx',
        imports: [
          'assets/browser-entry.js',
          ...(options.chunkImport ? [options.chunkImport] : []),
        ].sort((left, right) => left.localeCompare(right)),
        dynamicImports: [],
        exports: [],
        moduleIds: [moduleId],
        sha256: sha256(mainSource),
      },
      {
        fileName: 'assets/bootstrap-proof.js',
        isEntry: false,
        facadeModuleId: null,
        imports: [],
        dynamicImports: [],
        exports: ['createBootstrap'],
        moduleIds: [
          'src/features/coordination-events/renderer/transport/createHostedCoordinationEventBootstrapTransport.ts',
        ],
        sha256: sha256(bootstrapSource),
      },
      {
        fileName: 'assets/transport-proof.js',
        isEntry: false,
        facadeModuleId: null,
        imports: [],
        dynamicImports: [],
        exports: ['createTransport'],
        moduleIds: [
          'src/features/coordination-events/renderer/transport/createHostedCoordinationEventTransport.ts',
        ],
        sha256: sha256(transportSource),
      },
    ].sort((left, right) => left.fileName.localeCompare(right.fileName)),
    modules: [
      {
        id: moduleId,
        importedSpecifiers: options.importedSpecifier ? [options.importedSpecifier] : [],
        resolvedImports: [],
        resolvedDynamicImports: [],
      },
      {
        id: 'src/renderer/hosted/hostedCoordinationEventStreamBrowserEntry.ts',
        importedSpecifiers: [],
        resolvedImports: [
          'src/features/coordination-events/renderer/transport/createHostedCoordinationEventBootstrapTransport.ts',
          'src/features/coordination-events/renderer/transport/createHostedCoordinationEventTransport.ts',
        ],
        resolvedDynamicImports: [],
      },
      {
        id: 'src/features/coordination-events/renderer/transport/createHostedCoordinationEventBootstrapTransport.ts',
        importedSpecifiers: [],
        resolvedImports: [],
        resolvedDynamicImports: [],
      },
      {
        id: 'src/features/coordination-events/renderer/transport/createHostedCoordinationEventTransport.ts',
        importedSpecifiers: [],
        resolvedImports: [],
        resolvedDynamicImports: [],
      },
    ].sort((left, right) => left.id.localeCompare(right.id)),
  };
  writeFixture(
    root,
    `out/renderer/${HOSTED_RENDERER_GRAPH_MANIFEST}`,
    `${JSON.stringify({ ...graph, graphSha256: sha256(JSON.stringify(graph)) }, null, 2)}\n`
  );
}

function inspectBrowserProof(
  source: string,
  sharedSource = 'export function createTransport() {} export function createBootstrap() {}',
  options: {
    readonly additionalChunks?: readonly {
      readonly fileName: string;
      readonly imports: readonly string[];
      readonly exports: readonly string[];
      readonly moduleIds: readonly string[];
      readonly source: string;
    }[];
    readonly sharedImports?: readonly string[];
  } = {}
) {
  return inspectHostedBrowserEventStreamProof({
    entryPaths: ['assets/browser-entry.js'],
    chunks: [
      {
        fileName: 'assets/browser-entry.js',
        imports: ['assets/shared-proof.js'],
        exports: [],
        moduleIds: ['src/renderer/hosted/hostedCoordinationEventStreamBrowserEntry.ts'],
        source,
      },
      {
        fileName: 'assets/shared-proof.js',
        imports: options.sharedImports ?? [],
        exports: ['createBootstrap', 'createTransport'],
        moduleIds: [
          'src/features/coordination-events/renderer/transport/createHostedCoordinationEventBootstrapTransport.ts',
          'src/features/coordination-events/renderer/transport/createHostedCoordinationEventTransport.ts',
        ],
        source: sharedSource,
      },
      ...(options.additionalChunks ?? []),
    ],
    entryModuleId: 'src/renderer/hosted/hostedCoordinationEventStreamBrowserEntry.ts',
    globalName: '__agentTeamsHostedCoordinationEventStream',
    requiredApi: expectedBrowserApi,
  });
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
    expect(dockerfile).toContain('apt-get install -y --no-install-recommends chromium');
    expect(dockerfile).toContain(
      'node scripts/ci/hosted-browser-event-stream-runtime-proof.mjs --root /app'
    );
    expect(dockerfile).toContain('scripts/ci/hosted-browser-event-stream-proof.mjs');
    expect(dockerfile).toContain('rm -r /app/scripts/ci');
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
    expect(config).toContain('createHostedRendererGraphProofPlugins()');
    expect(config).toMatch(
      /plugins:\s*\[\s*\.\.\.createHostedRendererGraphProofPlugins\(\),\s*createHostedTaskBoardRendererBoundaryPlugin\(\)/u
    );
    expect(config).toContain("enforce: 'post'");
    expect(config).toContain('writeBundle(options)');
    expect(config).toContain('hostedCoordinationEventStreamBrowserEntry: resolve(');
    expect(config).toContain(
      'export { createHostedTaskBoardTransport, HOSTED_TASK_BOARD_PAGE_HTTP_PATH }'
    );
    expect(config).toContain("enforce: 'pre'");
    expect(hostedMain).toContain('<LocalizationProvider appConfig={null}>');
    expect(hostedMain).toContain('<HostedAuthGate onAuthenticated={acceptAuthentication}>');
    expect(hostedMain).toContain('<HostedApplicationShell runtimeIdentity={runtimeIdentity} />');
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
    expect(workspace).toContain('key={selectedTeamProjectionKey}');
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

  it('reconciles imports throughout each emitted module, including late and dynamic edges', () => {
    for (const suffix of [
      '\nconst late = 1; import { createBootstrap } from "./bootstrap-proof.js"; void late; void createBootstrap;\n',
      '\nconst late = 1; import "./transport-proof.js"; void late;\n',
      '\nvoid import("./transport-proof.js");\n',
      '\nfunction lazy(){return `${`prefix` + import("./not-in-graph.js")}`};\n',
      '\n// comment ends at U+2028\u2028import("./not-in-graph.js");\n',
      '\nlet n=0; n++ / import("./not-in-graph.js") / 2;\n',
      '\nlet n=0; n++ / import("./not-in-graph.js") / 2; //"\n',
    ]) {
      const root = createArtifactFixture();
      writeHostedRendererGraphFixture(root);
      const fileName = 'assets/main-proof.js';
      const source = readFileSync(join(root, 'out/renderer', fileName), 'utf8');
      updateGraphFixture(root, fileName, source + suffix);
      expect(verifyHostedRendererGraph(root).violations).toContain(
        `hosted_renderer_graph_emitted_static_edge_invalid:${fileName}`
      );
    }
  });

  it('rejects renderer symlinks before creating an immutable browser file inventory', () => {
    const root = createArtifactFixture();
    writeHostedRendererGraphFixture(root);
    const renderer = join(root, 'out/renderer');
    const inventory = buildHostedRendererInventory(renderer);
    expect(inventory.entryPaths).toContain('assets/main-proof.js');
    const outside = writeFixture(root, 'outside-main.js', 'void 0;\n');
    const path = join(renderer, 'assets/main-proof.js');
    rmSync(path);
    symlinkSync(outside, path);
    expect(() => buildHostedRendererInventory(renderer)).toThrow('renderer_symlink');
  });

  it('requires the Product title, exact CSP, isolated installer entry, and separate API chunks', () => {
    type MutableManifest = Record<string, unknown> & {
      chunks: { isEntry: boolean; moduleIds: string[] }[];
      entryHtmlSha256: string;
      graphSha256: string;
    };
    const rewriteManifest = (root: string, mutate: (manifest: MutableManifest) => void): void => {
      const path = join(root, 'out/renderer', HOSTED_RENDERER_GRAPH_MANIFEST);
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as MutableManifest;
      mutate(manifest);
      const graph = { ...manifest, graphSha256: undefined };
      writeFileSync(
        path,
        `${JSON.stringify({ ...graph, graphSha256: sha256(JSON.stringify(graph)) })}\n`
      );
    };

    const titleRoot = createArtifactFixture();
    writeHostedRendererGraphFixture(titleRoot);
    const titlePath = join(titleRoot, 'out/renderer/index.html');
    const changedTitle = readFileSync(titlePath, 'utf8').replace(
      '<title>Agent Teams AI</title>',
      '<title>Unexpected</title>'
    );
    writeFileSync(titlePath, changedTitle);
    rewriteManifest(titleRoot, (manifest) => {
      manifest.entryHtmlSha256 = sha256(changedTitle);
    });
    expect(verifyHostedRendererGraph(titleRoot).violations).toContain(
      'hosted_renderer_graph_entry_html_invalid'
    );

    const cspRoot = createArtifactFixture();
    writeHostedRendererGraphFixture(cspRoot);
    const cspPath = join(cspRoot, 'out/renderer/index.html');
    const changedCsp = readFileSync(cspPath, 'utf8').replace("script-src 'self'", 'script-src *');
    writeFileSync(cspPath, changedCsp);
    rewriteManifest(cspRoot, (manifest) => {
      manifest.entryHtmlSha256 = sha256(changedCsp);
    });
    expect(verifyHostedRendererGraph(cspRoot).violations).toContain(
      'hosted_renderer_graph_entry_html_invalid'
    );

    for (const mutateHtml of [
      (html: string) => html.replace('<head>', '<head>unexpected-text'),
      (html: string) => html.replace('<head>', '<head></body>'),
      (html: string) => {
        const csp = `<meta http-equiv="Content-Security-Policy" content="${hostedCsp}" />`;
        return html.replace(csp, '').replace('<body>', `<body>${csp}`);
      },
      (html: string) =>
        html.replace(
          'crossorigin src="/assets/main-proof.js"',
          'crossorigin integrity="sha256-invalid" src="/assets/main-proof.js"'
        ),
    ]) {
      const invalidHtmlRoot = createArtifactFixture();
      writeHostedRendererGraphFixture(invalidHtmlRoot);
      const invalidHtmlPath = join(invalidHtmlRoot, 'out/renderer/index.html');
      const invalidHtml = mutateHtml(readFileSync(invalidHtmlPath, 'utf8'));
      writeFileSync(invalidHtmlPath, invalidHtml);
      rewriteManifest(invalidHtmlRoot, (manifest) => {
        manifest.entryHtmlSha256 = sha256(invalidHtml);
      });
      expect(verifyHostedRendererGraph(invalidHtmlRoot).violations).toContain(
        'hosted_renderer_graph_entry_html_invalid'
      );
    }

    const installerRoot = createArtifactFixture();
    writeHostedRendererGraphFixture(installerRoot);
    rewriteManifest(installerRoot, (manifest) => {
      const installer = manifest.chunks.find((chunk) =>
        chunk.moduleIds.includes('src/renderer/hosted/hostedCoordinationEventStreamBrowserEntry.ts')
      );
      if (!installer) throw new Error('installer fixture missing');
      installer.isEntry = false;
    });
    expect(verifyHostedRendererGraph(installerRoot).violations).toContain(
      'hosted_renderer_graph_browser_entry_not_isolated'
    );

    const apiRoot = createArtifactFixture();
    writeHostedRendererGraphFixture(apiRoot);
    rewriteManifest(apiRoot, (manifest) => {
      const transport = manifest.chunks.find((chunk) =>
        chunk.moduleIds.includes(expectedBrowserApi[1].moduleId)
      );
      if (!transport) throw new Error('transport fixture missing');
      transport.moduleIds = [...transport.moduleIds, expectedBrowserApi[0].moduleId].sort(
        (left, right) => left.localeCompare(right)
      );
    });
    expect(verifyHostedRendererGraph(apiRoot).violations).toContain(
      'hosted_renderer_graph_browser_api_not_isolated'
    );
  });

  it('fails closed for non-modeled assignments and sibling TDZ aliases before installing the API', () => {
    const imports =
      'import { createTransport as transport, createBootstrap as bootstrap } from "./shared-proof.js";';
    const install =
      'Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: { createHostedCoordinationEventBootstrapTransport: bootstrap, createHostedCoordinationEventTransport: transport } });';
    const rejected =
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream';
    for (const preamble of [
      'let unrelated = 0; unrelated += 1;',
      '({ unrelated: discarded } = {});',
      'const retained = globalThis, globalThis = {}; retained.Object.defineProperty(globalThis, "ignored", { value: {} });',
    ]) {
      expect(inspectBrowserProof(`${imports} ${preamble} ${install}`).violations).toContain(
        rejected
      );
    }
    const retainedAliasInstaller = [
      imports,
      'const retained = Object, Object = {};',
      'retained.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: { createHostedCoordinationEventBootstrapTransport: bootstrap, createHostedCoordinationEventTransport: transport } });',
    ].join(' ');
    expect(inspectBrowserProof(retainedAliasInstaller).violations).toContain(rejected);
  });

  it('rejects imported intrinsic shadows and requires the exact callable API keys', () => {
    const rejected =
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream';
    const fixtures = [
      'import { createTransport as Object, createBootstrap as bootstrap } from "./shared-proof.js"; Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: { createHostedCoordinationEventBootstrapTransport: bootstrap, createHostedCoordinationEventTransport: Object } });',
      'import { createTransport as globalThis, createBootstrap as bootstrap } from "./shared-proof.js"; Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: { createHostedCoordinationEventBootstrapTransport: bootstrap, createHostedCoordinationEventTransport: globalThis } });',
      'import { createTransport as transport, createBootstrap as bootstrap } from "./shared-proof.js"; Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: { wrongKey: bootstrap, createHostedCoordinationEventTransport: transport } });',
      'import { createTransport as transport, createBootstrap as bootstrap } from "./shared-proof.js"; Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: { createHostedCoordinationEventBootstrapTransport: bootstrap, createHostedCoordinationEventBootstrapTransport: transport } });',
      'import { createTransport as transport, createBootstrap as bootstrap } from "./shared-proof.js"; Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: { createHostedCoordinationEventTransport: transport } });',
    ];
    for (const source of fixtures) {
      expect(inspectBrowserProof(source).violations).toContain(rejected);
    }

    const validInstaller =
      'import { createTransport as transport, createBootstrap as bootstrap } from "./shared-proof.js"; Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: { createHostedCoordinationEventBootstrapTransport: bootstrap, createHostedCoordinationEventTransport: transport } });';
    expect(
      inspectBrowserProof(
        validInstaller,
        'export const createTransport = {}; export function createBootstrap() {}'
      ).violations
    ).toContain(rejected);
    expect(
      inspectBrowserProof(
        validInstaller,
        'export function createBootstrap() {} const createTransport = () => {};'
      ).violations
    ).toContain(rejected);
  });

  it('traverses named reexports and rejects wildcard reexports in the callable proof', () => {
    const installer =
      'import { createTransport as transport, createBootstrap as bootstrap } from "./shared-proof.js"; Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: { createHostedCoordinationEventBootstrapTransport: bootstrap, createHostedCoordinationEventTransport: transport } });';
    const implementation = {
      fileName: 'assets/implementation.js',
      imports: [],
      exports: ['actualBootstrap', 'actualTransport'],
      moduleIds: ['src/features/coordination-events/renderer/transport/implementation.ts'],
      source: 'export function actualBootstrap() {} export function actualTransport() {}',
    };
    const named = inspectBrowserProof(
      installer,
      'export { actualBootstrap as createBootstrap, actualTransport as createTransport } from "./implementation.js";',
      { additionalChunks: [implementation], sharedImports: ['assets/implementation.js'] }
    );
    expect(named.violations).toEqual([]);

    const wildcard = inspectBrowserProof(installer, 'export * from "./implementation.js";', {
      additionalChunks: [implementation],
      sharedImports: ['assets/implementation.js'],
    });
    expect(wildcard.violations).toContain(
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream'
    );
  });

  it('decodes ordinary emitted string escapes and rejects callable proofs invalidated by writes', () => {
    const installer =
      'import { createTransport as transport, createBootstrap as bootstrap } from "./shared-proof.js"; Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: { createHostedCoordinationEventBootstrapTransport: bootstrap, createHostedCoordinationEventTransport: transport } });';
    expect(
      inspectBrowserProof(
        installer,
        'const ordinary = "\\r\\n\\t\\u0041"; export function createBootstrap() {} export const createTransport = () => ordinary;'
      ).violations
    ).toEqual([]);

    const rejected =
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream';
    for (const sharedSource of [
      'export function createBootstrap() {} export function createTransport() {} createTransport = 0;',
      'export function createBootstrap() {} export const createTransport = (function () { return 0; })();',
      'export function createBootstrap() {} export const createTransport = Math.random() ? (() => {}) : 0;',
    ]) {
      expect(inspectBrowserProof(installer, sharedSource).violations).toContain(rejected);
    }
  });

  it('rejects dependency initialization that can preempt installation or replace the intrinsic', () => {
    const installer =
      'import { createTransport as transport, createBootstrap as bootstrap } from "./shared-proof.js"; Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: { createHostedCoordinationEventBootstrapTransport: bootstrap, createHostedCoordinationEventTransport: transport } });';
    for (const sharedSource of [
      'throw new Error("before installer"); export function createBootstrap() {} export function createTransport() {}',
      'Object.defineProperty = () => {}; export function createBootstrap() {} export function createTransport() {}',
    ]) {
      expect(inspectBrowserProof(installer, sharedSource).violations).toContain(
        'hosted_renderer_graph_browser_dependency_initialization_unsafe'
      );
    }
  });

  it('uses a grammar-only module parse and rejects invalid balanced function and class fixtures', () => {
    const imports =
      'import { createTransport as transport, createBootstrap as bootstrap } from "./shared-proof.js";';
    const install =
      'Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: { createHostedCoordinationEventBootstrapTransport: bootstrap, createHostedCoordinationEventTransport: transport } });';
    const rejected =
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream';
    for (const invalid of [
      'function broken(first,, second) {}',
      'class Broken { method(first,, second) {} }',
    ]) {
      expect(inspectBrowserProof(`${imports} ${invalid} ${install}`).violations).toContain(
        rejected
      );
    }
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
