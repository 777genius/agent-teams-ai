import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { copyRuntimePayload, inventoryRuntimePayload } from './runtime-payload-inventory.mts';

interface CachePort {
  publishRuntimePayload(binary: string, destination: string, sha256: string): Promise<string>;
  isRuntimePayloadCacheValid(destination: string, sha256: string, binary: string): Promise<boolean>;
}
interface Receipt {
  version: number;
  archiveSha256: string;
  binaryName: string;
  entries: [string, string][];
}
const cache: CachePort = createRequire(import.meta.url)('./runtime-payload-cache.mjs');
const sha256 = 'a'.repeat(64);
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

test('async inventory preserves the original sorted depth-first receipt and rejects companion tampering', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'TEST-cache-dfs-'));
  try {
    const source = path.join(root, 'source');
    const destination = path.join(root, 'published');
    fs.mkdirSync(path.join(source, 'a'), { recursive: true });
    fs.writeFileSync(path.join(source, 'a', 'z'), 'nested');
    fs.writeFileSync(path.join(source, 'a.js'), 'sibling');
    fs.writeFileSync(path.join(source, 'orchestrator'), 'fixture; never execute');
    await cache.publishRuntimePayload(path.join(source, 'orchestrator'), destination, sha256);
    const receipt = JSON.parse(
      fs.readFileSync(path.join(destination, '.archive-payload.json'), 'utf8')
    ) as Receipt;
    assert.deepEqual(receipt, {
      version: 1,
      archiveSha256: sha256,
      binaryName: 'orchestrator',
      entries: [
        ['a', 'directory'],
        ['a/z', hash('nested')],
        ['a.js', hash('sibling')],
        ['orchestrator', hash('fixture; never execute')],
      ],
    });
    assert.equal(await cache.isRuntimePayloadCacheValid(destination, sha256, 'orchestrator'), true);
    fs.writeFileSync(path.join(destination, 'a', 'z'), 'changed');
    assert.equal(
      await cache.isRuntimePayloadCacheValid(destination, sha256, 'orchestrator'),
      false
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed final publication restores the previous complete generation and drains reads before cleanup', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'TEST-cache-rollback-'));
  try {
    const source = path.join(root, 'source');
    const destination = path.join(root, 'published');
    fs.mkdirSync(source);
    const binary = path.join(source, 'orchestrator');
    fs.writeFileSync(binary, 'previous');
    await cache.publishRuntimePayload(binary, destination, sha256);
    fs.writeFileSync(binary, 'replacement');
    const rename = fs.renameSync;
    context.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike): void => {
      if (String(from).includes('.stage-') && to === destination)
        throw new Error('TEST publication denied');
      rename(from, to);
    });
    await assert.rejects(
      cache.publishRuntimePayload(binary, destination, sha256),
      /TEST publication denied/u
    );
    assert.equal(fs.readFileSync(path.join(destination, 'orchestrator'), 'utf8'), 'previous');
    assert.equal(await cache.isRuntimePayloadCacheValid(destination, sha256, 'orchestrator'), true);
    assert.deepEqual(fs.readdirSync(root).sort(), ['published', 'source']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  'an unsupported source entry fails without replacing the previous generation',
  { skip: process.platform === 'win32' },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'TEST-cache-link-'));
    try {
      const source = path.join(root, 'source');
      const destination = path.join(root, 'published');
      fs.mkdirSync(source);
      const binary = path.join(source, 'orchestrator');
      fs.writeFileSync(binary, 'previous');
      await cache.publishRuntimePayload(binary, destination, sha256);
      fs.symlinkSync(binary, path.join(source, 'unsupported'));
      await assert.rejects(
        cache.publishRuntimePayload(binary, destination, sha256),
        /Unsupported runtime archive entry/u
      );
      assert.equal(
        await cache.isRuntimePayloadCacheValid(destination, sha256, 'orchestrator'),
        true
      );
      assert.deepEqual(fs.readdirSync(root).sort(), ['published', 'source']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('inventory failure waits for an already opened reader before rejecting and cleanup', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'TEST-cache-drain-'));
  const readStarted = deferred();
  const readRelease = deferred();
  const failureObserved = deferred();
  let publication: Promise<string> | undefined;
  try {
    const source = path.join(root, 'source');
    const destination = path.join(root, 'published');
    fs.mkdirSync(source);
    const binary = path.join(source, 'orchestrator');
    fs.writeFileSync(binary, 'previous');
    await cache.publishRuntimePayload(binary, destination, sha256);
    const held = path.join(source, 'a-held');
    const broken = path.join(source, 'b-broken');
    fs.writeFileSync(held, 'held reader');
    fs.writeFileSync(broken, 'unreadable');
    const createStream = fs.createReadStream;
    context.mock.method(
      fs,
      'createReadStream',
      (file: fs.PathLike, options?: Parameters<typeof fs.createReadStream>[1]): fs.ReadStream => {
        const stream = createStream(file, options);
        if (file === held) {
          const read = stream._read.bind(stream);
          stream._read = (size: number): void => {
            readStarted.resolve();
            void readRelease.promise.then(() => read(size));
          };
        }
        return stream;
      }
    );
    const lstat = fs.promises.lstat;
    context.mock.method(fs.promises, 'lstat', async (...args: Parameters<typeof lstat>) => {
      if (args[0] === broken) {
        await readStarted.promise;
        failureObserved.resolve();
        throw new Error('TEST unreadable entry');
      }
      return lstat(...args);
    });
    let settled = false;
    publication = cache.publishRuntimePayload(binary, destination, sha256);
    void publication.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await failureObserved.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      settled,
      false,
      'failed inventory must retain ownership until the opened reader drains'
    );
    readRelease.resolve();
    await assert.rejects(publication, /TEST unreadable entry/u);
    assert.equal(fs.readFileSync(path.join(destination, 'orchestrator'), 'utf8'), 'previous');
    assert.deepEqual(fs.readdirSync(root).sort(), ['published', 'source']);
  } finally {
    readRelease.resolve();
    await publication?.catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('copy failure drains already admitted copies before removing the private stage', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'TEST-cache-copy-drain-'));
  const started = deferred();
  const release = deferred();
  const failed = deferred();
  let publication: Promise<string> | undefined;
  try {
    const source = path.join(root, 'source');
    const destination = path.join(root, 'published');
    fs.mkdirSync(source);
    const binary = path.join(source, 'orchestrator');
    fs.writeFileSync(binary, 'previous');
    await cache.publishRuntimePayload(binary, destination, sha256);
    fs.writeFileSync(path.join(source, 'a-held'), 'held');
    fs.writeFileSync(path.join(source, 'b-failed'), 'failure');
    const copy = fs.promises.copyFile;
    context.mock.method(
      fs.promises,
      'copyFile',
      async (...args: Parameters<typeof copy>): Promise<void> => {
        if (path.basename(String(args[0])) === 'a-held') {
          started.resolve();
          await release.promise;
        }
        if (path.basename(String(args[0])) === 'b-failed') {
          await started.promise;
          failed.resolve();
          throw new Error('TEST copy failure');
        }
        await copy(...args);
      }
    );
    let settled = false;
    publication = cache.publishRuntimePayload(binary, destination, sha256);
    void publication.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await failed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'stage cleanup must wait for the admitted copy');
    assert.equal(
      fs.readdirSync(root).some((name) => name.includes('.stage-')),
      true
    );
    release.resolve();
    await assert.rejects(publication, /TEST copy failure/u);
    assert.equal(await cache.isRuntimePayloadCacheValid(destination, sha256, 'orchestrator'), true);
    assert.equal(fs.readFileSync(path.join(destination, 'orchestrator'), 'utf8'), 'previous');
    assert.deepEqual(fs.readdirSync(root).sort(), ['published', 'source']);
  } finally {
    release.resolve();
    await publication?.catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bounded copy preserves modes, refuses an existing stage, and rejects an inventoried file changed to a directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'TEST-cache-copy-contract-'));
  try {
    const source = path.join(root, 'source');
    const stage = path.join(root, 'stage');
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
    const companion = path.join(source, 'nested', 'companion');
    fs.writeFileSync(companion, 'companion');
    fs.chmodSync(companion, 0o751);
    fs.chmodSync(path.join(source, 'nested'), 0o750);
    const entries = await inventoryRuntimePayload(source);
    await copyRuntimePayload(source, stage, entries);
    assert.equal(fs.readFileSync(path.join(stage, 'nested', 'companion'), 'utf8'), 'companion');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(stage, 'nested')).mode & 0o7777, 0o750);
      assert.equal(fs.statSync(path.join(stage, 'nested', 'companion')).mode & 0o7777, 0o751);
    }
    await assert.rejects(copyRuntimePayload(source, stage, entries), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(path.join(stage, 'nested', 'companion'), 'utf8'), 'companion');
    fs.unlinkSync(companion);
    fs.mkdirSync(companion);
    await assert.rejects(
      copyRuntimePayload(source, path.join(root, 'changed-stage'), entries),
      /changed kind/u
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  'private writable root preserves exact readonly source child modes',
  { skip: process.platform === 'win32' },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'TEST-cache-readonly-copy-'));
    const source = path.join(root, 'source');
    const stage = path.join(root, 'stage');
    try {
      fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
      fs.writeFileSync(path.join(source, 'nested', 'companion'), 'readonly fixture');
      fs.chmodSync(path.join(source, 'nested', 'companion'), 0o444);
      fs.chmodSync(path.join(source, 'nested'), 0o555);
      fs.chmodSync(source, 0o555);
      await copyRuntimePayload(source, stage, await inventoryRuntimePayload(source));
      assert.equal(fs.statSync(stage).mode & 0o7777, 0o700);
      for (const relative of ['nested', 'nested/companion']) {
        assert.equal(
          fs.statSync(path.join(stage, relative)).mode & 0o7777,
          fs.statSync(path.join(source, relative)).mode & 0o7777
        );
      }
      assert.equal(
        fs.readFileSync(path.join(stage, 'nested', 'companion'), 'utf8'),
        'readonly fixture'
      );
    } finally {
      for (const directory of [source, stage]) {
        if (fs.existsSync(directory)) fs.chmodSync(directory, 0o700);
        if (fs.existsSync(path.join(directory, 'nested')))
          fs.chmodSync(path.join(directory, 'nested'), 0o700);
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test(
  'publishes and replaces a readonly source root while keeping the private generation writable',
  { skip: process.platform === 'win32' },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'TEST-cache-readonly-publish-'));
    const source = path.join(root, 'source');
    const destination = path.join(root, 'published');
    try {
      fs.mkdirSync(source);
      const binary = path.join(source, 'orchestrator');
      fs.writeFileSync(binary, 'first generation');
      fs.chmodSync(source, 0o555);
      await cache.publishRuntimePayload(binary, destination, sha256);
      assert.equal(fs.statSync(destination).mode & 0o7777, 0o700);
      assert.equal(
        await cache.isRuntimePayloadCacheValid(destination, sha256, 'orchestrator'),
        true
      );
      assert.equal(
        fs.readFileSync(path.join(destination, 'orchestrator'), 'utf8'),
        'first generation'
      );
      assert.equal(fs.statSync(source).mode & 0o7777, 0o555);
      fs.writeFileSync(binary, 'replacement generation');
      const replacementSha = 'b'.repeat(64);
      await cache.publishRuntimePayload(binary, destination, replacementSha);
      assert.equal(fs.statSync(destination).mode & 0o7777, 0o700);
      assert.equal(
        await cache.isRuntimePayloadCacheValid(destination, replacementSha, 'orchestrator'),
        true
      );
      assert.equal(
        await cache.isRuntimePayloadCacheValid(destination, sha256, 'orchestrator'),
        false
      );
      assert.equal(
        fs.readFileSync(path.join(destination, 'orchestrator'), 'utf8'),
        'replacement generation'
      );
      assert.deepEqual(fs.readdirSync(root).sort(), ['published', 'source']);
    } finally {
      // Only the deliberately readonly source fixture needs permission restoration.
      // Published generations must remain removable without a cleanup workaround.
      fs.chmodSync(source, 0o700);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
