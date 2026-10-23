import { Buffer } from 'node:buffer';
import { deflateRawSync } from 'node:zlib';

type Entry = {
  name: string;
  data: string | Buffer;
  symlink?: boolean;
  directory?: boolean;
  deflate?: boolean;
  localExtra?: Buffer;
  centralExtra?: Buffer;
};

// Minimal stored ZIP fixtures, including Unix link metadata. No archive utility
// participates in fixture creation, so qualification exercises only the extractor.
export function zipFixture(entries: Entry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const packed = entry.deflate ? deflateRawSync(data) : data;
    const localExtra = entry.localExtra ?? Buffer.alloc(0);
    const centralExtra = entry.centralExtra ?? Buffer.alloc(0);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt32LE(crc, 14);
    header.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(localExtra.length, 28);
    local.push(header, name, localExtra, packed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(0x0314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt32LE(crc, 16);
    record.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    record.writeUInt32LE(packed.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(centralExtra.length, 30);
    record.writeUInt32LE(
      ((entry.symlink ? 0xa1ff : entry.directory ? 0x41ed : 0x81a4) << 16) >>> 0,
      38
    );
    record.writeUInt32LE(offset, 42);
    central.push(record, name, centralExtra);
    offset += header.length + name.length + localExtra.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export function zipExtra(id: number, data: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id);
  header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
}
export function xlLinkFixture(): Buffer {
  const attributes = Buffer.alloc(7);
  attributes[0] = 5; // version-made-by and external attributes
  attributes.writeUInt16LE(0x0314, 1);
  attributes.writeUInt32LE(0xa1ff0000, 3);
  return zipFixture([
    { name: 'link', data: '../outside', directory: true, localExtra: zipExtra(0x6c78, attributes) },
    { name: 'link/escape', data: 'forbidden' },
  ]);
}
export function zip64Footer(count: number, size: number, offset: number): Buffer {
  const footer = Buffer.alloc(56);
  footer.writeUInt32LE(0x06064b50);
  footer.writeBigUInt64LE(44n, 4);
  footer.writeUInt16LE(45, 12);
  footer.writeUInt16LE(45, 14);
  footer.writeBigUInt64LE(BigInt(count), 24);
  footer.writeBigUInt64LE(BigInt(count), 32);
  footer.writeBigUInt64LE(BigInt(size), 40);
  footer.writeBigUInt64LE(BigInt(offset), 48);
  return footer;
}
// Both alternate directories expose local records inside an otherwise safe
// stored entry. The native seeking reader selects those hidden records.
export function ambiguousDirectoryFixture(kind: 'comment' | 'locator'): Buffer {
  const hidden = zipFixture([
    { name: 'link', data: '../outside', symlink: true },
    { name: 'link/escape', data: 'forbidden' },
  ]);
  const hiddenEnd = hidden.length - 22;
  const hiddenOffset = hidden.readUInt32LE(hiddenEnd + 16);
  const bodyOffset = 30 + Buffer.byteLength('runtime/safe');
  const hiddenCentral = Buffer.from(hidden.subarray(hiddenOffset, hiddenEnd));
  for (let cursor = 0; cursor < hiddenCentral.length; ) {
    hiddenCentral.writeUInt32LE(hiddenCentral.readUInt32LE(cursor + 42) + bodyOffset, cursor + 42);
    cursor += 46 + hiddenCentral.readUInt16LE(cursor + 28);
  }
  if (kind === 'comment') {
    const outer = zipFixture([{ name: 'runtime/safe', data: hidden.subarray(0, hiddenOffset) }]);
    const footer = Buffer.from(hidden.subarray(hiddenEnd));
    const commentOffset = outer.length;
    footer.writeUInt32LE(commentOffset, 16);
    footer.writeUInt16LE(1, 20); // deliberately not an EOF-matching EOCD
    outer.writeUInt16LE(hiddenCentral.length + footer.length, outer.length - 2);
    return Buffer.concat([outer, hiddenCentral, footer]);
  }
  const zip64Offset = bodyOffset + hiddenOffset + hiddenCentral.length;
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50);
  locator.writeBigUInt64LE(BigInt(zip64Offset), 8);
  locator.writeUInt32LE(1, 16);
  return zipFixture([
    {
      name: 'runtime/safe',
      data: Buffer.concat([
        hidden.subarray(0, hiddenOffset),
        hiddenCentral,
        zip64Footer(2, hiddenCentral.length, bodyOffset + hiddenOffset),
      ]),
      // NTFS is qualified metadata, so rejection must come from the locator
      // validation rather than the unknown-extra allowlist.
      centralExtra: zipExtra(0x000a, locator),
    },
  ]);
}
