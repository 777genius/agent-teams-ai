import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import type { Plugin, Rollup } from 'vite';
import {
  isSentryArtifactFile,
  parseSentryArtifactInventory,
  SENTRY_DEBUG_ID_PATTERN,
  SENTRY_INVENTORY_FILE,
  SENTRY_INVENTORY_MAX_ARTIFACTS,
  SENTRY_INVENTORY_MAX_BYTES,
  SENTRY_INVENTORY_PAYLOAD_ID,
  SENTRY_TARGET_PREFIXES,
  type SentryBuildIdentity,
  type SentryRuntimeInventory,
} from '../../src/shared/utils/sentryArtifactInventory.js';

type OutputBundle = Rollup.OutputBundle;
type OutputChunk = Rollup.OutputChunk;

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_MAP_BYTES = 256 * 1024 * 1024;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
export type SentryCoveredTarget = 'main' | 'renderer';
export type SentryArtifactEvidence = Readonly<{
  relativeFile: string;
  debugId: string;
  source: Readonly<{ sha256: string; bytes: number }>;
  originalMap: Readonly<{ relativeFile: string; sha256: string; bytes: number }>;
}>;
export type SentryInventoryEvidence = Readonly<{
  schemaVersion: 1;
  target: SentryCoveredTarget;
  runtime: SentryRuntimeInventory;
  runtimeSha256: string;
  mapStage: 'original-before-sentry-upload-preparation';
  uploadVerified: false;
  artifacts: readonly SentryArtifactEvidence[];
}>;
export type SentryInventoryOptions = SentryBuildIdentity &
  Readonly<{
    target: SentryCoveredTarget;
    covered: boolean;
    evidenceDirectory: string;
    assetRoot?: string;
    documentPreviewWorkers?: readonly Readonly<{
      sourceFile: string;
      assetName: string;
      sha256: string;
      bytes: number;
    }>[];
  }>;

/** Resolve through the actual pnpm dependency owners, not an unhoisted root dependency. */
export function pinDocumentPreviewWorkers(projectRoot: string) {
  const rootRequire = createRequire(join(projectRoot, 'package.json'));
  const presetRequire = createRequire(
    rootRequire.resolve('@file-viewer/preset-office/package.json')
  );
  return [
    {
      owners: ['renderer-presentation', 'renderer-pptx'],
      request: '@file-viewer/pptx/worker/pptx.worker.js',
    },
    { owners: ['renderer-word'], request: '@file-viewer/doc/worker' },
    { owners: ['renderer-presentation', 'renderer-ppt'], request: '@file-viewer/ppt/worker.mjs' },
  ].map(({ owners, request }) => {
    let ownerRequire = presetRequire;
    for (const owner of owners)
      ownerRequire = createRequire(ownerRequire.resolve(`@file-viewer/${owner}/package.json`));
    const sourceFile = realpathSync(ownerRequire.resolve(request));
    const bytes = readFileSync(sourceFile);
    return Object.freeze({
      sourceFile,
      assetName: basename(sourceFile),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    });
  });
}

function isPinnedDocumentPreviewWorker(item: Rollup.OutputAsset, options: SentryInventoryOptions) {
  if (
    options.target !== 'renderer' ||
    !options.assetRoot ||
    !/^assets\/(?:pptx\.)?worker-[A-Za-z0-9_-]+\.(?:js|mjs)$/.test(item.fileName) ||
    item.names.length !== 1 ||
    item.originalFileNames.length !== 1
  )
    return false;
  const sourceFile = resolve(options.assetRoot, item.originalFileNames[0]!);
  const bytes = typeof item.source === 'string' ? Buffer.from(item.source) : item.source;
  return (
    options.documentPreviewWorkers?.some(
      (pin) =>
        item.names[0] === pin.assetName &&
        item.fileName.startsWith(`assets/${pin.assetName.replace(/\.(?:js|mjs)$/, '')}-`) &&
        item.fileName.endsWith(pin.assetName.endsWith('.mjs') ? '.mjs' : '.js') &&
        sourceFile === pin.sourceFile &&
        bytes.length === pin.bytes &&
        createHash('sha256').update(bytes).digest('hex') === pin.sha256
    ) ?? false
  );
}

