import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileDigest } from './desktop-file-digest.ts';

const chunk = 512 * 1024;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t: TestContext, length: number) {
  const root = await fs.mkdtemp(join(tmpdir(), 'TEST-desktop-file-digest-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const path = join(root, 'bytes');
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  await fs.writeFile(path, bytes);
  return { path, bytes };
}

function wrapOpen(t: TestContext, wrap: (handle: FileHandle) => void) {
  const original = fs.open;
  let opens = 0;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    assert.equal(args[1], 'r');
    opens++;
    const handle = await original(...args);
    wrap(handle);
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return () => opens;
}

test('large file digest has bounded allocation and the original SHA-256', async (t) => {
  const { path, bytes } = await fixture(t, 3 * chunk + 17);
  const expected = hash(await fs.readFile(path));
  assert.equal(expected, hash(bytes));
  const allocations: number[] = [];
  const allocate = Buffer.allocUnsafeSlow;
  t.mock.method(Buffer, 'allocUnsafeSlow', (size: number) => {
    allocations.push(size);
    return allocate(size);
  });
  assert.equal(await fileDigest(path), expected);
  assert.ok(allocations.length > 0);
  assert.ok(Math.max(...allocations) <= chunk, `largest allocation: ${Math.max(...allocations)}`);
});

test('binary hashes match readFile at empty, small and chunk size boundaries', async (t) => {
  for (const length of [0, 1, 65535, 65536, chunk - 1, chunk, chunk + 1]) {
    await t.test(String(length), async (t) => {
      const { path } = await fixture(t, length);
      assert.equal(await fileDigest(path), hash(await fs.readFile(path)));
    });
  }
});

test('small source files allocate their initial size, not a full chunk', async (t) => {
  const { path, bytes } = await fixture(t, 17);
  const allocate = Buffer.allocUnsafeSlow;
  const allocations: number[] = [];
  t.mock.method(Buffer, 'allocUnsafeSlow', (size: number) => {
    allocations.push(size);
    return allocate(size);
  });
  assert.equal(await fileDigest(path), hash(bytes));
  assert.deepEqual(allocations, [17]);
});

test('append after initial stat is excluded, and the next call observes fresh bytes', async (t) => {
  const { path, bytes } = await fixture(t, 2 * chunk + 17);
  const appended = Buffer.from('TEST appended after original size');
  let stats = 0;
  const opens = wrapOpen(t, (handle) => {
    const stat = handle.stat.bind(handle);
    t.mock.method(handle, 'stat', async () => {
      const value = await stat();
      if (++stats === 1) await fs.appendFile(path, appended);
      return value;
    });
  });
  assert.equal(await fileDigest(path), hash(bytes));
  assert.equal(await fileDigest(path), hash(Buffer.concat([bytes, appended])));
  assert.equal(opens(), 2);
  assert.equal(stats, 2);
});

test('replacement after stat does not reopen the original descriptor', async (t) => {
  const { path, bytes } = await fixture(t, chunk + 17);
  const replacement = Buffer.from('TEST replacement inode');
  let stats = 0;
  const opens = wrapOpen(t, (handle) => {
    const stat = handle.stat.bind(handle);
    t.mock.method(handle, 'stat', async () => {
      const value = await stat();
      if (++stats === 1) {
        await fs.rename(path, `${path}.original`);
        await fs.writeFile(path, replacement);
      }
      return value;
    });
  });
  assert.equal(await fileDigest(path), hash(bytes));
  assert.equal(opens(), 1);
  assert.equal(await fileDigest(path), hash(replacement));
  assert.equal(opens(), 2);
});

test('truncation and short reads retain small versus large readFile behavior', async (t) => {
  for (const length of [37, 2 * chunk + 17]) {
    for (const truncate of [false, true]) {
      await t.test(`${length} truncate=${truncate}`, async (t) => {
        const { path, bytes } = await fixture(t, length);
        const requests: number[] = [];
        wrapOpen(t, (handle) => {
          const stat = handle.stat.bind(handle);
          const read = handle.read.bind(handle);
          t.mock.method(handle, 'stat', async () => {
            const value = await stat();
            if (truncate) await fs.truncate(path, 7);
            return value;
          });
          t.mock.method(handle, 'read', async (buffer: Buffer, offset: number, size: number, position: null) => {
            assert.equal(position, null, 'keep the original descriptor offset');
            assert.equal(buffer.length, Math.min(length, chunk));
            requests.push(size);
            return read(buffer, offset, requests.length === 1 ? Math.min(size, 7) : size, position);
          });
        });
        const expected = truncate || length <= chunk ? bytes.subarray(0, 7) : bytes;
        assert.equal(await fileDigest(path), hash(expected));
        if (length <= chunk) assert.deepEqual(requests, [length]);
        else if (truncate) assert.deepEqual(requests, [chunk, chunk]);
        else assert.deepEqual(requests, [chunk, chunk, chunk, 10]);
      });
    }
  }
});

test('zero-sized regular and nonregular inputs read 64KiB chunks through EOF', async (t) => {
  for (const regular of [true, false]) {
    await t.test(regular ? 'initially empty' : 'nonregular size ignored', async (t) => {
      const { path, bytes } = await fixture(t, regular ? 0 : 150_003);
      const content = regular ? Buffer.alloc(150_003, 91) : bytes;
      const requests: number[] = [];
      wrapOpen(t, (handle) => {
        const stat = handle.stat.bind(handle);
        const read = handle.read.bind(handle);
        t.mock.method(handle, 'stat', async () => {
          const value = await stat();
          if (regular) await fs.appendFile(path, content);
          else { value.isFile = () => false; value.size = 2 ** 32; }
          return value;
        });
        t.mock.method(handle, 'read', async (buffer: Buffer, offset: number, size: number, position: null) => {
          requests.push(size);
          assert.equal(buffer.length, 65536);
          assert.equal(position, null);
          return read(buffer, offset, size, position);
        });
      });
      assert.equal(await fileDigest(path), hash(content));
      assert.deepEqual(requests, [65536, 65536, 65536, 65536]);
    });
  }
});

test('initial regular size over 2GiB rejects before reads and closes the same handle', async (t) => {
  const { path } = await fixture(t, 1);
  let reads = 0;
  let closes = 0;
  wrapOpen(t, (handle) => {
    const stat = handle.stat.bind(handle);
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'stat', async () => Object.assign(await stat(), { size: 2 ** 31 }));
    t.mock.method(handle, 'read', async () => { reads++; throw new Error('must not read'); });
    t.mock.method(handle, 'close', async () => { closes++; await close(); });
  });
  await assert.rejects(fileDigest(path), {
    name: 'RangeError', code: 'ERR_FS_FILE_TOO_LARGE',
    message: 'File size (2147483648) is greater than 2 GiB',
  });
  assert.equal(reads, 0);
  assert.equal(closes, 1);
});

test('open, stat and read failures preserve errors and readFile close aggregation', async (t) => {
  for (const phase of ['open', 'stat', 'read', 'close', 'both', 'aggregate', 'same'] as const) {
    await t.test(phase, async (t) => {
      const { path } = await fixture(t, 17);
      const operation = Object.assign(
        phase === 'aggregate' ? new AggregateError([new Error('first')], 'TEST aggregate') : new Error('TEST read'),
        { code: 'TEST_READ' }
      );
      const closeError = phase === 'same' ? operation : new Error('TEST close');
      let closes = 0;
      if (phase === 'open') {
        t.mock.method(fs, 'open', async () => { throw operation; });
        syncBuiltinESMExports();
        t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
      } else wrapOpen(t, (handle) => {
        const close = handle.close.bind(handle);
        if (phase === 'stat') t.mock.method(handle, 'stat', async () => { throw operation; });
        else if (phase !== 'close') t.mock.method(handle, 'read', async () => { throw operation; });
        t.mock.method(handle, 'close', async () => {
          closes++;
          await close();
          if (['close', 'both', 'aggregate', 'same'].includes(phase)) throw closeError;
        });
      });
      await assert.rejects(fileDigest(path), (error: unknown) => {
        if (phase === 'both') {
          assert.ok(error instanceof AggregateError);
          assert.deepEqual(error.errors, [operation, closeError]);
          assert.equal(error.message, operation.message);
          assert.equal((error as NodeJS.ErrnoException).code, operation.code);
        } else {
          assert.equal(error, phase === 'close' ? closeError : operation);
          if (phase === 'aggregate') {
            assert.ok(operation instanceof AggregateError);
            assert.equal(operation.errors.at(-1), closeError);
          }
        }
        return true;
      });
      assert.equal(closes, phase === 'open' ? 0 : 1);
    });
  }
});

test('successful digest waits for original descriptor close', async (t) => {
  const { path, bytes } = await fixture(t, 17);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const closing = new Promise<void>(resolve => { entered = resolve; });
  wrapOpen(t, (handle) => {
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'close', async () => { await close(); entered(); await gate; });
  });
  let settled = false;
  const result = fileDigest(path).then(value => { settled = true; return value; });
  await closing;
  assert.equal(settled, false);
  release();
  assert.equal(await result, hash(bytes));
});
