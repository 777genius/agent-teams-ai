import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';

import {
  assertOpenCodeV2DeliveryPath,
  parseOpenCodeV2DeliveryManifest,
  V2_DELIVERY_LIMITS,
} from '../../core/domain/v2Delivery';

import { assertSafeRuntimeZip } from './runtimeZip';

import type {
  OpenCodeV2DeliveryDescriptor,
  OpenCodeV2DeliveryManifest,
} from '../../core/domain/v2Delivery';
import type { ValidatedRuntimeZipRecord } from './runtimeZip';

async function boundedRead(file: string, bytes: number): Promise<Buffer> {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== bytes)
      throw new Error('OpenCode V2 support file size mismatch');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function readV2SupportManifest(
  root: string,
  descriptor: OpenCodeV2DeliveryDescriptor
): Promise<OpenCodeV2DeliveryManifest> {
  const file = path.join(root, descriptor.manifest.file);
  if (!(await fs.lstat(file)).isFile())
    throw new Error('OpenCode V2 support manifest is not a regular file');
  const bytes = await boundedRead(file, descriptor.manifest.bytes);
  if (createHash('sha256').update(bytes).digest('hex') !== descriptor.manifest.sha256)
    throw new Error('OpenCode V2 support manifest checksum mismatch');
  return parseOpenCodeV2DeliveryManifest(JSON.parse(bytes.toString('utf8')), descriptor);
}

/** Validate every ancestor inside the immutable instance before opening a file. */
export async function regularV2SupportFile(root: string, relative: string): Promise<string> {
  assertOpenCodeV2DeliveryPath(relative);
  const parts = relative.split('/');
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = await fs.lstat(current);
    if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())
      throw new Error('OpenCode V2 support contains a link or non-regular path');
  }
  return current;
}

async function verifyFile(file: string, bytes: number, sha256: string): Promise<void> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size !== bytes)
    throw new Error('OpenCode V2 support file size mismatch');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== sha256) throw new Error('OpenCode V2 support file checksum mismatch');
}

export async function verifyV2SupportFiles(
  root: string,
  manifest: OpenCodeV2DeliveryManifest
): Promise<void> {
  for (const row of manifest.files) {
    const file = await regularV2SupportFile(root, row.path);
    await verifyFile(file, row.bytes, row.sha256);
    if (
      process.platform !== 'win32' &&
      ((await fs.lstat(file)).mode & 0o777) !== (row.executable ? 0o755 : 0o644)
    )
      throw new Error('OpenCode V2 support executable mode mismatch');
  }
}

function entryStream(archive: string, entry: ValidatedRuntimeZipRecord): Readable {
  if (entry.compressedSize === 0) return Readable.from([]);
  return createReadStream(archive, {
    start: entry.dataOffset,
    end: entry.dataOffset + entry.compressedSize - 1,
  });
}

async function extractEntry(
  archive: string,
  entry: ValidatedRuntimeZipRecord,
  target: string
): Promise<void> {
  let bytes = 0;
  const bound = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(
        bytes > entry.size ? new Error('OpenCode V2 support ZIP expanded length mismatch') : null,
        chunk
      );
    },
  });
  const input = entryStream(archive, entry);
  const output = createWriteStream(target, { flags: 'wx', mode: 0o600 });
  if (entry.method === 8) await pipeline(input, createInflateRaw(), bound, output);
  else await pipeline(input, bound, output);
  if (bytes !== entry.size) throw new Error('OpenCode V2 support ZIP expanded length mismatch');
}

