import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// @ts-expect-error The repository-owned JavaScript artifact verifier has no declaration file.
import { classifyForbiddenHostedRendererReference as classifyForbiddenReference } from '../scripts/ci/verify-hosted-no-terminal-artifact.mjs';

import type { Plugin } from 'vite';

const ROOT = resolve(__dirname, '..');
const HOSTED_RENDERER_ROOT = resolve(ROOT, 'src/renderer/hosted');
const HOSTED_RENDERER_OUTPUT = resolve(ROOT, 'out/renderer');
const HOSTED_RENDERER_GRAPH_MANIFEST = 'hosted-renderer-graph.json';
const HOSTED_BROWSER_EVENT_STREAM_GLOBAL = '__agentTeamsHostedCoordinationEventStream';
const HOSTED_BROWSER_EVENT_STREAM_ENTRY =
  'src/renderer/hosted/hostedCoordinationEventStreamBrowserEntry.ts';
const HOSTED_BROWSER_EVENT_STREAM_API = Object.freeze([
  Object.freeze({
    globalKey: 'createHostedCoordinationEventBootstrapTransport',
    moduleId:
      'src/features/coordination-events/renderer/transport/createHostedCoordinationEventBootstrapTransport.ts',
  }),
  Object.freeze({
    globalKey: 'createHostedCoordinationEventTransport',
    moduleId:
      'src/features/coordination-events/renderer/transport/createHostedCoordinationEventTransport.ts',
  }),
]);
const HOSTED_BROWSER_EVENT_STREAM_CHUNKS = new Map([
  [
    'src/features/coordination-events/renderer/transport/createHostedCoordinationEventBootstrapTransport.ts',
    'hosted-coordination-event-bootstrap',
  ],
  [
    'src/features/coordination-events/renderer/transport/createHostedCoordinationEventTransport.ts',
    'hosted-coordination-event-stream',
  ],
]);

interface HostedRendererGraphChunk {
  readonly fileName: string;
  readonly isEntry: boolean;
  readonly facadeModuleId: string | null;
  readonly imports: readonly string[];
  readonly dynamicImports: readonly string[];
  readonly exports: readonly string[];
  readonly moduleIds: readonly string[];
  readonly sha256: string;
}

interface HostedRendererGraphModule {
  readonly id: string;
  readonly importedSpecifiers: readonly string[];
  readonly resolvedImports: readonly string[];
  readonly resolvedDynamicImports: readonly string[];
}

interface HostedRendererGraphViolation {
  readonly kind: string;
  readonly reference: string;
}

const classifyForbiddenHostedRendererReference = classifyForbiddenReference as (
  referenceValue: string
) => HostedRendererGraphViolation | null;

function normalizeSlashes(value: string): string {
  return value.split(sep).join('/');
}

function canonicalModuleId(value: string): string {
  const virtualPrefix = value.startsWith('\0') ? '\0' : '';
  const unprefixedValue = virtualPrefix ? value.slice(1) : value;
  const queryIndex = unprefixedValue.indexOf('?');
  const path = queryIndex < 0 ? unprefixedValue : unprefixedValue.slice(0, queryIndex);
  const query = queryIndex < 0 ? '' : unprefixedValue.slice(queryIndex);
  if (!isAbsolute(path)) return `${virtualPrefix}${normalizeSlashes(path)}${query}`;

  const repositoryPath = relative(ROOT, path);
  if (
    repositoryPath !== '..' &&
    !repositoryPath.startsWith(`..${sep}`) &&
    !isAbsolute(repositoryPath)
  ) {
    return `${virtualPrefix}${normalizeSlashes(repositoryPath)}${query}`;
  }
  return `${virtualPrefix}${normalizeSlashes(path)}${query}`;
}

