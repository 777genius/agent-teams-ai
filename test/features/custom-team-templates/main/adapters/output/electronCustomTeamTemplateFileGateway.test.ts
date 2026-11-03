import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
}));

import {
  ElectronCustomTeamTemplateFileGateway,
  readBoundedUtf8FromFileHandle,
} from '@features/custom-team-templates/main/adapters/output/ElectronCustomTeamTemplateFileGateway';
import { dialog } from 'electron';

import type {
  BoundedFileHandleStat,
  BoundedReadableFileHandle,
} from '@features/custom-team-templates/main/adapters/output/ElectronCustomTeamTemplateFileGateway';

const dialogMock = dialog as unknown as {
  showOpenDialog: ReturnType<typeof vi.fn>;
  showSaveDialog: ReturnType<typeof vi.fn>;
};

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'custom-template-file-'));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/**
 * Builds one `stat({ bigint: true })` snapshot.
 *
 * Production always requests bigint stats, so the doubly used helpers model
 * exact byte counts and nanosecond timestamps instead of rounded doubles.
 */
function statSnapshot(input: {
  size: number;
  dev?: number;
  ino?: number;
  mtimeNs?: bigint;
  ctimeNs?: bigint;
}): BoundedFileHandleStat {
  return {
    isFile: () => true,
    size: BigInt(input.size),
    ...(input.dev === undefined ? {} : { dev: BigInt(input.dev) }),
    ...(input.ino === undefined ? {} : { ino: BigInt(input.ino) }),
    ...(input.mtimeNs === undefined ? {} : { mtimeNs: input.mtimeNs }),
    ...(input.ctimeNs === undefined ? {} : { ctimeNs: input.ctimeNs }),
  };
}

/** A stable metadata snapshot for `size` bytes of an unchanged file. */
function stableStat(size: number) {
  return statSnapshot({ size, dev: 1, ino: 2, mtimeNs: 1_000n, ctimeNs: 1_000n });
}

interface FakeHandleOptions {
  /** Sequential snapshots; the last one repeats for any further call. */
  snapshots: readonly BoundedFileHandleStat[];
  contents: Buffer;
  /** Bytes returned by each successive read call; the last value repeats. */
  chunks?: readonly number[];
  readError?: Error;
  statError?: Error;
}

/**
 * Fake handle that can return short reads, fail, or report mutating metadata,
 * mirroring the parts of `FileHandle` the bounded reader depends on.
 */
function fakeStatHandle(options: FakeHandleOptions): BoundedReadableFileHandle {
  let statCall = 0;
  let readCall = 0;
  return {
    stat: vi.fn(async () => {
      if (options.statError) throw options.statError;
      const snapshot =
        options.snapshots[Math.min(statCall, options.snapshots.length - 1)] ??
        statSnapshot({ size: 0 });
      statCall += 1;
      return snapshot;
    }),
    read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      if (options.readError) throw options.readError;
      const requested =
        options.chunks === undefined
          ? length
          : (options.chunks[Math.min(readCall, options.chunks.length - 1)] ?? length);
      readCall += 1;
      const available = Math.max(0, options.contents.length - position);
      const bytesToCopy = Math.min(requested, length, available);
      if (bytesToCopy <= 0) {
        return { bytesRead: 0 };
      }
      options.contents.copy(buffer, offset, position, position + bytesToCopy);
      return { bytesRead: bytesToCopy };
    }),
  };
}

/** Convenience wrapper for the common "size changed between two stats" case. */
function fakeHandle(options: { sizes: readonly number[]; contents: Buffer }) {
  return fakeStatHandle({
    snapshots: options.sizes.map((size) => stableStat(size)),
    contents: options.contents,
  });
}

