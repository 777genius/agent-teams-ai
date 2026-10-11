import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { assertSafeRuntimeZip } from './runtime-archive-extraction.mts';
import {
  ambiguousDirectoryFixture,
  xlLinkFixture,
  zipExtra,
  zip64Footer,
  zipFixture,
} from './runtime-zip.test-fixture.mts';

function archiveTest(bytes: Buffer, check: (file: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'TEST-runtime-zip-preflight-'));
  try {
    const file = path.join(root, "archive [x] 'quote'.zip");
    fs.writeFileSync(file, bytes);
    check(file);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
for (const name of [
  '../outside/escape',
  'link/../escape',
  '\\outside\\escape',
  'C:/outside/escape',
  'runtime/file:stream',
  'runtime/.. /escape',
  'runtime/COM¹.log',
  'runtime/LPT³',
  'runtime/COM0.log',
  'runtime/LPT0',
  'runtime/CONIN$',
  'runtime/CONOUT$.log',
]) {
  test(`rejects unsafe ZIP path before extraction: ${name}`, () =>
    archiveTest(zipFixture([{ name, data: 'forbidden' }]), (file) =>
      assert.throws(() => assertSafeRuntimeZip(file), /Unsupported runtime archive entry/)
    ));
}
test('rejects the native Windows symlink-then-child escape before extraction', () => {
  archiveTest(
    zipFixture([
      { name: 'link', data: '../outside', symlink: true },
      { name: 'link/escape', data: 'forbidden' },
    ]),
    (file) => assert.throws(() => assertSafeRuntimeZip(file), /Unsupported runtime archive entry/)
  );
});
test('accepts valid quoted nested ZIP payload and empty ZIP', () => {
  for (const bytes of [
    zipFixture([{ name: "runtime/file [x] 'quote'.js", data: 'retained' }]),
    zipFixture([]),
  ])
    archiveTest(bytes, (file) => assertSafeRuntimeZip(file));
});
test('rejects central/local filename disagreement', () => {
  const bytes = zipFixture([{ name: 'runtime/safe', data: 'retained' }]);
  bytes.write('../outside/x', 30, 'utf8');
  archiveTest(bytes, (file) =>
    assert.throws(() => assertSafeRuntimeZip(file), /filename mismatch/)
  );
});
test('rejects an unlisted local record rather than letting native tar stream it', () => {
  const first = zipFixture([{ name: 'first', data: 'retained' }]),
    hidden = zipFixture([{ name: '../escape', data: 'forbidden' }]);
  const firstEnd = first.length - 22,
    centralOffset = first.readUInt32LE(firstEnd + 16);
  const hiddenOffset = hidden.readUInt32LE(hidden.length - 22 + 16),
    hiddenLocal = hidden.subarray(0, hiddenOffset);
  const central = first.subarray(centralOffset, firstEnd),
    footer = Buffer.from(first.subarray(firstEnd));
  footer.writeUInt32LE(centralOffset + hiddenLocal.length, 16);
  const bytes = Buffer.concat([first.subarray(0, centralOffset), hiddenLocal, central, footer]);
  archiveTest(bytes, (file) =>
    assert.throws(() => assertSafeRuntimeZip(file), /Malformed runtime ZIP/)
  );
});
test('accepts ZIP64 count footer used by large runtime archives', () => {
  const bytes = zipFixture([{ name: 'runtime/regular', data: 'retained' }]),
    end = bytes.length - 22;
  const zip64 = Buffer.alloc(56),
    locator = Buffer.alloc(20),
    footer = Buffer.from(bytes.subarray(end));
  zip64.writeUInt32LE(0x06064b50);
  zip64.writeBigUInt64LE(44n, 4);
  zip64.writeUInt16LE(45, 12);
  zip64.writeUInt16LE(45, 14);
  zip64.writeBigUInt64LE(1n, 24);
  zip64.writeBigUInt64LE(1n, 32);
  zip64.writeBigUInt64LE(BigInt(footer.readUInt32LE(12)), 40);
  zip64.writeBigUInt64LE(BigInt(footer.readUInt32LE(16)), 48);
  locator.writeUInt32LE(0x07064b50);
  locator.writeBigUInt64LE(BigInt(end), 8);
  locator.writeUInt32LE(1, 16);
  footer.writeUInt16LE(0xffff, 8);
  footer.writeUInt16LE(0xffff, 10);
  archiveTest(Buffer.concat([bytes.subarray(0, end), zip64, locator, footer]), (file) =>
    assertSafeRuntimeZip(file)
  );
});

test('rejects case/path aliases and a regular file used as an ancestor', () => {
  for (const names of [
    ['runtime/File', 'runtime/file'],
    ['runtime/./file', 'runtime/file'],
    ['runtime/file', 'runtime/file/escape'],
  ]) {
    archiveTest(zipFixture(names.map((name) => ({ name, data: 'retained' }))), (file) =>
      assert.throws(() => assertSafeRuntimeZip(file), /Unsupported runtime archive entry/)
    );
  }
});
function descriptorFixture(zip64: boolean, deflate = true): Buffer {
  const original = zipFixture([{ name: 'runtime/file', data: 'retained', deflate }]);
  const end = original.length - 22;
  const centralOffset = original.readUInt32LE(end + 16);
  const header = Buffer.from(original.subarray(0, 30));
  const nameEnd = 30 + header.readUInt16LE(26);
  const compressed = header.readUInt32LE(18);
  const uncompressed = header.readUInt32LE(22);
  const extra = Buffer.alloc(zip64 ? 20 : 0);
  if (zip64) {
    extra.writeUInt16LE(1);
    extra.writeUInt16LE(16, 2);
    extra.writeBigUInt64LE(BigInt(uncompressed), 4);
    extra.writeBigUInt64LE(BigInt(compressed), 12);
    header.writeUInt16LE(45, 4);
  }
  header.writeUInt16LE(8, 6);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(zip64 ? 0xffffffff : 0, 18);
  header.writeUInt32LE(zip64 ? 0xffffffff : 0, 22);
  header.writeUInt16LE(extra.length, 28);
  const descriptor = Buffer.alloc(zip64 ? 24 : 16);
  descriptor.writeUInt32LE(0x08074b50);
  descriptor.writeUInt32LE(original.readUInt32LE(14), 4);
  if (zip64) {
    descriptor.writeBigUInt64LE(BigInt(compressed), 8);
    descriptor.writeBigUInt64LE(BigInt(uncompressed), 16);
  } else {
    descriptor.writeUInt32LE(compressed, 8);
    descriptor.writeUInt32LE(uncompressed, 12);
  }
  const central = Buffer.from(original.subarray(centralOffset, end));
  central.writeUInt16LE(8, 8);
  const footer = Buffer.from(original.subarray(end));
  footer.writeUInt32LE(centralOffset + extra.length + descriptor.length, 16);
  return Buffer.concat([
    header,
    original.subarray(30, nameEnd),
    extra,
    original.subarray(nameEnd, centralOffset),
    descriptor,
    central,
    footer,
  ]);
}
test('accepts conventional and ZIP64 descriptors with consistent local metadata', () => {
  for (const zip64 of [false, true])
    archiveTest(descriptorFixture(zip64), (file) => assertSafeRuntimeZip(file));
});
test('rejects contradictory populated descriptor fields and ZIP64 extra sizes', () => {
  const ordinary = descriptorFixture(false);
  ordinary.writeUInt32LE(99, 18);
  const zip64 = descriptorFixture(true);
  zip64.writeBigUInt64LE(99n, 30 + zip64.readUInt16LE(26) + 4);
  const missing = descriptorFixture(true);
  missing.writeUInt16LE(0x5455, 30 + missing.readUInt16LE(26));
  for (const bytes of [ordinary, zip64, missing])
    archiveTest(bytes, (file) =>
      assert.throws(() => assertSafeRuntimeZip(file), /Malformed runtime ZIP/)
    );
});
test('Windows shared extraction rejects the link archive before invoking any extractor', () => {
  const source = fs.readFileSync(new URL('./runtime-payload-cache.mjs', import.meta.url), 'utf8');
  type Extract = (archive: string, destination: string, kind: string, run: () => void) => void;
  const extract = runInNewContext(
    source
      .slice(source.indexOf('function assertRegularArchiveEntries('))
      .replace('export function extractArchive', 'function extractArchive') + ';extractArchive',
    {
      fs,
      path,
      assertSafeRuntimeZip,
      process: { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } },
    }
  ) as Extract;
  archiveTest(
    zipFixture([
      { name: 'link', data: '../outside', symlink: true },
      { name: 'link/escape', data: 'forbidden' },
    ]),
    (file) => {
      const destination = path.join(path.dirname(file), 'extracted');
      let calls = 0;
      assert.throws(
        () =>
          extract(file, destination, 'zip', () => {
            calls++;
          }),
        /Unsupported runtime archive entry/
      );
      assert.equal(calls, 0, 'native extractor must never receive an unsafe archive');
    }
  );
});