/** The shared ZIP validator authorizes offsets; only manifest-listed bytes reach disk. */
export async function extractV2SupportArchive(
  archive: string,
  root: string,
  descriptor: OpenCodeV2DeliveryDescriptor
): Promise<void> {
  const entries = assertSafeRuntimeZip(archive, {
    bytes: descriptor.archive.bytes,
    entries: descriptor.archive.entries,
    expandedBytes: descriptor.archive.expandedBytes,
    fileBytes: V2_DELIVERY_LIMITS.file,
  });
  if (
    (await fs.stat(archive)).size !== descriptor.archive.bytes ||
    entries.length !== descriptor.archive.entries ||
    entries.reduce((sum, row) => sum + row.size, 0) !== descriptor.archive.expandedBytes
  )
    throw new Error('OpenCode V2 support ZIP inventory mismatch');
  for (const entry of entries) {
    assertOpenCodeV2DeliveryPath(entry.directory ? entry.name.replace(/\/$/, '') : entry.name);
    if (
      (entry.directory &&
        (entry.size !== 0 ||
          (entry.name !== 'local-cli/' && !entry.name.startsWith('local-cli/')))) ||
      (!entry.directory &&
        entry.name !== descriptor.manifest.file &&
        !entry.name.startsWith('local-cli/'))
    )
      throw new Error('Unexpected OpenCode V2 support ZIP path');
  }
  const manifestEntry = entries.find(
    (entry) => entry.name === descriptor.manifest.file && !entry.directory
  );
  if (!manifestEntry || manifestEntry.size !== descriptor.manifest.bytes)
    throw new Error('OpenCode V2 support manifest missing');
  await extractEntry(archive, manifestEntry, path.join(root, descriptor.manifest.file));
  const manifest = await readV2SupportManifest(root, descriptor);
  const rows = new Map(manifest.files.map((row) => [row.path, row]));
  const files = entries.filter(
    (entry) => !entry.directory && entry.name !== descriptor.manifest.file
  );
  if (
    files.length !== rows.size ||
    files.some((entry) => rows.get(entry.name)?.bytes !== entry.size)
  )
    throw new Error('OpenCode V2 support ZIP differs from pinned manifest');
  for (const entry of files) {
    const row = rows.get(entry.name)!;
    const target = path.join(root, entry.name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await extractEntry(archive, entry, target);
    await verifyFile(target, row.bytes, row.sha256);
    if (process.platform !== 'win32') {
      // The pinned manifest supplies only normalized executable intent.
      // eslint-disable-next-line sonarjs/file-permissions -- verified runtime helpers require their declared execute bits
      await fs.chmod(target, row.executable ? 0o755 : 0o644);
    }
  }
  await fs.chmod(path.join(root, descriptor.manifest.file), 0o644);
  const graphPath = await regularV2SupportFile(root, 'local-cli/opencode-v2-graphs.json');
  const graphBytes = (await fs.stat(graphPath)).size;
  if (graphBytes > 64 * 1024) throw new Error('OpenCode V2 graph metadata is too large');
  const graphs = JSON.parse((await boundedRead(graphPath, graphBytes)).toString('utf8')) as {
    schema?: unknown;
    graphs?: { version?: unknown; server?: unknown }[];
  };
  if (
    graphs.schema !== 2 ||
    !Array.isArray(graphs.graphs) ||
    JSON.stringify(graphs.graphs.map((graph) => graph.version)) !==
      JSON.stringify(descriptor.engineVersions) ||
    graphs.graphs.some((graph) => graph.server !== `@opencode/server-v${graph.version}`)
  )
    throw new Error('OpenCode V2 graph qualification mismatch');
}

export async function downloadV2SupportArchive(
  url: string,
  destination: string,
  descriptor: OpenCodeV2DeliveryDescriptor,
  progress: (downloadedBytes: number, totalBytes: number) => void
): Promise<void> {
  const signal = AbortSignal.timeout(10 * 60_000);
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body)
    throw new Error(`OpenCode V2 support download failed (${response.status})`);
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) !== descriptor.archive.bytes) {
    await response.body.cancel();
    throw new Error('OpenCode V2 support archive length mismatch');
  }
  let bytes = 0;
  const hash = createHash('sha256');
  const body = response.body;
  const input = Readable.from(
    (async function* () {
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          bytes += value.byteLength;
          if (bytes > descriptor.archive.bytes)
            throw new Error('OpenCode V2 support archive exceeds pinned length');
          hash.update(value);
          progress(bytes, descriptor.archive.bytes);
          yield value;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    })()
  );
  await pipeline(input, createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
  if (bytes !== descriptor.archive.bytes || hash.digest('hex') !== descriptor.archive.sha256)
    throw new Error('OpenCode V2 support archive checksum mismatch');
}