function digest(value: string): { sha256: string; bytes: number } {
  return {
    sha256: createHash('sha256').update(value).digest('hex'),
    bytes: Buffer.byteLength(value),
  };
}
function bounded(value: string, limit: number, name: string): void {
  if (Buffer.byteLength(value) > limit) throw new Error(`Sentry inventory: oversized ${name}`);
}
function sourceOf(value: string | Uint8Array): string {
  return typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
}
function debugId(code: string): string {
  const markers = [...code.matchAll(/sentry-dbid-([^"'`\s;]+)/g)];
  if (markers.length !== 1 || !SENTRY_DEBUG_ID_PATTERN.test(markers[0]?.[1] ?? '')) {
    throw new Error('Sentry inventory: expected exactly one canonical injected debug ID');
  }
  return markers[0]![1]!;
}
function verifyMap(json: string, chunk: OutputChunk, id: string): void {
  let map: unknown;
  try {
    map = JSON.parse(json);
  } catch {
    throw new Error('Sentry inventory: malformed source map');
  }
  if (!map || typeof map !== 'object' || Array.isArray(map))
    throw new Error('Sentry inventory: invalid v3 source map');
  const value = map as Record<string, unknown>;
  if (
    value.version !== 3 ||
    typeof value.mappings !== 'string' ||
    !/^[A-Za-z0-9+/,;]*$/.test(value.mappings) ||
    !Array.isArray(value.sources) ||
    !value.sources.every((source) => typeof source === 'string') ||
    !Array.isArray(value.names) ||
    !value.names.every((name) => typeof name === 'string') ||
    (value.file !== undefined &&
      value.file !== chunk.fileName &&
      value.file !== basename(chunk.fileName)) ||
    (value.sourcesContent !== undefined &&
      (!Array.isArray(value.sourcesContent) ||
        value.sourcesContent.length !== value.sources.length ||
        !value.sourcesContent.every(
          (content) => content === null || typeof content === 'string'
        ))) ||
    ['debugId', 'debug_id'].some((key) => value[key] !== undefined && value[key] !== id)
  ) {
    throw new Error('Sentry inventory: invalid or mismatched v3 source map');
  }
  // Rollup owns the original chunk/map association. Do not admit an unrelated asset by filename alone.
  if (!chunk.map || JSON.stringify(JSON.parse(chunk.map.toString())) !== JSON.stringify(map)) {
    throw new Error('Sentry inventory: emitted source map differs from chunk map');
  }
}

/** Uses only this build's emitted chunks; never scans stale files in an output directory. */
export function collectSentryArtifactInventory(
  bundle: OutputBundle,
  options: SentryInventoryOptions
): SentryInventoryEvidence {
  if (
    options.covered &&
    Object.values(bundle).some(
      (item) =>
        item.type === 'asset' &&
        /\.(?:js|cjs|mjs)$/.test(item.fileName) &&
        !isPinnedDocumentPreviewWorker(item, options)
    )
  ) {
    throw new Error('Sentry inventory: JavaScript asset lacks a Rollup chunk/map association');
  }
  const chunks = Object.values(bundle).filter((item): item is OutputChunk => item.type === 'chunk');
  if (chunks.length > SENTRY_INVENTORY_MAX_ARTIFACTS)
    throw new Error('Sentry inventory: too many emitted chunks');
  const artifacts: SentryArtifactEvidence[] = [];
  const rows: SentryRuntimeInventory['artifacts'][number][] = [];
  if (options.covered && !chunks.length)
    throw new Error('Sentry inventory: covered target has no chunks');
  for (const chunk of chunks) {
    if (!isSentryArtifactFile(chunk.fileName))
      throw new Error('Sentry inventory: unsafe emitted chunk filename');
    if (!options.covered) continue;
    bounded(chunk.code, MAX_SOURCE_BYTES, 'JavaScript chunk');
    const id = debugId(chunk.code);
    const mapFile = `${chunk.fileName}.map`;
    const map = bundle[mapFile];
    if (!map || map.type !== 'asset')
      throw new Error('Sentry inventory: missing emitted source map');
    const mapSource = sourceOf(map.source);
    bounded(mapSource, MAX_MAP_BYTES, 'source map');
    verifyMap(mapSource, chunk, id);
    const relativeFile = SENTRY_TARGET_PREFIXES[options.target] + chunk.fileName;
    rows.push({
      target: options.target,
      relativeFile,
      locator: `app:///${relativeFile}`,
      debugId: id,
    });
    artifacts.push({
      relativeFile,
      debugId: id,
      source: digest(chunk.code),
      originalMap: { relativeFile: `${relativeFile}.map`, ...digest(mapSource) },
    });
  }
  rows.sort((a, b) => (a.locator < b.locator ? -1 : a.locator > b.locator ? 1 : 0));
  artifacts.sort((a, b) =>
    a.relativeFile < b.relativeFile ? -1 : a.relativeFile > b.relativeFile ? 1 : 0
  );
  const raw = JSON.stringify({
    schemaVersion: 1,
    release: options.release,
    buildId: options.buildId,
    gitSha: options.gitSha,
    artifacts: rows,
    coverage: {
      main: 'uncovered',
      renderer: 'uncovered',
      preload: 'uncovered',
      [options.target]: options.covered ? 'covered' : 'uncovered',
    },
  });
  const runtime = parseSentryArtifactInventory(raw, options);
  if (!runtime)
    throw new Error('Sentry inventory: invalid build identity or conflicting artifact rows');
  return Object.freeze({
    schemaVersion: 1,
    target: options.target,
    runtime,
    runtimeSha256: digest(JSON.stringify(runtime)).sha256,
    mapStage: 'original-before-sentry-upload-preparation',
    uploadVerified: false,
    artifacts: Object.freeze(
      artifacts.map((row) =>
        Object.freeze({
          ...row,
          source: Object.freeze(row.source),
          originalMap: Object.freeze(row.originalMap),
        })
      )
    ),
  });
}

export function insertSentryInventoryPayload(
  html: string,
  inventory: SentryRuntimeInventory
): string {
  bounded(html, MAX_HTML_BYTES, 'renderer HTML');
  if (html.includes(SENTRY_INVENTORY_PAYLOAD_ID))
    throw new Error('Sentry inventory: duplicate renderer payload');
  const json = JSON.stringify(inventory).replace(/</g, '\\u003c');
  bounded(json, SENTRY_INVENTORY_MAX_BYTES, 'renderer payload');
  // Inserting at the beginning of head puts data before module/preload scripts regardless of Vite layout.
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (!head || !/<script\b[^>]*\btype\s*=\s*["']module["']/i.test(html))
    throw new Error('Sentry inventory: final renderer HTML is missing head/module');
  const offset = head.index + head[0].length;
  return `${html.slice(0, offset)}\n<script id="${SENTRY_INVENTORY_PAYLOAD_ID}" type="application/json">${json}</script>${html.slice(offset)}`;
}

async function saveEvidence(
  directory: string,
  target: SentryCoveredTarget,
  evidence: SentryInventoryEvidence
): Promise<void> {
  const json = JSON.stringify(evidence, null, 2) + '\n';
  bounded(json, 2 * SENTRY_INVENTORY_MAX_BYTES, 'host evidence');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${target}.json`);
  try {
    await writeFile(path, json, { flag: 'wx' });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      (await readFile(path, 'utf8')) !== json
    )
      throw error;
  }
}

export function sentryArtifactInventoryPlugin(options: SentryInventoryOptions): Plugin {
  let assetRoot: string | undefined;
  return {
    name: 'application-sentry-artifact-inventory',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      assetRoot = config.root;
    },
    generateBundle: {
      order: 'post',
      async handler(_outputOptions, bundle) {
        if (bundle[SENTRY_INVENTORY_FILE])
          throw new Error('Sentry inventory: sidecar already exists');
        const evidence = collectSentryArtifactInventory(bundle, { ...options, assetRoot });
        if (options.target === 'renderer') {
          const html = bundle['index.html'];
          if (!html || html.type !== 'asset')
            throw new Error('Sentry inventory: final renderer index.html is missing');
          html.source = insertSentryInventoryPayload(sourceOf(html.source), evidence.runtime);
        }
        this.emitFile({
          type: 'asset',
          fileName: SENTRY_INVENTORY_FILE,
          source: JSON.stringify(evidence.runtime),
        });
        // Outside packaged output, before Sentry's writeBundle upload-copy rewriting/deletion.
        await saveEvidence(options.evidenceDirectory, options.target, evidence);
      },
    },
  };
}
