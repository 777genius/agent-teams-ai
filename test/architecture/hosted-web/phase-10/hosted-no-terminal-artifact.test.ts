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
  extractHostedHtmlModuleScriptPaths,
  pruneForbiddenHostedPackages,
  verifyHostedNoTerminalArtifact,
  verifyHostedNoTerminalDockerfile,
  verifyHostedRendererGraph,
  // @ts-expect-error The repository-owned JavaScript artifact verifier has no declaration file.
} from '../../../../scripts/ci/verify-hosted-no-terminal-artifact.mjs';
// @ts-expect-error The repository-owned JavaScript proof helper has no declaration file.
import { inspectHostedBrowserEventStreamProof } from '../../../../scripts/ci/hosted-browser-event-stream-proof.mjs';

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

function inspectBrowserProof(
  source: string,
  sharedSource = 'function c() {} class P {} export { c as a, P as b };',
  extraChunks: readonly { fileName: string; moduleIds: readonly string[]; source: string }[] = []
) {
  const entryModuleId = 'src/renderer/hosted/hostedCoordinationEventStreamBrowserEntry.ts';
  const requiredModuleIds = [
    'src/features/coordination-events/renderer/transport/HostedCoordinationEventStreamObserver.ts',
    'src/features/coordination-events/renderer/transport/HostedCoordinationEventStreamParser.ts',
  ];
  return inspectHostedBrowserEventStreamProof({
    entryPaths: ['assets/browser-entry.js'],
    chunks: [
      {
        fileName: 'assets/browser-entry.js',
        moduleIds: [entryModuleId],
        source,
      },
      {
        fileName: 'assets/shared-sse.js',
        moduleIds: requiredModuleIds,
        source: sharedSource,
      },
      ...extraChunks,
    ],
    entryModuleId,
    globalName: '__agentTeamsHostedCoordinationEventStream',
    requiredModuleIds,
  });
}