test('rejects alternate native directories hidden in an EOCD comment or ZIP64 locator', () => {
  for (const kind of ['comment', 'locator'] as const)
    archiveTest(ambiguousDirectoryFixture(kind), (file) =>
      assert.throws(
        () => assertSafeRuntimeZip(file),
        /Malformed runtime ZIP|Unsupported runtime archive entry/
      )
    );
});
test('rejects local xl attributes and unknown extras before native extraction', () => {
  for (const bytes of [
    xlLinkFixture(),
    zipFixture([
      { name: 'runtime/file', data: 'retained', centralExtra: zipExtra(0x9999, Buffer.alloc(0)) },
    ]),
  ])
    archiveTest(bytes, (file) =>
      assert.throws(() => assertSafeRuntimeZip(file), /Unsupported runtime archive entry/)
    );
});
test('rejects unsupported compression methods and stored data descriptors', () => {
  const unsupported = zipFixture([{ name: 'runtime/file', data: 'retained' }]);
  unsupported.writeUInt16LE(9, 8);
  unsupported.writeUInt16LE(9, unsupported.readUInt32LE(unsupported.length - 6) + 10);
  const storedDescriptor = descriptorFixture(false, false);
  for (const bytes of [unsupported, storedDescriptor])
    archiveTest(bytes, (file) =>
      assert.throws(() => assertSafeRuntimeZip(file), /Unsupported runtime archive entry/)
    );
});
test('accepts coherent non-saturated ZIP64 footer and rejects contradictory classic fields', () => {
  const original = zipFixture([{ name: 'runtime/file', data: 'retained' }]);
  const end = original.length - 22;
  const footer = Buffer.from(original.subarray(end));
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50);
  locator.writeBigUInt64LE(BigInt(end), 8);
  locator.writeUInt32LE(1, 16);
  const bytes = Buffer.concat([
    original.subarray(0, end),
    zip64Footer(1, footer.readUInt32LE(12), footer.readUInt32LE(16)),
    locator,
    footer,
  ]);
  archiveTest(bytes, (file) => assertSafeRuntimeZip(file));
  bytes.writeUInt16LE(2, bytes.length - 12);
  bytes.writeUInt16LE(2, bytes.length - 14);
  archiveTest(bytes, (file) =>
    assert.throws(() => assertSafeRuntimeZip(file), /Malformed runtime ZIP/)
  );
});

