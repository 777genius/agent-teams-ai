import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface Entry {
  files?: Record<string, Entry>;
  offset?: string;
  size?: number;
  unpacked?: boolean;
}

// Read the immutable archive; never extract or replace the running application.
export async function readAsar(file: string, names: string[]): Promise<Map<string, Buffer>> {
  const handle = await open(file, 'r');
  try {
    const prefix = Buffer.alloc(16);
    assert.equal((await handle.read(prefix, 0, 16, 0)).bytesRead, 16);
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    assert(headerSize >= jsonSize && headerSize < 16_000_000, 'Invalid ASAR header');
    const header = Buffer.alloc(jsonSize);
    assert.equal((await handle.read(header, 0, jsonSize, 16)).bytesRead, jsonSize);
    const tree = JSON.parse(header.toString()) as Entry;
    const result = new Map<string, Buffer>();
    for (const name of names) {
      let entry: Entry | undefined = tree;
      for (const component of name.split('/')) entry = entry?.files?.[component];
      assert(entry && !entry.unpacked && typeof entry.offset === 'string', `Missing packed ${name}`);
      const offset = Number(entry.offset);
      const size = entry.size;
      assert(Number.isSafeInteger(offset) && offset >= 0 && typeof size === 'number' && size < 30_000_000);
      const data = Buffer.alloc(size);
      assert.equal((await handle.read(data, 0, size, 8 + headerSize + offset)).bytesRead, size);
      result.set(name, data);
    }
    return result;
  } finally {
    await handle.close();
  }
}

export const predecessorSources = [
  'package.json',
  'dist-electron/main/index.cjs',
  'node_modules/electron-updater/package.json',
  'node_modules/electron-updater/out/main.js',
  'node_modules/electron-updater/out/electronHttpExecutor.js',
  'node_modules/electron-updater/out/AppUpdater.js',
  'node_modules/electron-updater/out/BaseUpdater.js',
  'node_modules/electron-updater/out/providers/Provider.js',
  'node_modules/electron-updater/out/providers/GitHubProvider.js',
  'node_modules/electron-updater/out/AppImageUpdater.js',
  'node_modules/electron-updater/out/DebUpdater.js',
  'node_modules/electron-updater/out/RpmUpdater.js',
  'node_modules/electron-updater/out/PacmanUpdater.js',
];

export async function captureSources(asar: string, output: string) {
  const sources = await readAsar(asar, predecessorSources);
  const ledger = [];
  for (const [name, data] of sources) {
    const destination = path.join(output, name.replaceAll('/', '__'));
    await writeFile(destination, data);
    ledger.push({ source: name, sha256: createHash('sha256').update(data).digest('hex'), size: data.length });
  }
  return ledger;
}

// Wire format and option index from electron/fuses. No writes or fuse changes.
export async function readInspectorFuse(executable: string) {
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const handle = await open(executable, 'r');
  try {
    const bytes = Buffer.alloc(1_048_576 + sentinel.length + 257);
    for (let offset = 0; ; offset += 1_048_576) {
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
      if (!bytesRead) throw new Error('Electron fuse sentinel missing');
      const index = bytes.subarray(0, bytesRead).indexOf(sentinel);
      if (index < 0 || index >= 1_048_576) continue;
      const wire = bytes.subarray(index + sentinel.length, bytesRead);
      assert(wire.length >= 2, 'Truncated Electron fuse header');
      const wireVersion = wire.readUInt8(0);
      const wireLength = wire.readUInt8(1);
      assert.equal(wireVersion, 1, 'Unsupported fuse wire version');
      assert(wireLength > 3 && wire.length >= 2 + wireLength, 'Truncated or short Electron fuse wire');
      assert.equal(wire.readUInt8(5), 49, 'EnableNodeCliInspectArguments is disabled: native gate unmet');
      return { offset: offset + index, version: wireVersion, states: [...wire.subarray(2, 2 + wireLength)] };
    }
  } finally {
    await handle.close();
  }
}
