import * as nodeFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { TeamAttachmentStore } from '@main/services/team/TeamAttachmentStore';
import { getAppDataPath, setAppDataBasePath } from '@main/utils/pathDecoder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AttachmentPayload } from '@shared/types';

const payload = (data: string, overrides: Partial<AttachmentPayload> = {}): AttachmentPayload => {
  const encodedData = overrides.data ?? Buffer.from(data).toString('base64');
  return {
    id: 'att-1',
    filename: 'image.png',
    mimeType: 'image/png',
    size: Buffer.byteLength(Buffer.from(encodedData, 'base64')),
    data: encodedData,
    ...overrides,
  };
};

describe('TeamAttachmentStore immutable native bundles', () => {
  let root = '';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-attachment-immutable-'));
    setAppDataBasePath(root);
  });

  afterEach(async () => {
    setAppDataBasePath(null);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('publishes complete metadata and allows identical retry to repair a missing artifact', async () => {
    const store = new TeamAttachmentStore();
    const request = payload('native-bytes');
    const saved = await store.saveNativeAttachments('team', 'message', [request]);
    expect(saved).toHaveLength(1);
    expect(saved[0].filePath).toContain('att-1--image.png');

    const indexPath = path.join(getAppDataPath(), 'attachments', 'team', 'message', '_index.json');
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8')) as Array<
      Record<string, unknown>
    >;
    expect(index[0]).toMatchObject({ nativeAttachmentDeliveryVersion: 1, size: 12 });

    await fs.unlink(saved[0].filePath!);
    await expect(store.saveNativeAttachments('team', 'message', [request])).resolves.toHaveLength(
      1
    );
    await expect(fs.readFile(saved[0].filePath!, 'utf8')).resolves.toBe('native-bytes');

    await fs.unlink(saved[0].filePath!);
    const repaired = await store.saveAttachments('team', 'message', [request]);
    expect(repaired.size).toBe(1);
    await expect(fs.readFile(saved[0].filePath!, 'utf8')).resolves.toBe('native-bytes');
  });

  it('rejects changed bytes without overwriting the immutable artifact', async () => {
    const store = new TeamAttachmentStore();
    const saved = await store.saveNativeAttachments('team', 'message', [payload('original')]);
    await fs.writeFile(saved[0].filePath!, 'changed');

    await expect(
      store.saveNativeAttachments('team', 'message', [payload('replacement')])
    ).rejects.toThrow(/conflict/i);
    await expect(fs.readFile(saved[0].filePath!, 'utf8')).resolves.toBe('changed');
  });

  it('prevents a later best-effort save from replacing a native-owned bundle', async () => {
    const store = new TeamAttachmentStore();
    const saved = await store.saveNativeAttachments('team', 'message', [payload('native')]);

    await expect(
      store.saveAttachments('team', 'message', [payload('legacy', { id: 'att-2' })])
    ).rejects.toThrow(/conflict/i);
    await expect(fs.readFile(saved[0].filePath!, 'utf8')).resolves.toBe('native');
  });

  it('preserves legacy Buffer.from base64 semantics outside native ownership', async () => {
    const store = new TeamAttachmentStore();
    const unpadded = Buffer.from('unpadded').toString('base64').replace(/=+$/, '');
    const spacedUnpadded = Buffer.from('spaced').toString('base64').replace(/=+$/, '');
    const spaced = `${spacedUnpadded.slice(0, 2)} \n${spacedUnpadded.slice(2)}`;
    await store.saveAttachments('team', 'legacy-message', [
      payload('', {
        id: 'empty',
        filename: 'empty.txt',
        mimeType: 'text/plain',
        size: 0,
        data: '',
      }),
      payload('unpadded', {
        id: 'unpadded',
        filename: 'unpadded.txt',
        mimeType: 'text/plain',
        data: unpadded,
      }),
      payload('spaced', {
        id: 'spaced',
        filename: 'spaced.txt',
        mimeType: 'text/plain',
        data: spaced,
      }),
    ]);

    const saved = await store.getAttachments('team', 'legacy-message');
    expect(
      saved.map((item) => ({
        id: item.id,
        data: Buffer.from(item.data, 'base64').toString('utf8'),
      }))
    ).toEqual([
      { id: 'empty', data: '' },
      { id: 'unpadded', data: 'unpadded' },
      { id: 'spaced', data: 'spaced' },
    ]);
    await expect(
      store.saveNativeAttachments('team', 'native-invalid', [payload('', { data: '' })])
    ).rejects.toThrow(/invalid attachment data/i);
    await expect(
      store.saveNativeAttachments('team', 'native-unpadded', [
        payload('unpadded', { data: unpadded }),
      ])
    ).rejects.toThrow(/invalid attachment data/i);
  });

  it('owns a complete pending bundle before partial artifacts and protects untouched originals', async () => {
    const store = new TeamAttachmentStore();
    const first = payload('original-first', {
      id: 'att-a',
      filename: 'first.png',
    });
    const second = payload('original-second', {
      id: 'att-b',
      filename: 'second.png',
    });
    const dir = path.join(getAppDataPath(), 'attachments', 'team', 'partial-message');
    const firstPath = path.join(dir, 'att-a--first.png');
    const secondPath = path.join(dir, 'att-b--second.png');
    const link = nodeFs.promises.link.bind(nodeFs.promises);
    const interrupted = vi
      .spyOn(nodeFs.promises, 'link')
      .mockImplementation(async (sourcePath, targetPath) => {
        if (targetPath === secondPath)
          throw Object.assign(new Error('No space at second artifact publication'), {
            code: 'ENOSPC',
          });
        return link(sourcePath, targetPath);
      });
    try {
      await expect(
        store.saveNativeAttachments('team', 'partial-message', [first, second])
      ).rejects.toMatchObject({ code: 'ENOSPC' });
    } finally {
      interrupted.mockRestore();
    }
    await expect(fs.readFile(firstPath, 'utf8')).resolves.toBe('original-first');
    await expect(fs.readFile(path.join(dir, '_index.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const pending = JSON.parse(
      await fs.readFile(path.join(dir, '_pending-native.json'), 'utf8')
    ) as { state: string; attachments: Array<Record<string, unknown>> };
    expect(pending.state).toBe('pending');
    expect(pending.attachments.map((item) => item.id)).toEqual(['att-a', 'att-b']);

    for (const changed of [
      [payload('changed-first', { id: 'att-a', filename: 'renamed.png' }), second],
      [first, { ...second, mimeType: 'image/jpeg' }],
      [second, first],
      [first],
    ]) {
      await expect(store.saveNativeAttachments('team', 'partial-message', changed)).rejects.toThrow(
        /conflict/i
      );
      await expect(fs.readFile(firstPath, 'utf8')).resolves.toBe('original-first');
    }
    await expect(
      store.saveAttachments('team', 'partial-message', [
        payload('legacy-replacement', { id: 'att-a', filename: 'first.png' }),
      ])
    ).rejects.toThrow(/conflict/i);
    await expect(fs.readFile(firstPath, 'utf8')).resolves.toBe('original-first');

    await expect(
      store.saveNativeAttachments('team', 'partial-message', [first, second])
    ).resolves.toHaveLength(2);
    await expect(fs.readFile(firstPath, 'utf8')).resolves.toBe('original-first');
    await expect(fs.readFile(secondPath, 'utf8')).resolves.toBe('original-second');
    const index = JSON.parse(await fs.readFile(path.join(dir, '_index.json'), 'utf8')) as unknown[];
    expect(index).toHaveLength(2);
  });
  it('rejects managed descendant and artifact symlinks without touching their targets', async () => {
    const store = new TeamAttachmentStore();
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.mkdir(path.join(getAppDataPath(), 'attachments'), { recursive: true });
    await fs.symlink(outside, path.join(getAppDataPath(), 'attachments', 'team'), 'dir');
    await expect(
      store.saveNativeAttachments('team', 'message', [payload('bytes')])
    ).rejects.toThrow(/symlink/);
    expect(await fs.readdir(outside)).toEqual([]);
    await fs.unlink(path.join(getAppDataPath(), 'attachments', 'team'));
    const saved = await store.saveNativeAttachments('team', 'message', [payload('bytes')]);
    const target = path.join(outside, 'target');
    await fs.writeFile(target, 'bytes');
    await fs.unlink(saved[0].filePath);
    await fs.symlink(target, saved[0].filePath);
    await expect(
      store.saveNativeAttachments('team', 'message', [payload('bytes')])
    ).rejects.toThrow(/regular file/);
    expect(await fs.readFile(target, 'utf8')).toBe('bytes');
  });
});
