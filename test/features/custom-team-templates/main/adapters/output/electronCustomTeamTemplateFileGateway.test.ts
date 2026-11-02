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

import type { BoundedReadableFileHandle } from '@features/custom-team-templates/main/adapters/output/ElectronCustomTeamTemplateFileGateway';

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

function fakeHandle(options: {
  sizes: readonly number[];
  contents: Buffer;
}): BoundedReadableFileHandle {
  let statCall = 0;
  return {
    stat: vi.fn(async () => {
      const size = options.sizes[Math.min(statCall, options.sizes.length - 1)] ?? 0;
      statCall += 1;
      return { isFile: () => true, size };
    }),
    read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const slice = options.contents.subarray(position, position + length);
      slice.copy(buffer, offset);
      return { bytesRead: slice.length };
    }),
  };
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
      stat: vi.fn(async () => ({ isFile: () => false, size: 0 })),
      read: vi.fn(),
    };
    expect(await readBoundedUtf8FromFileHandle(handle, 1024)).toEqual({ status: 'notAFile' });
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
