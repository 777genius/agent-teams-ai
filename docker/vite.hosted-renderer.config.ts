import { createHash } from 'node:crypto';
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

interface HostedRendererGraphChunk {
  readonly fileName: string;
  readonly imports: readonly string[];
  readonly dynamicImports: readonly string[];
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

/**
 * Fails the hosted build on a forbidden final renderer edge and emits a stable,
 * content-bound description of every JavaScript chunk and resolved module edge.
 */
export function createHostedRendererGraphProofPlugin(): Plugin {
  const importedSpecifiers = new Map<string, Set<string>>();

  return {
    name: 'hosted-renderer-graph-proof',
    // Run before aliases and other resolvers so the proof retains every source specifier.
    enforce: 'pre',
    buildStart() {
      importedSpecifiers.clear();
    },
    resolveId(source, importer) {
      if (importer) {
        const sources = importedSpecifiers.get(importer) ?? new Set<string>();
        sources.add(canonicalImportedSpecifier(source));
        importedSpecifiers.set(importer, sources);
      }
      return null;
    },
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
        imports: sortUnique(chunk.imports.map(normalizeSlashes)),
        dynamicImports: sortUnique(chunk.dynamicImports.map(normalizeSlashes)),
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

      const graph = Object.freeze({
        schemaVersion: 1,
        entryHtml: 'index.html',
        chunks: Object.freeze(graphChunks),
        modules: Object.freeze(graphModules),
      });
      const graphSha256 = sha256(JSON.stringify(graph));
      this.emitFile({
        type: 'asset',
        fileName: HOSTED_RENDERER_GRAPH_MANIFEST,
        source: `${JSON.stringify({ ...graph, graphSha256 }, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig({
  root: HOSTED_RENDERER_ROOT,
  publicDir: false,
  plugins: [
    createHostedRendererGraphProofPlugin(),
    createHostedTaskBoardRendererBoundaryPlugin(),
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
      input: resolve(HOSTED_RENDERER_ROOT, 'index.html'),
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