test(
  'native libarchive selects hidden symlink records in rejected directory/type fixtures',
  { skip: process.platform !== 'darwin' && process.platform !== 'win32' },
  () => {
    const tar =
      process.platform === 'win32'
        ? path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
        : '/usr/bin/tar';
    for (const bytes of [
      ambiguousDirectoryFixture('comment'),
      ambiguousDirectoryFixture('locator'),
      xlLinkFixture(),
    ])
      archiveTest(bytes, (file) => {
        // Listing uses the real native archive reader without creating a link.
        const result = spawnSync(tar, ['-tvf', file], {
          encoding: 'utf8',
          shell: false,
          timeout: 30_000,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /link -> \.\.\/outside/);
        assert.doesNotMatch(result.stdout, /runtime\/safe/);
        assert.throws(
          () => assertSafeRuntimeZip(file),
          /Malformed runtime ZIP|Unsupported runtime archive entry/
        );
      });
  }
);

test('rejects central entry comments even without a second EOCD', () => {
  const original = zipFixture([{ name: 'runtime/file', data: 'retained' }]);
  const end = original.length - 22;
  const central = original.readUInt32LE(end + 16);
  const footer = Buffer.from(original.subarray(end));
  footer.writeUInt32LE(footer.readUInt32LE(12) + 1, 12);
  original.writeUInt16LE(1, central + 32);
  const bytes = Buffer.concat([original.subarray(0, end), Buffer.from('x'), footer]);
  archiveTest(bytes, (file) =>
    assert.throws(() => assertSafeRuntimeZip(file), /Malformed runtime ZIP/)
  );
});
