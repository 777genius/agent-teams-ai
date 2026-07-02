import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  type DuplicateInboxMergePorts,
  mergeAndRemoveDuplicateInboxes,
} from '../TeamProvisioningInboxDuplicateMerge';

function createPorts(overrides: Partial<DuplicateInboxMergePorts> = {}): DuplicateInboxMergePorts {
  return {
    readDir: vi.fn(async () => []),
    readRegularFileUtf8: vi.fn(async () => '[]'),
    writeFileUtf8: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
    withCanonicalInboxLock: vi.fn(async (_filePath: string, fn: () => Promise<void>) => fn()),
    ...overrides,
  };
}

describe('TeamProvisioningInboxDuplicateMerge', () => {
  it('merges duplicate inbox files into the canonical inbox and removes duplicates', async () => {
    const inboxDir = '/fake/team/inboxes';
    const reads = new Map<string, string>([
      [
        'Alice.json',
        JSON.stringify([{ messageId: 'a', timestamp: '2026-01-01T00:00:00.000Z', text: 'old' }]),
      ],
      [
        'Alice-2.json',
        JSON.stringify([{ messageId: 'b', timestamp: '2026-01-03T00:00:00.000Z', text: 'new' }]),
      ],
      [
        'Alice-3.json',
        JSON.stringify([
          { messageId: 'a', timestamp: '2026-01-04T00:00:00.000Z', text: 'replacement' },
        ]),
      ],
    ]);
    const writeFileUtf8 = vi.fn(async () => undefined);
    const unlink = vi.fn(async () => undefined);
    const ports = createPorts({
      readDir: vi.fn(async () => ['Alice.json', 'Alice-2.json', 'Alice-3.json']),
      readRegularFileUtf8: vi.fn(async (filePath) => reads.get(path.basename(filePath)) ?? null),
      writeFileUtf8,
      unlink,
    });

    await mergeAndRemoveDuplicateInboxes({
      inboxDir,
      baseNames: new Set(['Alice']),
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
      ports,
    });

    expect(writeFileUtf8).toHaveBeenCalledTimes(1);
    const writeCalls = writeFileUtf8.mock.calls as unknown as Array<[string, string]>;
    expect(writeCalls[0]?.[0]).toBe(path.join(inboxDir, 'Alice.json'));
    expect(JSON.parse(writeCalls[0]?.[1] ?? '[]')).toEqual([
      { messageId: 'a', timestamp: '2026-01-04T00:00:00.000Z', text: 'replacement' },
      { messageId: 'b', timestamp: '2026-01-03T00:00:00.000Z', text: 'new' },
    ]);
    expect(unlink).toHaveBeenCalledWith(path.join(inboxDir, 'Alice-2.json'));
    expect(unlink).toHaveBeenCalledWith(path.join(inboxDir, 'Alice-3.json'));
  });

  it('does nothing when the inbox directory cannot be read', async () => {
    const ports = createPorts({
      readDir: vi.fn(async () => {
        throw new Error('missing');
      }),
    });

    await mergeAndRemoveDuplicateInboxes({
      inboxDir: '/fake/missing/inboxes',
      baseNames: new Set(['Alice']),
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
      ports,
    });

    expect(ports.writeFileUtf8).not.toHaveBeenCalled();
    expect(ports.unlink).not.toHaveBeenCalled();
  });

  it('does not remove duplicate files when canonical write fails', async () => {
    const ports = createPorts({
      readDir: vi.fn(async () => ['Alice.json', 'Alice-2.json']),
      readRegularFileUtf8: vi.fn(async () =>
        JSON.stringify([{ messageId: 'a', timestamp: '2026-01-01T00:00:00.000Z' }])
      ),
      writeFileUtf8: vi.fn(async () => {
        throw new Error('readonly');
      }),
    });

    await mergeAndRemoveDuplicateInboxes({
      inboxDir: '/fake/team/inboxes',
      baseNames: new Set(['Alice']),
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
      ports,
    });

    expect(ports.unlink).not.toHaveBeenCalled();
  });

  it('keeps an unreadable duplicate on disk so its messages are not destroyed unmerged', async () => {
    const inboxDir = '/fake/team/inboxes';
    const reads = new Map<string, string | null>([
      [
        'Alice.json',
        JSON.stringify([{ messageId: 'a', timestamp: '2026-01-01T00:00:00.000Z', text: 'old' }]),
      ],
      // Oversized or timed-out read: tryReadRegularFileUtf8 reports null.
      ['Alice-2.json', null],
      [
        'Alice-3.json',
        JSON.stringify([{ messageId: 'b', timestamp: '2026-01-03T00:00:00.000Z', text: 'new' }]),
      ],
    ]);
    const unlink = vi.fn(async () => undefined);
    const ports = createPorts({
      readDir: vi.fn(async () => ['Alice.json', 'Alice-2.json', 'Alice-3.json']),
      readRegularFileUtf8: vi.fn(async (filePath) => reads.get(path.basename(filePath)) ?? null),
      unlink,
    });

    await mergeAndRemoveDuplicateInboxes({
      inboxDir,
      baseNames: new Set(['Alice']),
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
      ports,
    });

    expect(ports.writeFileUtf8).toHaveBeenCalledTimes(1);
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(unlink).toHaveBeenCalledWith(path.join(inboxDir, 'Alice-3.json'));
  });
});
