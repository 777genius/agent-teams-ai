// @vitest-environment node
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  collectSentryArtifactInventory,
  insertSentryInventoryPayload,
  type SentryInventoryOptions,
} from '../../scripts/build/sentryArtifactInventory.js';
import {
  parseSentryArtifactInventory,
  SENTRY_INVENTORY_MAX_ARTIFACTS,
  SENTRY_INVENTORY_MAX_BYTES,
  SENTRY_INVENTORY_PAYLOAD_ID,
} from '../../src/shared/utils/sentryArtifactInventory.js';

import type { Rollup } from 'vite';

type OutputAsset = Rollup.OutputAsset;
type OutputBundle = Rollup.OutputBundle;
type OutputChunk = Rollup.OutputChunk;
type SourceMap = Rollup.SourceMap;

// Independent literals exercise admission boundaries. The integration suite generates real SDK IDs.
const ID = '91b28a5c-d347-4c18-9a26-b9cf378e52d1';
const OTHER_ID = 'dcce018b-46a1-4f04-809c-9edda3b3feb4';
const identity = {
  release: 'agent-teams-ai@2.17.1',
  buildId: 'sandbox-1',
  gitSha: '1234567890abcdef1234567890abcdef12345678',
};
const options: SentryInventoryOptions = {
  ...identity,
  target: 'main',
  covered: true,
  evidenceDirectory: '/unused-test-directory',
};
function fixture(fileName = 'index.cjs', id = ID): OutputBundle {
  const raw = {
    version: 3,
    file: fileName,
    names: [],
    sources: ['sandbox-entry.ts'],
    mappings: 'AAAA',
    sourcesContent: ['throw new Error("sandbox")'],
  };
  const map: SourceMap = { ...raw, toString: () => JSON.stringify(raw), toUrl: () => '' };
  const chunk: OutputChunk = {
    type: 'chunk',
    fileName,
    name: fileName,
    code: `globalThis._sentryDebugIdIdentifier="sentry-dbid-${id}";throw new Error("sandbox");`,
    map,
    sourcemapFileName: `${fileName}.map`,
    preliminaryFileName: fileName,
    isEntry: true,
    isDynamicEntry: false,
    isImplicitEntry: false,
    facadeModuleId: null,
    moduleIds: [],
    exports: [],
    imports: [],
    dynamicImports: [],
    implicitlyLoadedBefore: [],
    importedBindings: {},
    modules: {},
    referencedFiles: [],
  };
  const asset: OutputAsset = {
    type: 'asset',
    fileName: `${fileName}.map`,
    names: [],
    originalFileNames: [],
    source: JSON.stringify(raw),
    name: undefined,
    originalFileName: null,
    needsCodeReference: false,
  };
  return { [fileName]: chunk, [`${fileName}.map`]: asset };
}
function chunk(bundle: OutputBundle): OutputChunk {
  return Object.values(bundle).find((row): row is OutputChunk => row.type === 'chunk')!;
}
function runtime() {
  return collectSentryArtifactInventory(fixture(), options).runtime;
}
function parse(value: unknown) {
  return parseSentryArtifactInventory(JSON.stringify(value), identity);
}