describe('readBoundedUtf8FromFileHandle', () => {
  it('decodes a valid UTF-8 file and drops the BOM', async () => {
    const contents = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":"✅"}')]);
    const result = await readBoundedUtf8FromFileHandle(
      fakeHandle({ sizes: [contents.length], contents }),
      1024
    );

    expect(result).toEqual({ status: 'ok', contents: '{"a":"✅"}' });
  });

  it('rejects content above the ceiling before reading it', async () => {
    const result = await readBoundedUtf8FromFileHandle(
      fakeHandle({ sizes: [100], contents: Buffer.alloc(100) }),
      10
    );

    expect(result).toEqual({ status: 'tooLarge', maxBytes: 10 });
  });

  it('detects growth between the size check and the read', async () => {
    const result = await readBoundedUtf8FromFileHandle(
      fakeHandle({ sizes: [4], contents: Buffer.from('abcdefgh') }),
      1024
    );

    expect(result).toEqual({ status: 'changedDuringRead' });
  });

  it('detects a size change after the read even when the read looked complete', async () => {
    const result = await readBoundedUtf8FromFileHandle(
      fakeHandle({ sizes: [4, 8], contents: Buffer.from('abcd') }),
      1024
    );

    expect(result).toEqual({ status: 'changedDuringRead' });
  });

  it('rejects invalid UTF-8 bytes', async () => {
    const result = await readBoundedUtf8FromFileHandle(
      fakeHandle({ sizes: [2], contents: Buffer.from([0xc3, 0x28]) }),
      1024
    );

    expect(result).toEqual({ status: 'invalidEncoding' });
  });

  it('rejects a handle that is not a regular file', async () => {
    const handle: BoundedReadableFileHandle = {
      stat: vi.fn(async () => ({ ...statSnapshot({ size: 0 }), isFile: () => false })),
      read: vi.fn(),
    };
    expect(await readBoundedUtf8FromFileHandle(handle, 1024)).toEqual({ status: 'notAFile' });
  });

  it('loops over short reads until the bounded buffer is complete', async () => {
    const json = '{"name":"تیم محصول","members":[]}';
    const contents = Buffer.from(json, 'utf8');
    const handle = fakeStatHandle({
      snapshots: [stableStat(contents.length)],
      contents,
      chunks: [2, 3],
    });

    const result = await readBoundedUtf8FromFileHandle(handle, 1024);

    expect(result).toEqual({ status: 'ok', contents: json });
    expect(JSON.parse(json)).toEqual({ name: 'تیم محصول', members: [] });
    // 2 bytes + 3 bytes + the remaining bytes + the final zero-byte read that
    // proves EOF was reached before the detection byte.
    expect((handle.read as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('reports a change when EOF arrives before the expected size (file shrank)', async () => {
    const handle = fakeStatHandle({
      snapshots: [stableStat(10)],
      contents: Buffer.from('{"a":1}', 'utf8'),
    });

    expect(await readBoundedUtf8FromFileHandle(handle, 1024)).toEqual({
      status: 'changedDuringRead',
    });
  });

  it('reports a change when a read returns zero bytes before the expected size', async () => {
    const handle = fakeStatHandle({
      snapshots: [stableStat(8)],
      contents: Buffer.from('{"a":1}', 'utf8'),
      chunks: [2, 0],
    });

    expect(await readBoundedUtf8FromFileHandle(handle, 1024)).toEqual({
      status: 'changedDuringRead',
    });
  });

  it('accepts a file of exactly the maximum size', async () => {
    const contents = Buffer.from('{"a":1}', 'utf8');
    const result = await readBoundedUtf8FromFileHandle(
      fakeHandle({ sizes: [contents.length], contents }),
      contents.length
    );

    expect(result).toEqual({ status: 'ok', contents: '{"a":1}' });
  });

  it('rejects a file of maximum size plus one even before reading', async () => {
    const contents = Buffer.from('{"a":12}', 'utf8');
    const result = await readBoundedUtf8FromFileHandle(
      fakeHandle({ sizes: [contents.length], contents }),
      contents.length - 1
    );

    expect(result).toEqual({ status: 'tooLarge', maxBytes: contents.length - 1 });
  });

  it('rejects a file that grows past the ceiling during the read', async () => {
    const contents = Buffer.from('abcdef', 'utf8');
    const handle = fakeStatHandle({
      snapshots: [stableStat(contents.length - 1)],
      contents,
    });

    expect(await readBoundedUtf8FromFileHandle(handle, contents.length - 1)).toEqual({
      status: 'tooLarge',
      maxBytes: contents.length - 1,
    });
  });

  it('propagates a read failure instead of returning partial content', async () => {
    const handle = fakeStatHandle({
      snapshots: [stableStat(4)],
      contents: Buffer.from('{"a":1}', 'utf8'),
      readError: new Error('EIO: i/o error'),
    });

    await expect(readBoundedUtf8FromFileHandle(handle, 1024)).rejects.toThrow('EIO');
  });

  it('detects a same-size rewrite through changed modification metadata', async () => {
    const contents = Buffer.from('{"a":1}', 'utf8');
    const handle = fakeStatHandle({
      snapshots: [
        statSnapshot({ size: contents.length, dev: 1, ino: 2, mtimeNs: 1_000n, ctimeNs: 1_000n }),
        statSnapshot({ size: contents.length, dev: 1, ino: 2, mtimeNs: 1_500n, ctimeNs: 1_500n }),
      ],
      contents,
    });

    expect(await readBoundedUtf8FromFileHandle(handle, 1024)).toEqual({
      status: 'changedDuringRead',
    });
  });

  it('detects a replaced file of the same size through its identity', async () => {
    const contents = Buffer.from('{"a":1}', 'utf8');
    const handle = fakeStatHandle({
      snapshots: [
        statSnapshot({ size: contents.length, dev: 1, ino: 2, mtimeNs: 1_000n, ctimeNs: 1_000n }),
        statSnapshot({ size: contents.length, dev: 1, ino: 3, mtimeNs: 1_000n, ctimeNs: 1_000n }),
      ],
      contents,
    });

    expect(await readBoundedUtf8FromFileHandle(handle, 1024)).toEqual({
      status: 'changedDuringRead',
    });
  });

  it('detects a change when the read was short and the metadata also moved', async () => {
    const contents = Buffer.from('{"a":1}', 'utf8');
    const handle = fakeStatHandle({
      snapshots: [
        statSnapshot({ size: contents.length, dev: 1, ino: 2, mtimeNs: 1_000n, ctimeNs: 1_000n }),
        statSnapshot({ size: contents.length, dev: 1, ino: 2, mtimeNs: 2_000n, ctimeNs: 2_000n }),
      ],
      contents,
      chunks: [3],
    });

    expect(await readBoundedUtf8FromFileHandle(handle, 1024)).toEqual({
      status: 'changedDuringRead',
    });
  });

  it('still returns complete content when only the size is reported', async () => {
    // Documented degradation: a platform that reports no dev/ino/timestamps can
    // only support size-based change detection, so a stable size is accepted.
    const contents = Buffer.from('{"a":1}', 'utf8');
    const handle = fakeStatHandle({
      snapshots: [statSnapshot({ size: contents.length }), statSnapshot({ size: contents.length })],
      contents,
    });

    expect(await readBoundedUtf8FromFileHandle(handle, 1024)).toEqual({
      status: 'ok',
      contents: '{"a":1}',
    });
  });

  it('still detects a size change when no other metadata is reported', async () => {
    const contents = Buffer.from('{"a":1}', 'utf8');
    const handle = fakeStatHandle({
      snapshots: [
        statSnapshot({ size: contents.length }),
        statSnapshot({ size: contents.length + 1 }),
      ],
      contents,
    });

    expect(await readBoundedUtf8FromFileHandle(handle, 1024)).toEqual({
      status: 'changedDuringRead',
    });
  });
});

describe('ElectronCustomTeamTemplateFileGateway', () => {
  const gateway = new ElectronCustomTeamTemplateFileGateway();

  it('opens a JSON-filtered import picker and returns the selected path', async () => {
    dialogMock.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [path.join(workDir, 'template.json')],
    });

    const selected = await gateway.pickImportFile();

    expect(selected).toBe(path.join(workDir, 'template.json'));
    const options = dialogMock.showOpenDialog.mock.calls[0]?.[0] as {
      properties: string[];
      filters: { extensions: string[] }[];
    };
    expect(options.properties).toEqual(['openFile']);
    expect(options.filters[0]?.extensions).toEqual(['json']);
  });

  it('returns null when the import picker is cancelled', async () => {
    dialogMock.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await gateway.pickImportFile()).toBeNull();
  });

  it('suggests a safe basename in the save dialog and returns null on cancel', async () => {
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/out.json' });
    expect(await gateway.pickExportDestination('Release Pipeline.json')).toBe('/tmp/out.json');
    expect(
      (dialogMock.showSaveDialog.mock.calls[0]?.[0] as { defaultPath: string }).defaultPath
    ).toBe('Release Pipeline.json');

    dialogMock.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });
    expect(await gateway.pickExportDestination('x.json')).toBeNull();
  });

  it('reads a real UTF-8 file and rejects an oversized one', async () => {
    const filePath = path.join(workDir, 'template.json');
    await writeFile(filePath, '{"name":"تیم"}', 'utf8');

    expect(await gateway.readUtf8File(filePath, 1024)).toEqual({
      status: 'ok',
      contents: '{"name":"تیم"}',
    });
    expect(await gateway.readUtf8File(filePath, 4)).toEqual({ status: 'tooLarge', maxBytes: 4 });
  });

  it('maps unreadable paths to a typed read failure', async () => {
    expect(await gateway.readUtf8File(path.join(workDir, 'missing.json'), 1024)).toEqual({
      status: 'readFailed',
    });
  });

  it('writes atomically without leaving a temporary file behind', async () => {
    const filePath = path.join(workDir, 'out.json');
    await gateway.writeFileAtomically(filePath, '{"ok":true}\n');

    expect(await readFile(filePath, 'utf8')).toBe('{"ok":true}\n');
    const entries = await readdir(workDir);
    expect(entries).toEqual(['out.json']);
  });

  it('leaves no partial final file and no temporary file when the rename fails', async () => {
    const destinationDirectory = path.join(workDir, 'out.json');
    await mkdir(destinationDirectory);

    await expect(gateway.writeFileAtomically(destinationDirectory, '{"x":1}')).rejects.toThrow();

    const entries = await readdir(workDir);
    expect(entries).toEqual(['out.json']);
    expect(entries.some((entry) => entry.endsWith('.tmp'))).toBe(false);
  });

  it('rejects when the destination directory does not exist', async () => {
    await expect(
      gateway.writeFileAtomically(path.join(workDir, 'missing', 'out.json'), '{}')
    ).rejects.toThrow();
  });
});
