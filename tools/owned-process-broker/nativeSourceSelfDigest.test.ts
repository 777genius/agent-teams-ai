import assert from 'node:assert/strict';
import { constants as bufferConstants } from 'node:buffer';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, fstatSync, mkdtempSync, openSync, readFileSync,
  readSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, it } from 'vitest';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const maximum = 512 * 1024;

/** Execute the actual emitted pre-argv checks with inert files; no process or provider is launched. */
function originalPrefix(path: string, expected: string, hooks: {
  beforeRead?(): void;
  maximumRead?: number;
  size?: number;
  nonregular?: boolean;
  statError?: Error;
  readError?: Error;
  closeError?: Error;
  allocationError?: Error;
  hashError?: Error;
  canonical?: string;
} = {}) {
  const source = readFileSync(new URL('./nativeEmulatedSourceProfile.ts', import.meta.url), 'utf8');
  const header = 'const code = `', start = source.indexOf(header), end = source.indexOf('\nconst argv=', start);
  assert.ok(start >= 0 && start === source.lastIndexOf(header) && end > start);
  const emitted = runInNewContext('`' + source.slice(start + header.length, end) + '`',
    { JSON, node: path, fileHash: () => expected }) as string;
  const body = emitted.replace(/import\b[^;]+;/gu, '');
  const observations = { opens: 0, closes: 0, reads: 0, allocated: [] as number[] };
  return { observations, run: () => runInNewContext(body, {
    assert, bufferConstants, process: { execPath: path },
    createHash: (algorithm: string) => {
      if (hooks.hashError) throw hooks.hashError;
      return createHash(algorithm);
    },
    realpathSync: { native: () => hooks.canonical ?? realpathSync.native(path) },
    Buffer: { alloc: Buffer.alloc, concat: Buffer.concat, allocUnsafe: (size: number) => {
      observations.allocated.push(size); assert.ok(size <= maximum, 'bounded fresh image allocation');
      if (hooks.allocationError) throw hooks.allocationError;
      return Buffer.allocUnsafe(size);
    } },
    openSync: (selected: string, flags: string) => {
      assert.equal(selected, path); assert.equal(flags, 'r'); observations.opens++;
      return openSync(selected, flags);
    },
    fstatSync: (fd: number) => {
      if (hooks.statError) throw hooks.statError;
      const info = fstatSync(fd);
      return { size: hooks.size ?? info.size, isFile: () => !hooks.nonregular && info.isFile() };
    },
    readFileSync: (selected: string) => {
      const bytes = readFileSync(selected);
      assert.ok(bytes.length <= maximum, 'the original whole-image allocation exceeds the retained buffer bound');
      return bytes;
    },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: null) => {
      observations.reads++; assert.ok(buffer.length <= maximum); assert.equal(position, null);
      hooks.beforeRead?.(); if (hooks.readError) throw hooks.readError;
      return readSync(fd, buffer, offset, Math.min(length, hooks.maximumRead ?? length), position);
    },
    closeSync: (fd: number) => {
      observations.closes++; closeSync(fd); if (hooks.closeError) throw hooks.closeError;
    },
  }) };
}

