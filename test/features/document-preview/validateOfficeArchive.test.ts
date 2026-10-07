import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { validateOfficeArchive } from '../../../src/features/document-preview/main/infrastructure/validateOfficeArchive';

// Two directory entries can share a physical compressed stream even though their
// declared and actual output sizes are zero. Output caps cannot bound that work.
function twoEntryZip(sharedRange: boolean, compressed = deflateRawSync(Buffer.alloc(0))): Buffer {
  const localRecords: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (let index = 0; index < 2; index++) {
    const name = Buffer.from(String(index));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(sharedRange ? 0 : offset, 42);
    directory.push(central, name);
    if (!sharedRange || index === 0) {
      localRecords.push(local, name, compressed);
      offset += local.length + name.length + compressed.length;
    }
  }
  const data = Buffer.concat(localRecords);
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(2, 8);
  end.writeUInt16LE(2, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(data.length, 16);
  return Buffer.concat([data, central, end]);
}

describe('Office archive compressed work boundary', () => {
  it('accepts distinct physical compressed streams with empty output', async () => {
    await expect(validateOfficeArchive(twoEntryZip(false))).resolves.toBeUndefined();
  });

  it('rejects duplicate compressed ranges even when inflated output is empty', async () => {
    await expect(validateOfficeArchive(twoEntryZip(true))).rejects.toThrow('Overlapping');
  });

  it('rejects overlapping ranges before attempting decompression', async () => {
    await expect(validateOfficeArchive(twoEntryZip(true, Buffer.from([0xff])))).rejects.toThrow(
      'Overlapping'
    );
  });
});