function canonicalImportedSpecifier(value: string): string {
  const unprefixedValue = value.startsWith('\0') ? value.slice(1) : value;
  const path = unprefixedValue.split('?')[0];
  return isAbsolute(path) ? canonicalModuleId(value) : value.replaceAll('\\', '/');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sortUnique(values: Iterable<string>): readonly string[] {
  return Object.freeze([...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

/**
 * The desktop task-board renderer barrel also exports eager analytics adapters.
 * Hosted composition resolves that public surface to only its reviewed browser exports.
 */
function createHostedTaskBoardRendererBoundaryPlugin(): Plugin {
  const boundaryId = '\0hosted-task-board-renderer-boundary';
  const publicEntryDirectory = resolve(ROOT, 'src/features/team-task-board/renderer');
  const publicEntry = resolve(publicEntryDirectory, 'index.ts');
  const pageModule = resolve(
    ROOT,
    'src/features/team-task-board/renderer/components/HostedTaskBoardPage.tsx'
  );
  const transportModule = resolve(
    ROOT,
    'src/features/team-task-board/renderer/composition/createHostedTaskBoardTransport.ts'
  );
  return {
    name: 'hosted-task-board-renderer-boundary',
    enforce: 'pre',
    resolveId(source) {
      return source === '@features/team-task-board/renderer' ||
        source === publicEntryDirectory ||
        source === publicEntry
        ? boundaryId
        : null;
    },
    load(id) {
      if (id !== boundaryId) return null;
      return [
        `export { HostedTaskBoardPage } from ${JSON.stringify(pageModule)};`,
        `export { createHostedTaskBoardTransport, HOSTED_TASK_BOARD_PAGE_HTTP_PATH } from ${JSON.stringify(transportModule)};`,
      ].join('\n');
    },
  };
}

/** Resolve the browser seam's public renderer import to its two transport exports. */
function createHostedCoordinationEventStreamBrowserBoundaryPlugin(): Plugin {
  const boundaryId = '\0hosted-coordination-event-stream-browser-boundary';
  const browserEntry = resolve(
    HOSTED_RENDERER_ROOT,
    'hostedCoordinationEventStreamBrowserEntry.ts'
  );
  const publicEntryDirectory = resolve(ROOT, 'src/features/coordination-events/renderer');
  const publicEntry = resolve(publicEntryDirectory, 'index.ts');
  const bootstrapModule = resolve(
    ROOT,
    'src/features/coordination-events/renderer/transport/createHostedCoordinationEventBootstrapTransport.ts'
  );
  const streamModule = resolve(
    ROOT,
    'src/features/coordination-events/renderer/transport/createHostedCoordinationEventTransport.ts'
  );
  return {
    name: 'hosted-coordination-event-stream-browser-boundary',
    enforce: 'pre',
    resolveId(source, importer) {
      return importer === browserEntry &&
        (source === '@features/coordination-events/renderer' ||
          source === publicEntryDirectory ||
          source === publicEntry)
        ? boundaryId
        : null;
    },
    load(id) {
      if (id !== boundaryId) return null;
      return [
        `export { createHostedCoordinationEventBootstrapTransport } from ${JSON.stringify(bootstrapModule)};`,
        `export { createHostedCoordinationEventTransport } from ${JSON.stringify(streamModule)};`,
      ].join('\n');
    },
  };
}

/** Collect source specifiers before aliases while the post plugin proves emitted bytes. */
export function createHostedRendererGraphProofPlugins(): readonly Plugin[] {
  const importedSpecifiers = new Map<string, Set<string>>();
  let pendingGraph: {
    readonly chunks: readonly HostedRendererGraphChunk[];
    readonly modules: readonly HostedRendererGraphModule[];
  } | null = null;

  const collector: Plugin = {
    name: 'hosted-renderer-graph-import-collector',
    enforce: 'pre',
    buildStart() {
      importedSpecifiers.clear();
      pendingGraph = null;
    },
    resolveId(source, importer) {
      if (importer) {
        const sources = importedSpecifiers.get(importer) ?? new Set<string>();
        sources.add(canonicalImportedSpecifier(source));
        importedSpecifiers.set(importer, sources);
      }
      return null;
    },
  };

  const proof: Plugin = {
    name: 'hosted-renderer-graph-proof',
    // HTML is emitted by Vite's build plugin. The manifest is written only
    // from writeBundle, after those final bytes exist on disk.
    enforce: 'post',
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle)
        .filter(
          (output): output is Extract<typeof output, { type: 'chunk' }> => output.type === 'chunk'
        )
        .sort((left, right) => left.fileName.localeCompare(right.fileName));
      if (chunks.length === 0) {
        this.error('hosted-renderer-graph:no-javascript-chunks');
      }

      const finalModuleIds = new Set(chunks.flatMap((chunk) => Object.keys(chunk.modules)));
      const graphChunks: HostedRendererGraphChunk[] = chunks.map((chunk) => ({
        fileName: normalizeSlashes(chunk.fileName),
        isEntry: chunk.isEntry,
        facadeModuleId:
          chunk.facadeModuleId === null ? null : canonicalModuleId(chunk.facadeModuleId),
        imports: sortUnique(chunk.imports.map(normalizeSlashes)),
        dynamicImports: sortUnique(chunk.dynamicImports.map(normalizeSlashes)),
        exports: sortUnique(chunk.exports),
        moduleIds: sortUnique(Object.keys(chunk.modules).map(canonicalModuleId)),
        sha256: sha256(chunk.code),
      }));
      for (const chunk of graphChunks) {
        for (const reference of [...chunk.imports, ...chunk.dynamicImports]) {
          const violation = classifyForbiddenHostedRendererReference(reference);
          if (violation) {
            this.error(`hosted-renderer-graph:${violation.kind}:${violation.reference}`);
          }
        }
      }

      const graphModules: HostedRendererGraphModule[] = [...finalModuleIds]
        .sort((left, right) => canonicalModuleId(left).localeCompare(canonicalModuleId(right)))
        .map((moduleId) => {
          const id = canonicalModuleId(moduleId);
          const idViolation = classifyForbiddenHostedRendererReference(id);
          if (idViolation) {
            const importerTrace = [moduleId];
            while (importerTrace.length < 12) {
              const importer = this.getModuleInfo(importerTrace[importerTrace.length - 1])
                ?.importers[0];
              if (!importer || importerTrace.includes(importer)) break;
              importerTrace.push(importer);
            }
            this.error(
              `hosted-renderer-graph:${idViolation.kind}:${idViolation.reference}:importers=${importerTrace
                .map(canonicalModuleId)
                .join('<-')}`
            );
          }

          const specifiers = sortUnique(importedSpecifiers.get(moduleId) ?? []);
          for (const specifier of specifiers) {
            const violation = classifyForbiddenHostedRendererReference(specifier);
            if (violation) {
              this.error(`hosted-renderer-graph:${violation.kind}:${violation.reference}`);
            }
          }

          const info = this.getModuleInfo(moduleId);
          if (!info) this.error(`hosted-renderer-graph:module-info-missing:${id}`);
          const resolvedImports = sortUnique(
            info.importedIds
              .filter((resolvedId) => finalModuleIds.has(resolvedId))
              .map(canonicalModuleId)
          );
          const resolvedDynamicImports = sortUnique(
            info.dynamicallyImportedIds
              .filter((resolvedId) => finalModuleIds.has(resolvedId))
              .map(canonicalModuleId)
          );
          for (const resolvedId of [...resolvedImports, ...resolvedDynamicImports]) {
            const violation = classifyForbiddenHostedRendererReference(resolvedId);
            if (violation) {
              this.error(`hosted-renderer-graph:${violation.kind}:${violation.reference}`);
            }
          }

          return { id, importedSpecifiers: specifiers, resolvedImports, resolvedDynamicImports };
        });

      if (!graphModules.some((module) => module.id === 'src/renderer/hosted/main.tsx')) {
        this.error('hosted-renderer-graph:hosted-entry-missing');
      }
      if (!graphModules.some((module) => module.id === HOSTED_BROWSER_EVENT_STREAM_ENTRY)) {
        this.error('hosted-renderer-graph:hosted-browser-event-stream-entry-missing');
      }
      const installerEntries = graphChunks.filter(
        (chunk) => chunk.isEntry && chunk.facadeModuleId === HOSTED_BROWSER_EVENT_STREAM_ENTRY
      );
      if (
        installerEntries.length !== 1 ||
        installerEntries[0].moduleIds.includes('src/renderer/hosted/main.tsx')
      ) {
        this.error('hosted-renderer-graph:hosted-browser-event-stream-entry-not-isolated');
      }
      const apiChunkPaths = HOSTED_BROWSER_EVENT_STREAM_API.map(({ moduleId }) =>
        graphChunks.filter((chunk) => chunk.moduleIds.includes(moduleId)).map((chunk) => chunk.fileName)
      );
      if (
        apiChunkPaths.some((paths) => paths.length !== 1) ||
        new Set(apiChunkPaths.flat()).size !== HOSTED_BROWSER_EVENT_STREAM_API.length
      ) {
        this.error('hosted-renderer-graph:hosted-browser-event-stream-api-not-isolated');
      }
      pendingGraph = Object.freeze({
        chunks: Object.freeze(graphChunks),
        modules: Object.freeze(graphModules),
      });
    },
    writeBundle(options) {
      const generatedGraph = pendingGraph;
      if (generatedGraph === null) {
        this.error('hosted-renderer-graph:graph-not-generated');
        return;
      }
      const outputRoot = options.dir ? resolve(options.dir) : HOSTED_RENDERER_OUTPUT;
      const entryHtmlPath = resolve(outputRoot, 'index.html');
      const entryHtml = readFileSync(entryHtmlPath, 'utf8');
      const graphChunks = Object.freeze(
        generatedGraph.chunks.map((chunk) =>
          Object.freeze({
            ...chunk,
            sha256: sha256(
              readFileSync(resolve(outputRoot, ...chunk.fileName.split('/')), 'utf8')
            ),
          })
        )
      );
      const graph = Object.freeze({
        schemaVersion: 4,
        entryHtml: 'index.html',
        entryHtmlSha256: sha256(entryHtml),
        expectedBrowserGlobal: HOSTED_BROWSER_EVENT_STREAM_GLOBAL,
        expectedBrowserApi: HOSTED_BROWSER_EVENT_STREAM_API,
        chunks: graphChunks,
        modules: generatedGraph.modules,
      });
      const graphSha256 = sha256(JSON.stringify(graph));
      writeFileSync(
        resolve(outputRoot, HOSTED_RENDERER_GRAPH_MANIFEST),
        `${JSON.stringify({ ...graph, graphSha256 }, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' }
      );
    },
  };

  return Object.freeze([collector, proof]);
}

export default defineConfig({
  root: HOSTED_RENDERER_ROOT,
  publicDir: false,
  plugins: [
    ...createHostedRendererGraphProofPlugins(),
    createHostedTaskBoardRendererBoundaryPlugin(),
    createHostedCoordinationEventStreamBrowserBoundaryPlugin(),
    react(),
  ],
  resolve: {
    alias: {
      '@features': resolve(ROOT, 'src/features'),
      '@renderer': resolve(ROOT, 'src/renderer'),
      '@shared': resolve(ROOT, 'src/shared'),
    },
  },
  build: {
    outDir: HOSTED_RENDERER_OUTPUT,
    emptyOutDir: true,
    target: 'es2023',
    sourcemap: process.env.AGENT_TEAMS_DISABLE_SOURCEMAPS === '1' ? false : 'hidden',
    rollupOptions: {
      input: {
        index: resolve(HOSTED_RENDERER_ROOT, 'index.html'),
        hostedCoordinationEventStreamBrowserEntry: resolve(
          HOSTED_RENDERER_ROOT,
          'hostedCoordinationEventStreamBrowserEntry.ts'
        ),
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        manualChunks(id) {
          return HOSTED_BROWSER_EVENT_STREAM_CHUNKS.get(canonicalModuleId(id));
        },
      },
    },
  },
});