describe('emitted Sentry artifact inventory', () => {
  it('includes workers and dynamic chunks deterministically; hashes original bytes and keeps roots/content out of runtime', () => {
    const bundle = { ...fixture('worker.cjs', OTHER_ID), ...fixture('index.cjs') };
    const first = collectSentryArtifactInventory(bundle, options);
    const indexChunk = bundle['index.cjs'] as OutputChunk;
    const second = collectSentryArtifactInventory(
      Object.fromEntries(Object.entries(bundle).reverse()),
      options
    );
    expect(first).toEqual(second);
    expect(first.runtime.artifacts.map((row) => row.relativeFile)).toEqual([
      'dist-electron/main/index.cjs',
      'dist-electron/main/worker.cjs',
    ]);
    expect(first.runtime.coverage).toEqual({
      main: 'covered',
      renderer: 'uncovered',
      preload: 'uncovered',
    });
    expect(first.artifacts[0]?.source).toEqual({
      sha256: createHash('sha256').update(indexChunk.code).digest('hex'),
      bytes: Buffer.byteLength(indexChunk.code),
    });
    const original = bundle['index.cjs.map'] as OutputAsset;
    expect(first.artifacts[0]?.originalMap).toEqual({
      relativeFile: 'dist-electron/main/index.cjs.map',
      sha256: createHash('sha256').update(original.source).digest('hex'),
      bytes: Buffer.byteLength(original.source),
    });
    expect(first.mapStage).toBe('original-before-sentry-upload-preparation');
    expect(first.uploadVerified).toBe(false);
    expect(JSON.stringify(first.runtime)).not.toContain('sandbox-entry.ts');
    expect(JSON.stringify(first.runtime)).not.toContain('/unused-test-directory');
    expect(Object.isFrozen(first.runtime.artifacts[0])).toBe(true);
  });
  it('permits one debug ID at distinct locators and rejects conflicting/duplicate markers', () => {
    expect(
      collectSentryArtifactInventory({ ...fixture(), ...fixture('worker.cjs') }, options).runtime
        .artifacts
    ).toHaveLength(2);
    for (const suffix of [
      `;"sentry-dbid-${OTHER_ID}"`,
      `;"sentry-dbid-${ID}"`,
      ';"sentry-dbid-invalid"',
    ]) {
      const bundle = fixture();
      chunk(bundle).code += suffix;
      expect(() => collectSentryArtifactInventory(bundle, options)).toThrow(
        'exactly one canonical'
      );
    }
    for (const id of [ID.toUpperCase(), ID.replace('-4c18-', '-1c18-'), 'invalid']) {
      expect(() => collectSentryArtifactInventory(fixture('index.cjs', id), options)).toThrow(
        'canonical'
      );
    }
  });
  it('rejects missing, malformed, cross-chunk or mismatched original maps', () => {
    for (const mutation of [
      (bundle: OutputBundle) => {
        delete bundle['index.cjs.map'];
      },
      (bundle: OutputBundle) => {
        (bundle['index.cjs.map'] as OutputAsset).source = '{';
      },
      (bundle: OutputBundle) => {
        (bundle['index.cjs.map'] as OutputAsset).source = JSON.stringify({
          version: 3,
          file: 'other.cjs',
          names: [],
          sources: ['other.ts'],
          mappings: 'AAAA',
        });
      },
      (bundle: OutputBundle) => {
        chunk(bundle).map = null;
      },
      (bundle: OutputBundle) => {
        (bundle['index.cjs.map'] as OutputAsset).source = chunk(
          fixture('other.cjs')
        ).map!.toString();
      },
    ]) {
      const bundle = fixture();
      mutation(bundle);
      expect(() => collectSentryArtifactInventory(bundle, options)).toThrow();
    }
  });
  it('rejects unsafe filenames, identity mismatches and excessive entries', () => {
    for (const file of [
      '../index.cjs',
      'assets/%2e.js',
      'assets\\index.js',
      '/index.js',
      'assets/index.js?x',
      'assets//index.js',
    ]) {
      expect(() => collectSentryArtifactInventory(fixture(file), options)).toThrow();
    }
    expect(() =>
      collectSentryArtifactInventory(fixture(), { ...options, buildId: 'private/path' })
    ).toThrow('invalid build');
    const bundle: OutputBundle = {};
    for (let i = 0; i <= SENTRY_INVENTORY_MAX_ARTIFACTS; i++)
      Object.assign(bundle, fixture(`chunk-${i}.js`));
    expect(() => collectSentryArtifactInventory(bundle, options)).toThrow('too many');
  });
  it('emits empty fail-closed inventories for no-auth builds without claiming coverage', () => {
    const bundle = fixture();
    chunk(bundle).code = 'console.log("no injection")';
    delete bundle['index.cjs.map'];
    const evidence = collectSentryArtifactInventory(bundle, {
      ...options,
      covered: false,
      gitSha: '',
      buildId: '',
    });
    expect(evidence.runtime.artifacts).toEqual([]);
    expect(evidence.runtime.coverage).toEqual({
      main: 'uncovered',
      renderer: 'uncovered',
      preload: 'uncovered',
    });
  });
});

describe('runtime contract and synchronous renderer payload', () => {
  it('fails closed for wrong build, unsafe pair, extra keys, conflicts and uncovered/preload rows', () => {
    const original = runtime();
    expect(parse(original)).toEqual(original);
    expect(
      parseSentryArtifactInventory(JSON.stringify(original), {
        ...identity,
        buildId: 'another-build',
      })
    ).toBeNull();
    const row = original.artifacts[0]!;
    for (const value of [
      { ...original, token: 'secret' },
      { ...original, coverage: { ...original.coverage, main: 'uncovered' } },
      { ...original, artifacts: [row, row] },
      { ...original, artifacts: [{ ...row, locator: row.locator + '?token=x' }] },
      { ...original, artifacts: [{ ...row, target: 'preload' }] },
      { ...original, artifacts: [{ ...row, debugId: OTHER_ID, sourcesContent: 'secret' }] },
      {
        ...original,
        artifacts: [
          {
            ...row,
            relativeFile: 'dist-electron/main/../index.cjs',
            locator: 'app:///dist-electron/main/../index.cjs',
          },
        ],
      },
    ])
      expect(parse(value)).toBeNull();
    expect(
      parseSentryArtifactInventory(' '.repeat(SENTRY_INVENTORY_MAX_BYTES + 1), identity)
    ).toBeNull();
  });
  it('places nonexecuting bounded data before modules without modifying JS; escapes HTML syntax', () => {
    const bundle = fixture();
    const before = chunk(bundle).code;
    const inventory = collectSentryArtifactInventory(bundle, options).runtime;
    const html = insertSentryInventoryPayload(
      '<html><head><script type="module" src="/entry.js"></script></head></html>',
      inventory
    );
    expect(html.indexOf('type="application/json"')).toBeLessThan(html.indexOf('type="module"'));
    const json = html.match(/type="application\/json">([^]*?)<\/script>/)?.[1];
    expect(parseSentryArtifactInventory(json!, identity)).toEqual(inventory);
    expect(chunk(bundle).code).toBe(before);
    expect(() => insertSentryInventoryPayload(html, inventory)).toThrow('duplicate');
    expect(() => insertSentryInventoryPayload('<head></head>', inventory)).toThrow(
      'missing head/module'
    );
    const escaped = insertSentryInventoryPayload('<head><script type="module"></script>', {
      ...inventory,
      release: '</script><script>bad()</script>',
    });
    expect(escaped).toContain('\\u003c/script>');
    expect(escaped.match(new RegExp(`id="${SENTRY_INVENTORY_PAYLOAD_ID}"`, 'g'))).toHaveLength(1);
  });
});