function fixture(work: (path: string) => void) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'TEST-source-self-digest-')));
  try { work(join(root, 'TEST-inert-image')); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

describe('the emitted finite source peer checks its original image before reading argv', () => {
  it('hashes every fresh original byte with a bounded buffer and one owned descriptor', () => fixture(path => {
    const bytes = Buffer.alloc(2 * maximum + 17, 0x37); writeFileSync(path, bytes);
    const first = originalPrefix(path, digest(bytes)); first.run();
    assert.deepEqual(first.observations, { opens: 1, closes: 1, reads: 3, allocated: [maximum] });
    bytes[maximum] = 0x38; writeFileSync(path, bytes);
    const changed = originalPrefix(path, digest(Buffer.alloc(bytes.length, 0x37)));
    assert.throws(() => changed.run(), /Expected values to be strictly equal/);
    assert.equal(changed.observations.closes, 1);
  }));

  it('keeps Node 24 initial-size and short-read byte semantics', () => fixture(path => {
    const bytes = Buffer.alloc(513, 0x39); writeFileSync(path, bytes);
    const short = originalPrefix(path, digest(bytes), { maximumRead: 13 }); short.run();
    assert.equal(short.observations.reads, 40); assert.equal(short.observations.closes, 1);
    let first = true;
    const grown = originalPrefix(path, digest(bytes), { beforeRead: () => {
      if (first) { first = false; appendFileSync(path, Buffer.from('TEST later suffix')); }
    } });
    grown.run(); assert.ok(readFileSync(path).length > bytes.length);
    writeFileSync(path, bytes); first = true;
    const truncated = originalPrefix(path, digest(bytes.subarray(0, 257)), { beforeRead: () => {
      if (first) { first = false; truncateSync(path, 257); }
    } });
    truncated.run(); assert.equal(truncated.observations.closes, 1);
  }));

  it('reads empty and unknown-size images through original EOF without retaining chunks', () => fixture(path => {
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(16385, 0x4a)]) {
      writeFileSync(path, bytes);
      const selected = originalPrefix(path, digest(bytes), { nonregular: true }); selected.run();
      assert.deepEqual(selected.observations.allocated, [8192]);
      assert.equal(selected.observations.reads, Math.ceil(bytes.length / 8192) + 1);
      assert.equal(selected.observations.closes, 1);
    }
  }));

  it('preserves read and close refusal identities and closes the exact original descriptor', () => fixture(path => {
    writeFileSync(path, 'TEST image'); const expected = digest(readFileSync(path));
    const readError = Object.assign(new Error('TEST original read'), { code: 'EIO' });
    const closeError = Object.assign(new Error('TEST original close'), { code: 'EIO' });
    for (const hooks of [{ readError }, { closeError }, { readError, closeError }]) {
      const selected = originalPrefix(path, expected, hooks);
      assert.throws(() => selected.run(), error => error === (hooks.closeError ?? readError));
      assert.equal(selected.observations.opens, 1); assert.equal(selected.observations.closes, 1);
    }
    const stat = originalPrefix(path, expected, { statError: new Error('TEST original fstat') });
    assert.throws(() => stat.run(), /Cannot read properties of undefined/);
    assert.equal(stat.observations.reads, 0); assert.equal(stat.observations.closes, 1);
  }));

  it('rejects oversized files before allocation and retains an unknown-size allocation failure', () => fixture(path => {
    writeFileSync(path, 'TEST image'); const expected = digest(readFileSync(path));
    const large = originalPrefix(path, expected, { size: 2 ** 31 });
    assert.throws(() => large.run(), error => (error as NodeJS.ErrnoException).code === 'ERR_FS_FILE_TOO_LARGE');
    assert.deepEqual(large.observations.allocated, []); assert.equal(large.observations.closes, 1);
    const allocationError = new Error('TEST original allocation'), closeError = new Error('TEST close failure');
    const unknown = originalPrefix(path, expected, { nonregular: true, allocationError, closeError });
    assert.throws(() => unknown.run(), error => error === allocationError);
    assert.equal(unknown.observations.reads, 0); assert.equal(unknown.observations.closes, 1);
  }));

  it('keeps the original canonical executable check before its first image read', () => fixture(path => {
    writeFileSync(path, 'TEST image');
    const selected = originalPrefix(path, digest(readFileSync(path)), { canonical: path + '-changed' });
    assert.throws(() => selected.run(), /Expected values to be strictly equal/);
    assert.equal(selected.observations.opens, 0); assert.equal(selected.observations.reads, 0);
  }));

  it('preserves original hash construction before the owned file is opened', () => fixture(path => {
    writeFileSync(path, 'TEST image'); const hashError = new Error('TEST original hash initialization');
    const selected = originalPrefix(path, digest(readFileSync(path)), { hashError });
    assert.throws(() => selected.run(), error => error === hashError);
    assert.equal(selected.observations.opens, 0); assert.equal(selected.observations.reads, 0);
  }));
});