function writeHostedRendererGraphFixture(
  root: string,
  options: {
    readonly moduleId?: string;
    readonly importedSpecifier?: string;
    readonly chunkImport?: string;
    readonly chunkSource?: string;
    readonly html?: string;
    readonly metadataOnlyEdge?: boolean;
    readonly dynamicOnlyEdge?: boolean;
    readonly unreachableInstallation?: boolean;
    readonly commentOnlyInstallation?: boolean;
    readonly regexOnlyInstallation?: boolean;
    readonly uncalledInstallation?: boolean;
    readonly emptyBrowserGlobal?: boolean;
    readonly missingParser?: boolean;
    readonly missingObserver?: boolean;
    readonly swappedApis?: boolean;
    readonly accessorDescriptor?: boolean;
    readonly valueAndAccessorDescriptor?: boolean;
    readonly opaqueDescriptorProperty?: boolean;
    readonly throwingDescriptorProperty?: boolean;
    readonly nestedOpaqueApiProperty?: boolean;
    readonly nestedThrowingApiProperty?: boolean;
    readonly commentedOutInstaller?: boolean;
    readonly nonconfigurableRedefinition?: boolean;
    readonly configurableAccessorToDataTransition?: boolean;
    readonly unusedOpaqueBinding?: boolean;
    readonly unusedThrowingBinding?: boolean;
    readonly overwrittenOpaqueDescriptorValue?: boolean;
    readonly overwrittenThrowingDescriptorValue?: boolean;
    readonly uninvokedThrowingFunction?: boolean;
    readonly uninvokedThrowingFunctionValue?: boolean;
    readonly noncallableObserver?: boolean;
    readonly ordinaryApplicationSource?: string;
  } = {}
): void {
  const expectedBrowserGlobal = '__agentTeamsHostedCoordinationEventStream';
  const moduleId = options.moduleId ?? 'src/renderer/hosted/main.tsx';
  const browserEntryModuleId = 'src/renderer/hosted/hostedCoordinationEventStreamBrowserEntry.ts';
  const observerModuleId =
    'src/features/coordination-events/renderer/transport/HostedCoordinationEventStreamObserver.ts';
  const parserModuleId =
    'src/features/coordination-events/renderer/transport/HostedCoordinationEventStreamParser.ts';
  const indexHtml = options.html ?? [
    '<!doctype html>',
    '<div id="root"></div>',
    ...(options.unreachableInstallation || options.commentedOutInstaller
      ? []
      : ['<script type="module" src="/assets/browser-entry.js"></script>']),
    ...(options.commentedOutInstaller
      ? ['<!-- <script type="module" src="/assets/browser-entry.js"></script> -->']
      : []),
    '<script type="module" src="/assets/main.js"></script>',
    '',
  ].join('\n');
  const browserEntryImports = ['assets/shared-sse.js'];
  const sharedChunkSource = options.chunkSource ?? [
    'function c() { return Object.freeze({ close() {} }); }',
    'class P { push() { return []; } finish() { return []; } }',
    'export { c as a, P as b };',
    '',
  ].join('\n');
  const importedApis = [
    'import { a as c, b as P } from "./shared-sse.js";',
    '',
  ].join('\n');
  const entryProperties = [
    ...(options.missingObserver
      ? []
      : [`createHostedCoordinationEventStreamObserver: ${
          options.noncallableObserver ? '0' : options.swappedApis ? 'P' : 'c'
        }`]),
    ...(options.missingParser
      ? []
      : [`HostedCoordinationEventStreamParser: ${options.swappedApis ? 'c' : 'P'}`]),
    ...(options.nestedOpaqueApiProperty ? ['nested: { opaque: unknownFlag }'] : []),
    ...(options.nestedThrowingApiProperty
      ? ['nested: { throwing: (() => { throw new Error("proof api"); })() }']
      : []),
  ].join(', ');
  const descriptorProperties = options.accessorDescriptor
    ? 'get: c'
    : options.valueAndAccessorDescriptor
      ? `get: c, value: ${options.emptyBrowserGlobal ? '{}' : 'e'}`
      : options.opaqueDescriptorProperty
        ? `enumerable: unknownFlag, value: ${options.emptyBrowserGlobal ? '{}' : 'e'}`
        : options.throwingDescriptorProperty
          ? `set: (() => { throw new Error("proof descriptor"); })(), value: ${
              options.emptyBrowserGlobal ? '{}' : 'e'
            }`
          : `configurable: !0, enumerable: !1, value: ${
              options.emptyBrowserGlobal ? '{}' : 'e'
            }, writable: !1`;
  const executionPreamble = [
    ...(options.unusedOpaqueBinding
      ? ['const unusedOpaque = Object.freeze({ nested: { opaque: unknownFlag } });']
      : []),
    ...(options.unusedThrowingBinding
      ? [
        'const unusedThrowing = Object.freeze({ nested: { throwing: (() => { throw new Error("unused"); })() } });',
      ]
      : []),
    ...(options.uninvokedThrowingFunction
      ? ['function deferredFailure() { throw new Error("uninvoked"); }']
      : []),
    ...(options.uninvokedThrowingFunctionValue
      ? [
        'const deferredValueFailure = () => { throw new Error("uninvoked value"); };',
      ]
      : []),
  ].join('\n');
  const browserEntrySource = options.commentOnlyInstallation
    ? [
      `// ${importedApis.replaceAll('\n', ' ')}`,
      `// Object.defineProperty(globalThis, "${expectedBrowserGlobal}", { value: { ${entryProperties} } });`,
      '',
    ].join('\n')
    : options.regexOnlyInstallation
      ? [
        importedApis,
        `const proofOnly = /Object\\.defineProperty\\(globalThis, "${expectedBrowserGlobal}"/;`,
        'void proofOnly;',
        '',
      ].join('\n')
      : options.uncalledInstallation
        ? [
          importedApis,
          `function installOnly() { Object.defineProperty(globalThis, "${expectedBrowserGlobal}", { value: { ${entryProperties} } }); }`,
          'void installOnly;',
          '',
        ].join('\n')
    : options.metadataOnlyEdge
      ? `Object.defineProperty(globalThis, "${expectedBrowserGlobal}", { value: {} });\n`
    : options.dynamicOnlyEdge
      ? [
        'import("./shared-sse.js").then(() => undefined);',
        `Object.defineProperty(globalThis, "${expectedBrowserGlobal}", { value: {} });`,
        '',
      ].join('\n')
    : options.nonconfigurableRedefinition
      ? [
        importedApis,
        'const empty = Object.freeze({});',
        `const e = Object.freeze({ ${entryProperties} });`,
        `Object.defineProperty(globalThis, "${expectedBrowserGlobal}", { value: empty });`,
        `Object.defineProperty(globalThis, "${expectedBrowserGlobal}", { configurable: !0, enumerable: !1, value: e, writable: !1 });`,
        'export { e as h };',
        '',
      ].join('\n')
    : options.configurableAccessorToDataTransition
      ? [
        importedApis,
        executionPreamble,
        `const e = Object.freeze({ ${entryProperties} });`,
        `Object.defineProperty(globalThis, "${expectedBrowserGlobal}", { configurable: !0, enumerable: !1, get: c });`,
        `Object.defineProperty(globalThis, "${expectedBrowserGlobal}", { value: e, writable: !1 });`,
        `Object.defineProperty(globalThis, "${expectedBrowserGlobal}", { enumerable: !0 });`,
        'export { e as h };',
        '',
      ].join('\n')
    : options.overwrittenOpaqueDescriptorValue || options.overwrittenThrowingDescriptorValue
      ? [
        importedApis,
        executionPreamble,
        `const e = Object.freeze({ ${entryProperties} });`,
        `Object.defineProperty(globalThis, "${expectedBrowserGlobal}", { configurable: !0, value: { nested: { ${
          options.overwrittenOpaqueDescriptorValue
            ? 'opaque: unknownFlag'
            : 'throwing: (() => { throw new Error("overwritten"); })()'
        } } });`,
        `Object.defineProperty(globalThis, "${expectedBrowserGlobal}", { configurable: !0, enumerable: !1, value: e, writable: !1 });`,
        'export { e as h };',
        '',
      ].join('\n')
    : [
      importedApis,
      executionPreamble,
      `const e = Object.freeze({ ${entryProperties} });`,
      `Object.defineProperty(globalThis, "${expectedBrowserGlobal}", { ${descriptorProperties} });`,
      'export { e as h };',
      '',
      ].join('\n');
  writeFixture(root, 'out/renderer/index.html', indexHtml);
  writeFixture(root, 'out/renderer/assets/browser-entry.js', browserEntrySource);
  const ordinaryApplicationSource = options.ordinaryApplicationSource ?? [
    'const application = Object.freeze({',
    '  render() { return `hosted application`; },',
    '  get status() { return "ready"; },',
    '});',
    'export { application as a };',
    '',
  ].join('\n');
  writeFixture(root, 'out/renderer/assets/main.js', ordinaryApplicationSource);
  writeFixture(root, 'out/renderer/assets/shared-sse.js', sharedChunkSource);
  const graph = {
    schemaVersion: 3,
    entryHtml: 'index.html',
    entryHtmlSha256: sha256(indexHtml),
    expectedBrowserGlobal,
    chunks: [
      {
        fileName: 'assets/browser-entry.js',
        imports: options.unreachableInstallation ? [] : browserEntryImports,
        dynamicImports: [],
        moduleIds: [browserEntryModuleId],
        sha256: sha256(browserEntrySource),
      },
      {
        fileName: 'assets/main.js',
        imports: options.chunkImport ? [options.chunkImport] : [],
        dynamicImports: [],
        moduleIds: [moduleId],
        sha256: sha256(ordinaryApplicationSource),
      },
      {
        fileName: 'assets/shared-sse.js',
        imports: [],
        dynamicImports: [],
        moduleIds: [observerModuleId, parserModuleId].sort(),
        sha256: sha256(sharedChunkSource),
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
        id: browserEntryModuleId,
        importedSpecifiers: [],
        resolvedImports: [observerModuleId, parserModuleId].sort(),
        resolvedDynamicImports: [],
      },
      {
        id: observerModuleId,
        importedSpecifiers: [],
        resolvedImports: [],
        resolvedDynamicImports: [],
      },
      {
        id: parserModuleId,
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

  it('accepts an actual-build-shaped app chunk while proving only the dedicated HTML installer entry', () => {
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

  it('does not interpret ordinary application chunks while following the emitted installer subgraph', () => {
    const root = createArtifactFixture();
    writeHostedRendererGraphFixture(root, {
      // A legitimate external application dependency is intentionally outside
      // the installer DSL. The proof must not treat this application entry as
      // part of its static installer subgraph.
      ordinaryApplicationSource: 'import { render } from "application-runtime"; render();\n',
    });

    expect(verifyHostedRendererGraph(root)).toMatchObject({ ok: true, violations: [] });
  });

  it('uses emitted JavaScript imports, rather than manifest metadata, to reach the shared SSE chunk', () => {
    const metadataOnlyRoot = createArtifactFixture();
    writeHostedRendererGraphFixture(metadataOnlyRoot, { metadataOnlyEdge: true });
    expect(verifyHostedRendererGraph(metadataOnlyRoot).violations).toEqual(
      expect.arrayContaining([
        'hosted_renderer_graph_required_module_unreachable:src/features/coordination-events/renderer/transport/HostedCoordinationEventStreamObserver.ts',
        'hosted_renderer_graph_required_module_unreachable:src/features/coordination-events/renderer/transport/HostedCoordinationEventStreamParser.ts',
        'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream',
      ])
    );

    const dynamicOnlyRoot = createArtifactFixture();
    writeHostedRendererGraphFixture(dynamicOnlyRoot, { dynamicOnlyEdge: true });
    expect(verifyHostedRendererGraph(dynamicOnlyRoot).violations).toEqual(
      expect.arrayContaining([
        'hosted_renderer_graph_required_module_unreachable:src/features/coordination-events/renderer/transport/HostedCoordinationEventStreamObserver.ts',
        'hosted_renderer_graph_required_module_unreachable:src/features/coordination-events/renderer/transport/HostedCoordinationEventStreamParser.ts',
        'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream',
      ])
    );

    const unreachableRoot = createArtifactFixture();
    writeHostedRendererGraphFixture(unreachableRoot, { unreachableInstallation: true });
    expect(verifyHostedRendererGraph(unreachableRoot).violations).toEqual(
      expect.arrayContaining([
        'hosted_renderer_graph_required_module_unreachable:src/renderer/hosted/hostedCoordinationEventStreamBrowserEntry.ts',
        'hosted_renderer_graph_required_module_unreachable:src/features/coordination-events/renderer/transport/HostedCoordinationEventStreamObserver.ts',
        'hosted_renderer_graph_required_module_unreachable:src/features/coordination-events/renderer/transport/HostedCoordinationEventStreamParser.ts',
        'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream',
      ])
    );
  });

  it('requires an invoked global installation exposing callable shared parser and observer APIs', () => {
    const expected =
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream';
    for (const options of [
      { commentOnlyInstallation: true },
      { regexOnlyInstallation: true },
      { uncalledInstallation: true },
      { emptyBrowserGlobal: true },
      { missingParser: true },
      { missingObserver: true },
      { swappedApis: true },
      { accessorDescriptor: true },
      { valueAndAccessorDescriptor: true },
      { opaqueDescriptorProperty: true },
      { throwingDescriptorProperty: true },
      { noncallableObserver: true },
    ]) {
      const root = createArtifactFixture();
      writeHostedRendererGraphFixture(root, options);
      expect(verifyHostedRendererGraph(root).violations).toContain(expected);
    }

    const scriptlessRoot = createArtifactFixture();
    writeHostedRendererGraphFixture(scriptlessRoot, {
      html: '<!doctype html>\n<div id="root"></div>\n',
    });
    expect(verifyHostedRendererGraph(scriptlessRoot).violations).toContain(
      'hosted_renderer_graph_html_module_scripts_missing'
    );
  });

  it('rejects opaque and throwing expressions nested anywhere in the installed API object', () => {
    const expected =
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream';
    for (const options of [
      { nestedOpaqueApiProperty: true },
      { nestedThrowingApiProperty: true },
    ]) {
      const root = createArtifactFixture();
      writeHostedRendererGraphFixture(root, options);
      expect(verifyHostedRendererGraph(root).violations).toContain(expected);
    }
  });

  it('rejects every evaluated opaque binding and overwritten descriptor value before installation', () => {
    const expected =
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream';
    for (const options of [
      { unusedOpaqueBinding: true },
      { unusedThrowingBinding: true },
      { overwrittenOpaqueDescriptorValue: true },
      { overwrittenThrowingDescriptorValue: true },
    ]) {
      const root = createArtifactFixture();
      writeHostedRendererGraphFixture(root, options);
      expect(verifyHostedRendererGraph(root).violations).toContain(expected);
    }
  });

  it('allows an uninvoked function body while accepting a legal configurable accessor-to-data transition', () => {
    const root = createArtifactFixture();
    writeHostedRendererGraphFixture(root, {
      configurableAccessorToDataTransition: true,
      uninvokedThrowingFunction: true,
      uninvokedThrowingFunctionValue: true,
    });

    expect(verifyHostedRendererGraph(root)).toMatchObject({ ok: true, violations: [] });
  });

  it('does not let a failed nonconfigurable redefinition overwrite the installed-global model', () => {
    const root = createArtifactFixture();
    writeHostedRendererGraphFixture(root, { nonconfigurableRedefinition: true });

    expect(verifyHostedRendererGraph(root).violations).toContain(
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream'
    );
  });

  it('ignores commented HTML script markup when selecting the dedicated installer root', () => {
    const root = createArtifactFixture();
    writeHostedRendererGraphFixture(root, { commentedOutInstaller: true });

    expect(verifyHostedRendererGraph(root).violations).toContain(
      'hosted_renderer_graph_proof_entry_html_unreachable:src/renderer/hosted/hostedCoordinationEventStreamBrowserEntry.ts'
    );
  });

  it('does not manufacture HTML module roots by deleting comments across pseudo-tags', () => {
    const main = '<script type="module" src="/assets/main.js"></script>';
    for (const pseudoTag of [
      '<!-- <script type="module" src="/assets/browser-entry.js"></script> -->',
      '<scr<!-- hidden -->ipt type="module" src="/assets/browser-entry.js"></script>',
      '<script<!-- hidden --> type="module" src="/assets/browser-entry.js"></script>',
    ]) {
      expect(extractHostedHtmlModuleScriptPaths(`${pseudoTag}${main}`)).toEqual(['assets/main.js']);
    }
  });

  it('consumes non-module and JSON script bodies while keeping raw-text contexts inert', () => {
    expect(
      extractHostedHtmlModuleScriptPaths(
        '<script type="text/plain"><script type="module" src="/inert.js"></script></script><script type="module" src="/live.js"></script>'
      )
    ).toEqual(['live.js']);
    expect(
      extractHostedHtmlModuleScriptPaths(
        '<script type="module" src="/before.js"></script><script type="application/json">{"fake":"<script type=module src=/inert.js>"}</script><script type="module" src="/after.js"></script>'
      )
    ).toEqual(['before.js', 'after.js']);

    for (const tagName of ['textarea', 'title', 'style', 'xmp']) {
      expect(
        extractHostedHtmlModuleScriptPaths(
          `<${tagName}><script type="module" src="/inert.js"></script></${tagName}><script type="module" src="/live.js"></script>`
        )
      ).toEqual(['live.js']);
    }
  });

  it('evaluates template substitutions before installation while leaving quasi text inert', () => {
    const install = [
      'const e = Object.freeze({ createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P });',
      'Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: e });',
    ].join('\n');
    const imports = 'import { a as c, b as P } from "./shared-sse.js";';

    expect(
      inspectBrowserProof(
        [
          imports,
          'const escaped = `plain \\${missingBinding}`;',
          'const nested = `outer ${`inner ${true}`}`;',
          install,
        ].join('\n')
      ).violations
    ).toEqual([]);

    for (const templateBinding of [
      'const missing = `value ${missingBinding}`;',
      'const throwing = `value ${(() => { throw new Error("template"); })()}`;',
    ]) {
      expect(inspectBrowserProof([imports, templateBinding, install].join('\n')).violations).toContain(
        'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream'
      );
    }
  });

  it('does not treat shadowed or reassigned modeled intrinsics as browser-global installation', () => {
    const imports = 'import { a as c, b as P } from "./shared-sse.js";';
    const install = [
      'const e = Object.freeze({ createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P });',
      'Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: e });',
    ].join('\n');
    for (const preamble of [
      'const globalThis = {};',
      'const Object = {};',
      'Object = {};',
    ]) {
      expect(inspectBrowserProof([imports, preamble, install].join('\n')).violations).toContain(
        'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream'
      );
    }
    // `undefined` is also modeled by the template DSL. A lexical binding must
    // be used here rather than silently substituted with the intrinsic value.
    expect(
      inspectBrowserProof([
        imports,
        'const undefined = true; const label = `${undefined}`;',
        install,
      ].join('\n')).violations
    ).toEqual([]);
  });

  it('preserves callable identity for aliases of one export without conflating distinct exports or modules', () => {
    const shared = 'function c() {} function d() {} class P {} export { c as a, d as z, P as b };';
    const install = [
      'const e = Object.freeze({ createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P });',
      'Object.defineProperty(globalThis, "extra", { get: c });',
      'Object.defineProperty(globalThis, "extra", { get: alias });',
      'Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: e });',
    ].join('\n');
    expect(
      inspectBrowserProof(
        ['import { a as c, a as alias, b as P } from "./shared-sse.js";', install].join('\n'),
        shared
      ).violations
    ).toEqual([]);

    expect(
      inspectBrowserProof(
        ['import { a as c, z as alias, b as P } from "./shared-sse.js";', install].join('\n'),
        shared
      ).violations
    ).toContain(
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream'
    );

    expect(
      inspectBrowserProof(
        [
          'import { a as c, b as P } from "./shared-sse.js";',
          'import { a as alias } from "./other.js";',
          install,
        ].join('\n'),
        'function c() {} class P {} export { c as a, P as b };',
        [{ fileName: 'assets/other.js', moduleIds: ['src/other.ts'], source: 'function c() {} export { c as a };' }]
      ).violations
    ).toContain(
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream'
    );
  });

  it('keeps only active top-level module scripts across inert HTML contexts and duplicate attributes', () => {
    const active = '<script type="module" src="/assets/live.js"></script>';
    expect(
      extractHostedHtmlModuleScriptPaths(
        `<iframe srcdoc='<script type="module" src="/assets/srcdoc.js"></script>'><script type="module" src="/assets/frame.js"></script></iframe><template><script type="module" src="/assets/template.js"></script></template><div data-example='<script type="module" src="/assets/attribute.js"></script>'></div>${active}`
      )
    ).toEqual(['assets/live.js']);
    expect(
      extractHostedHtmlModuleScriptPaths(
        '<script type="module" type="text/plain" src="/assets/first.js" src="/assets/second.js"></script>'
      )
    ).toEqual(['assets/first.js']);
    expect(
      extractHostedHtmlModuleScriptPaths(
        '<script type="text/plain" type="module" src="/assets/inert.js"></script>'
      )
    ).toEqual([]);
  });

  it('evaluates every sibling declarator after an arrow initializer', () => {
    const imports = 'import { a as c, b as P } from "./shared-sse.js";';
    const install = 'const e = { createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P }; Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: e });';
    expect(inspectBrowserProof(`${imports} const first = () => {}, second = missingBinding; ${install}`).violations).toContain(
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream'
    );
    expect(inspectBrowserProof(`${imports} const first = () => {}; ${install}`).violations).toEqual([]);
  });

  it('applies TDZ and hoisted intrinsic shadows to every sibling declarator', () => {
    const imports = 'import { a as c, b as P } from "./shared-sse.js";';
    const install = 'const e = { createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P }; Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: e });';
    const rejected =
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream';
    for (const siblingShadow of [
      'const objectAlias = Object, Object = {};',
      'const globalAlias = globalThis, globalThis = {};',
      'var Object; const objectAlias = Object;',
      'var globalThis; const globalAlias = globalThis;',
    ]) expect(inspectBrowserProof(`${imports} ${siblingShadow} ${install}`).violations).toContain(rejected);
    expect(inspectBrowserProof(`${imports} const objectAlias = Object, globalAlias = globalThis; const e = { createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P }; objectAlias.defineProperty(globalAlias, "__agentTeamsHostedCoordinationEventStream", { value: e });`).violations).toEqual([]);
  });

  it('does not equate distinct template proof values during nonconfigurable redefinition', () => {
    const imports = 'import { a as c, b as P } from "./shared-sse.js";';
    const install = 'const e = { createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P }; Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: e });';
    expect(inspectBrowserProof(`${imports} const a = \`a\`, b = \`b\`; Object.defineProperty(globalThis, "template", { value: a }); Object.defineProperty(globalThis, "template", { value: b }); ${install}`).violations).toContain(
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream'
    );
    expect(inspectBrowserProof(`${imports} const a = \`same \${true}\`; Object.defineProperty(globalThis, "template", { value: a }); Object.defineProperty(globalThis, "template", { value: a }); ${install}`).violations).toEqual([]);
  });

  it('models redirected global intrinsic writes and rejects invalidated intrinsic calls', () => {
    const imports = 'import { a as c, b as P } from "./shared-sse.js";';
    const install = 'const e = { createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P };';
    expect(inspectBrowserProof(`${imports} const redirected = globalThis; redirected.Object = Object; ${install} redirected.Object.defineProperty(redirected, "__agentTeamsHostedCoordinationEventStream", { value: e });`).violations).toEqual([]);
    for (const mutation of ['globalThis.Object = {};', 'globalThis.globalThis = {};', 'Object = {};']) {
      expect(inspectBrowserProof(`${imports} ${mutation} ${install} Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: e });`).violations).toContain(
        'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream'
      );
    }
  });

  it('uses the final exported live binding while retaining aliases of that binding', () => {
    const install = 'const e = { createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P }; Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: e });';
    expect(inspectBrowserProof(`import { a as c, b as P } from "./shared-sse.js"; ${install}`, 'function c() {} c = undefined; class P {} export { c as a, P as b };').violations).toContain(
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream'
    );
    const aliasIdentity = 'Object.defineProperty(globalThis, "alias", { get: c }); Object.defineProperty(globalThis, "alias", { get: alias });';
    expect(inspectBrowserProof(`import { a as c, z as alias, b as P } from "./shared-sse.js"; ${aliasIdentity} ${install}`, 'function c() {} const alias = c; class P {} export { c as a, alias as z, P as b };').violations).toEqual([]);
  });

  it('does not close an inert template from raw-text literals or nested inert contexts', () => {
    expect(extractHostedHtmlModuleScriptPaths(
      '<template><template><script>"</template>"</script><style>"</template>"</style><textarea>"</template>"</textarea><title>"</template>"</title></template><iframe><script>"</template>"</script></iframe><script type="module" src="/inert.js"></script></template><script type="module" src="/live.js"></script>'
    )).toEqual(['live.js']);
  });

  it('invalidates modeled globals when descriptor APIs replace Object or globalThis', () => {
    const imports = 'import { a as c, b as P } from "./shared-sse.js";';
    const value = 'const e = { createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P };';
    const install = 'Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: e });';
    const rejected = 'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream';
    for (const preamble of [
      'Object.defineProperty(globalThis, "Object", { value: {} });',
      'Object.defineProperties(globalThis, { globalThis: { value: {} } });',
    ]) expect(inspectBrowserProof([imports, value, preamble, install].join('\n')).violations).toContain(rejected);
  });

  it('invalidates callable export proof for every live binding write form', () => {
    const imports = 'import { a as c, b as P } from "./shared-sse.js";';
    const value = 'const e = { createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P };';
    const install = 'Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: e });';
    const rejected = 'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream';
    for (const mutation of ['c++;', '--c;', 'c += 1;', 'c &&= undefined;', 'c ??= undefined;', '({ c } = {});', '[c] = [];']) {
      expect(inspectBrowserProof(`${imports} ${value} ${install}`, `function c() {} ${mutation} class P {} export { c as a, P as b };`).violations).toContain(rejected);
    }
  });

  it('rejects strict-module assignment through non-writable and accessor global descriptors', () => {
    const imports = 'import { a as c, b as P } from "./shared-sse.js";';
    const value = 'const e = { createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P };';
    const install = 'Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: e });';
    for (const descriptor of ['{ value: {}, writable: !1 }', '{ get: c }']) expect(inspectBrowserProof([imports, value, `Object.defineProperty(globalThis, "locked", ${descriptor}); globalThis.locked = e;`, install].join('\n')).violations).toContain(
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream'
    );
  });

  it('evaluates ignored extra Object.defineProperty arguments before accepting installation', () => {
    const source = 'import { a as c, b as P } from "./shared-sse.js"; const e = { createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P }; Object.defineProperty(globalThis, "ignored", { value: !0 }, (() => { throw new Error("fourth argument"); })()); Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: e });';
    expect(inspectBrowserProof(source).violations).toContain(
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream'
    );
  });

  it('rejects template substitution coercion through an arbitrary object', () => {
    // The arrow-valued property is deliberately used instead of method syntax:
    // it reaches template interpolation as an arbitrary object and would pass
    // if the interpolation coercion guard were removed.
    const source = 'import { a as c, b as P } from "./shared-sse.js"; const e = { createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P }; const coercion = { toString: () => { throw new Error("coercion"); } }; const label = `value ${coercion}`; Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: e });';
    expect(inspectBrowserProof(source).violations).toContain(
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream'
    );
  });

  it('fails closed before installation for writes and abrupt evaluation in nested executable contexts', () => {
    const imports = 'import { a as c, b as P } from "./shared-sse.js";';
    const value = 'const e = { createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P };';
    const install = 'Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: e });';
    const mutation = 'Object.defineProperty(Object, "defineProperty", { value: 0 });';
    const rejected =
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream';
    for (const preamble of [
      `{ ${mutation} }`,
      `if (!0) { ${mutation} }`,
      `for (;;) { ${mutation} break; }`,
      `switch (0) { default: ${mutation} }`,
      `try { ${mutation} } catch (error) { throw error; }`,
      `(() => { ${mutation} })();`,
      `function mutate() { ${mutation} } mutate();`,
      `class Mutate { static { ${mutation} } }`,
      'throw new Error("before installer");',
    ]) {
      expect(inspectBrowserProof([imports, value, preamble, install].join('\n')).violations).toContain(
        rejected
      );
    }
  });

  it('does not retain callable exports when their module has executable nested control flow', () => {
    const entrySource = [
      'import { a as c, b as P } from "./shared-sse.js";',
      'const e = { createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P };',
      'Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: e });',
    ].join('\n');
    const rejected =
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream';
    for (const executableSource of [
      '{ c = undefined; }',
      'if (!0) { c = undefined; }',
      'for (;;) { c = undefined; break; }',
      'switch (0) { default: c = undefined; }',
      'try { c = undefined; } catch (error) { throw error; }',
      '(() => { c = undefined; })();',
      'function mutate() { c = undefined; } mutate();',
      'class P { static { c = undefined; } }',
      'throw new Error("before export");',
    ]) {
      const sharedSource = ['function c() {}', executableSource, 'class P {}', 'export { c as a, P as b };'].join('\n');
      expect(inspectBrowserProof(entrySource, sharedSource).violations).toContain(rejected);
    }
  });

  it('invalidates every Object capability alias after an intrinsic defineProperty mutation', () => {
    const validAliasInstaller = [
      'import { a as c, b as P } from "./shared-sse.js";',
      'const e = { createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P };',
      'const O = Object;',
      'O.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: e });',
    ].join('\n');
    expect(inspectBrowserProof(validAliasInstaller).violations).toEqual([]);
    const source = [
      'import { a as c, b as P } from "./shared-sse.js";',
      'const e = { createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P };',
      'const O = Object, alsoO = O;',
      // `!0` is in the proof value language.  This makes the rejection depend
      // on invalidating both aliases, rather than on an unsupported descriptor.
      'O.defineProperty(Object, "defineProperty", { value: !0 });',
      'alsoO.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: e });',
    ].join('\n');
    expect(inspectBrowserProof(source).violations).toContain(
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream'
    );
  });

  it('models strict ESM writes and authoritative non-writable global descriptors before installation', () => {
    const imports = 'import { a as c, b as P } from "./shared-sse.js";';
    const value = 'const e = { createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P };';
    const install = 'Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: e });';
    const rejected =
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream';
    for (const preamble of [
      'const fixed = e; fixed = e;',
      'unresolvable = e;',
      'undefined = e;',
      'globalThis.undefined = e;',
      'Object.defineProperty(globalThis, "undefined", { value: e });',
      'Object.defineProperty(globalThis, "NaN", { value: e });',
      'Object.defineProperty(globalThis, "locked", { value: e, writable: !1 }); locked = e;',
      'Object.defineProperty(globalThis, "getterOnly", { get: c }); getterOnly = e;',
    ]) {
      expect(inspectBrowserProof([imports, value, preamble, install].join('\n')).violations).toContain(
        rejected
      );
    }
  });

  it('keeps parser-created module markup inert in noembed, noframes, scripting noscript, and plaintext', () => {
    for (const tagName of ['noembed', 'noframes', 'noscript']) {
      expect(
        extractHostedHtmlModuleScriptPaths(
          `<${tagName}><script type="module" src="/inert.js"></script></${tagName}><script type="module" src="/live.js"></script>`
        )
      ).toEqual(['live.js']);
    }
    expect(
      extractHostedHtmlModuleScriptPaths(
        '<script type="module" src="/before.js"></script><plaintext><script type="module" src="/inert.js"></script>'
      )
    ).toEqual(['before.js']);
    expect(
      extractHostedHtmlModuleScriptPaths(
        '<template><plaintext><script type="module" src="/inert.js"></script></template><script type="module" src="/also-inert.js"></script>'
      )
    ).toEqual([]);
  });

  it('requires every side-effect dependency initializer to evaluate before the installer', () => {
    const entry = [
      'import "./side-effect.js";',
      'import { a as c, b as P } from "./shared-sse.js";',
      'const e = { createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P };',
      'Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: e });',
    ].join('\n');
    const sideEffect = 'import "./transitive.js"; const ignored = (() => { throw new Error("side-effect"); })(); export {};';
    expect(inspectBrowserProof(entry, undefined, [
      { fileName: 'assets/side-effect.js', moduleIds: ['side-effect'], source: sideEffect },
      { fileName: 'assets/transitive.js', moduleIds: ['transitive'], source: 'throw new Error("transitive");' },
    ]).violations).toContain(
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream'
    );
  });

  it('rejects evaluating class features even when the exported class itself is unused', () => {
    const entry = [
      'import { a as c, b as P } from "./shared-sse.js";',
      'const e = { createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P };',
      'Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: e });',
    ].join('\n');
    for (const classDeclaration of [
      'class P extends (() => { throw new Error("heritage"); })() {}',
      'class P { [(() => { throw new Error("key"); })()]() {} }',
      'class P { field = (() => { throw new Error("field"); })(); }',
      'class P { static { throw new Error("block"); } }',
    ]) {
      expect(inspectBrowserProof(entry, `function c() {} ${classDeclaration} export { c as a, P as b };`).violations).toContain(
        'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream'
      );
    }
  });

  it('rejects descriptor mixtures on non-global defineProperty targets before the installer', () => {
    for (const definition of [
      'Object.defineProperty(target, "incompatible", { value: e, get: c });',
      'Object.defineProperties(target, { incompatible: { value: e, get: c } });',
    ]) {
      const source = [
        'import { a as c, b as P } from "./shared-sse.js";',
        'const target = {};',
        'const e = { createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P };',
        definition,
        'Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: e });',
      ].join('\n');
      expect(inspectBrowserProof(source).violations).toContain(
        'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream'
      );
    }
  });

  it('uses decoded JS string identity for the installed browser property', () => {
    const imports = 'import { a as c, b as P } from "./shared-sse.js";';
    const value = 'const e = { createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P };';
    for (const key of [
      '"__agentTeamsHostedCoordinationEventStrea\\x6d"',
      '"__agentTeamsHostedCoordinationEventStrea\\u006d"',
      '"__agentTeamsHostedCoordinationEventStrea\\u{6d}"',
    ]) expect(inspectBrowserProof(`${imports} ${value} Object.defineProperty(globalThis, ${key}, { value: e });`).violations).toEqual([]);
    expect(inspectBrowserProof(`${imports} ${value} Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStrea\\07", { value: e });`).violations).toContain(
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream'
    );
  });

  it('uses HTML tag and script states plus browser URL identity for entry evidence', () => {
    expect(extractHostedHtmlModuleScriptPaths(
      '<script! type="module" src="/manufactured.js"></script!><script type="module" src="/assets/live.js"></script>'
    )).toEqual(['assets/live.js']);
    expect(extractHostedHtmlModuleScriptPaths(
      '<script><!--<script>still escaped</script>--></script><script type="module" src="/assets/live.js"></script>'
    )).toEqual(['assets/live.js']);
    expect(extractHostedHtmlModuleScriptPaths('<template><script type="module" src="/assets/inert.js"></script></template><script type="module" src="assets/live.js"></script>')).toEqual(['assets/live.js']);
    expect(extractHostedHtmlModuleScriptPaths('<base href="/release/"><script type="module" src="../assets/l&#105;ve.js"></script>')).toEqual(['assets/live.js']);
    expect(extractHostedHtmlModuleScriptPaths('<base href="/release/"><script type="module" src="assets/live.js"></script>')).toEqual(['release/assets/live.js']);
    for (const externalOrDistinct of [
      '<script type="module" src="//external.invalid/assets/live.js"></script>',
      '<script type="module" src="/assets/live.js?version=1"></script>',
      '<script type="module" src="/assets/live.js#fragment"></script>',
      '<script type="module" src="/assets/%6cive.js"></script>',
    ]) expect(extractHostedHtmlModuleScriptPaths(externalOrDistinct)).toBeNull();
  });

  it('returns a deterministic verifier result for direct alias assignment', () => {
    const imports = 'import { a as c, b as P } from "./shared-sse.js";';
    const value = 'const e = { createHostedCoordinationEventStreamObserver: c, HostedCoordinationEventStreamParser: P };';
    const directAlias = `${imports} ${value} const alias = e; alias = e; Object.defineProperty(globalThis, "__agentTeamsHostedCoordinationEventStream", { value: alias });`;
    expect(() => inspectBrowserProof(directAlias)).not.toThrow();
    expect(inspectBrowserProof(directAlias).violations).toContain(
      'hosted_renderer_graph_browser_callable_api_installation_missing:__agentTeamsHostedCoordinationEventStream'
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
    writeFixture(changedChunkRoot, 'out/renderer/assets/shared-sse.js', 'changed after proof\n');
    expect(verifyHostedRendererGraph(changedChunkRoot).violations).toContain(
      'hosted_renderer_graph_chunk_digest_mismatch:assets/shared-sse.js'
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
