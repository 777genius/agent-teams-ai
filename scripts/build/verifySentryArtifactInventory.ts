/** Disposable real locked-plugin build. Run only on the validation host, without inherited Sentry auth. */
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { resolveConfig as resolveElectronConfig } from 'electron-vite';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  build,
  resolveConfig as resolveViteConfig,
  version as viteVersion,
  type Plugin,
  type Rollup,
} from 'vite';
import {
  sentryArtifactInventoryPlugin,
  type SentryCoveredTarget,
} from './sentryArtifactInventory.js';
import {
  parseSentryArtifactInventory,
  SENTRY_INVENTORY_FILE,
  SENTRY_INVENTORY_PAYLOAD_ID,
} from '../../src/shared/utils/sentryArtifactInventory.js';

const identity = {
  release: 'agent-teams-ai@inventory-sandbox',
  buildId: 'inventory-sandbox',
  gitSha: '1234567890abcdef1234567890abcdef12345678',
};
const root = process.argv[2];
if (!root) throw new Error('Supply a disposable synthetic build directory');
if (Object.keys(process.env).some((key) => key.startsWith('SENTRY_')))
  throw new Error('Sentry environment must be isolated');
const directory = resolve(root);
await mkdir(directory, { recursive: true });
// Never inherit a tsconfig from a shared temporary parent or another validation job.
await writeFile(
  join(directory, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ES2023',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
    },
  })
);
await writeFile(
  join(directory, 'main.ts'),
  'export function syntheticMain() { throw new Error("synthetic-main"); }\n'
);
await writeFile(
  join(directory, 'worker.ts'),
  'export function syntheticWorker() { throw new Error("synthetic-worker"); }\n'
);
await writeFile(
  join(directory, 'renderer.ts'),
  'globalThis.addEventListener("synthetic", async () => (await import("./dynamic.ts")).syntheticDynamic());\n'
);
await writeFile(
  join(directory, 'dynamic.ts'),
  'export function syntheticDynamic() { throw new Error("synthetic-dynamic"); }\n'
);
await writeFile(
  join(directory, 'index.html'),
  '<html><head></head><body><script type="module" src="/renderer.ts"></script></body></html>\n'
);
// Resolve the installed Electron preset, rather than using Vite's browser compatibility defaults.
const electronConfigFile = join(directory, 'electron.synthetic.config.ts');
await writeFile(electronConfigFile, 'export default { renderer: {} };\n');
const electronConfig = await resolveElectronConfig(
  {
    root: directory,
    configFile: electronConfigFile,
    ignoreConfigWarning: true,
    logLevel: 'silent',
  },
  'build',
  'production'
);
if (!electronConfig.config?.renderer) throw new Error('Synthetic Electron renderer preset missing');
const rendererConfig = await resolveViteConfig(
  {
    ...electronConfig.config.renderer,
    configFile: false,
    root: directory,
    envDir: directory,
    base: './',
    logLevel: 'silent',
    build: {
      outDir: join(directory, 'renderer'),
      rollupOptions: { input: join(directory, 'index.html') },
    },
  },
  'build',
  'production'
);
const rendererBuildTarget = rendererConfig.build.target;
const observations: unknown[] = [];
function hash(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
for (const target of ['main', 'renderer'] as const) {
  const outDir = join(directory, target);
  const evidenceDirectory = join(directory, 'host-evidence');
  const early = new Map<string, string>();
  const before = new Map<string, { source: string; map: string }>();
  const hookOrder: string[] = [];
  const earlyObserver: Plugin = {
    name: 'synthetic-inventory-early-vite-observer',
    generateBundle: {
      order: 'pre',
      handler(_options, bundle) {
        hookOrder.push('generateBundle-before-vite-finalizers');
        for (const item of Object.values(bundle))
          if (item.type === 'chunk') early.set(item.fileName, hash(item.code));
      },
    },
  };
  const observer: Plugin = {
    name: 'synthetic-inventory-order-observer',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        hookOrder.push('generateBundle-before-inventory');
        for (const item of Object.values(bundle)) {
          if (item.type !== 'chunk') continue;
          const map = bundle[`${item.fileName}.map`];
          if (!map || map.type !== 'asset') throw new Error('Finalizer observer missing map');
          before.set(item.fileName, {
            source: hash(item.code),
            map: hash(
              typeof map.source === 'string' ? map.source : Buffer.from(map.source).toString('utf8')
            ),
          });
        }
      },
    },
    writeBundle: {
      order: 'post',
      async handler(_options, bundle) {
        hookOrder.push('writeBundle-after-inventory');
        const sidecar = bundle[SENTRY_INVENTORY_FILE];
        if (!sidecar || sidecar.type !== 'asset') throw new Error('Sidecar missing at writeBundle');
        const runtime = parseSentryArtifactInventory(String(sidecar.source), identity);
        if (!runtime) throw new Error('Invalid synthetic runtime inventory');
        const chunks = Object.values(bundle).filter(
          (item): item is Rollup.OutputChunk => item.type === 'chunk'
        );
        const finalBytes = [];
        for (const item of chunks) {
          finalBytes.push({
            file: item.fileName,
            early: early.get(item.fileName),
            beforeProducer: before.get(item.fileName),
            afterProducer: hash(item.code),
            disk: hash(await readFile(join(outDir, item.fileName), 'utf8')),
          });
        }
        await writeFile(
          join(directory, `${target}-hook-bytes.json`),
          JSON.stringify(finalBytes, null, 2)
        );
        for (const item of finalBytes) {
          if (
            !item.beforeProducer ||
            item.beforeProducer.source !== item.afterProducer ||
            item.disk !== item.beforeProducer.source
          )
            throw new Error(
              'Producer/following hook modified final injected JavaScript; see hook-bytes evidence'
            );
        }
        const evidence = JSON.parse(
          await readFile(join(evidenceDirectory, `${target}.json`), 'utf8')
        );
        if (
          evidence.uploadVerified !== false ||
          evidence.mapStage !== 'original-before-sentry-upload-preparation'
        )
          throw new Error('Unexpected upload claim');
        for (const item of evidence.artifacts) {
          const file = item.relativeFile.replace(
            target === 'main' ? 'dist-electron/main/' : 'out/renderer/',
            ''
          );
          const snapshot = before.get(file);
          if (
            !snapshot ||
            snapshot.source !== item.source.sha256 ||
            hash(await readFile(join(outDir, file), 'utf8')) !== item.source.sha256 ||
            snapshot.map !== item.originalMap.sha256 ||
            hash(await readFile(join(outDir, file + '.map'), 'utf8')) !== item.originalMap.sha256
          )
            throw new Error('Final original source/map digest mismatch');
        }
        if (target === 'renderer') {
          const html = await readFile(join(outDir, 'index.html'), 'utf8');
          const payload = html.match(
            new RegExp(
              `<script id="${SENTRY_INVENTORY_PAYLOAD_ID}" type="application/json">([^]*?)</script>`
            )
          )?.[1];
          if (
            !payload ||
            JSON.stringify(parseSentryArtifactInventory(payload, identity)) !==
              JSON.stringify(runtime) ||
            html.indexOf(SENTRY_INVENTORY_PAYLOAD_ID) > html.indexOf('type="module"')
          )
            throw new Error('Final Vite HTML payload/order mismatch');
        }
        observations.push({
          target,
          hookOrder,
          artifactFiles: runtime.artifacts.map((row) => row.relativeFile),
          viteFinalizerChangedFiles: finalBytes
            .filter((item) => item.early !== item.beforeProducer?.source)
            .map((item) => item.file),
          jsUnchanged: true,
          originalMapsMatched: true,
          runtime,
        });
      },
    },
  };
  await build({
    configFile: false,
    root: directory,
    envDir: directory,
    base: './',
    logLevel: 'silent',
    plugins: [
      // Locked plugin v5 supports injection while disabling upload. Also disable every release mutation.
      sentryVitePlugin({
        telemetry: false,
        sourcemaps: { disable: 'disable-upload' },
        release: {
          name: identity.release,
          inject: false,
          create: false,
          finalize: false,
          setCommits: false,
        },
      }),
      earlyObserver,
      observer,
      sentryArtifactInventoryPlugin({
        ...identity,
        target: target as SentryCoveredTarget,
        covered: true,
        evidenceDirectory,
      }),
    ],
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: 'hidden',
      minify: false,
      target: target === 'renderer' ? rendererBuildTarget : undefined,
      modulePreload: target === 'renderer' ? { polyfill: false } : undefined,
      rollupOptions:
        target === 'main'
          ? {
              input: { main: join(directory, 'main.ts'), worker: join(directory, 'worker.ts') },
              preserveEntrySignatures: 'strict',
              output: { format: 'cjs', entryFileNames: '[name].cjs' },
            }
          : { input: join(directory, 'index.html') },
    },
  });
}
await writeFile(
  join(directory, 'report.json'),
  JSON.stringify(
    { viteVersion, rendererBuildTarget, identity, uploadDisabled: true, observations },
    null,
    2
  ) + '\n'
);
