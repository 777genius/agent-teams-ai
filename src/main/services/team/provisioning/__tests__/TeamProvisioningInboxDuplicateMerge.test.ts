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

  it('keeps a duplicate containing malformed rows so they are not destroyed unmerged', async () => {
    const inboxDir = '/fake/team/inboxes';
    const reads = new Map<string, string>([
      [
        'Alice.json',
        JSON.stringify([{ messageId: 'a', timestamp: '2026-01-01T00:00:00.000Z', text: 'old' }]),
      ],
      ['Alice-2.json', JSON.stringify(['malformed row that must not be discarded'])],
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
    const writeFileUtf8 = vi.mocked(ports.writeFileUtf8);
    expect(JSON.parse(writeFileUtf8.mock.calls[0]?.[1] ?? '[]')).toEqual([
      { messageId: 'b', timestamp: '2026-01-03T00:00:00.000Z', text: 'new' },
      { messageId: 'a', timestamp: '2026-01-01T00:00:00.000Z', text: 'old' },
    ]);
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(unlink).toHaveBeenCalledWith(path.join(inboxDir, 'Alice-3.json'));
    expect(unlink).not.toHaveBeenCalledWith(path.join(inboxDir, 'Alice-2.json'));
  });

  it('keeps an id-less-only duplicate without rewriting the canonical inbox', async () => {
    const inboxDir = '/fake/team/inboxes';
    const reads = new Map<string, string>([
      [
        'Alice.json',
        JSON.stringify(
          [{ messageId: 'a', timestamp: '2026-01-01T00:00:00.000Z', text: 'canonical' }],
          null,
          2
        ),
      ],
      [
        'Alice-2.json',
        JSON.stringify([
          { timestamp: '2026-01-02T00:00:00.000Z', text: 'missing from' },
          { from: 'bob', timestamp: '2026-01-03T00:00:00.000Z' },
        ]),
      ],
    ]);
    const ports = createPorts({
      readDir: vi.fn(async () => ['Alice.json', 'Alice-2.json']),
      readRegularFileUtf8: vi.fn(async (filePath) => reads.get(path.basename(filePath)) ?? null),
    });

    await mergeAndRemoveDuplicateInboxes({
      inboxDir,
      baseNames: new Set(['Alice']),
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
      ports,
    });

    expect(ports.writeFileUtf8).not.toHaveBeenCalled();
    expect(ports.unlink).not.toHaveBeenCalled();
  });

  it('merges valid identities from mixed rows while preserving id-less and corrupt evidence', async () => {
    const inboxDir = '/fake/team/inboxes';
    const reads = new Map<string, string>([
      [
        'Alice.json',
        JSON.stringify([{ messageId: 'a', timestamp: '2026-01-01T00:00:00.000Z', text: 'old' }]),
      ],
      [
        'Alice-2.json',
        JSON.stringify([
          { messageId: 'b', timestamp: '2026-01-02T00:00:00.000Z', text: 'explicit id' },
          {
            from: 'bob',
            timestamp: '2026-01-03T00:00:00.000Z',
            text: 'legacy effective id',
          },
          { timestamp: '2026-01-04T00:00:00.000Z', text: 'unresolved id-less evidence' },
          'corrupt string evidence',
        ]),
      ],
    ]);
    const ports = createPorts({
      readDir: vi.fn(async () => ['Alice.json', 'Alice-2.json']),
      readRegularFileUtf8: vi.fn(async (filePath) => reads.get(path.basename(filePath)) ?? null),
    });

    await mergeAndRemoveDuplicateInboxes({
      inboxDir,
      baseNames: new Set(['Alice']),
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
      ports,
    });

    expect(ports.writeFileUtf8).toHaveBeenCalledTimes(1);
    const writeFileUtf8 = vi.mocked(ports.writeFileUtf8);
    expect(JSON.parse(writeFileUtf8.mock.calls[0]?.[1] ?? '[]')).toEqual([
      {
        from: 'bob',
        timestamp: '2026-01-03T00:00:00.000Z',
        text: 'legacy effective id',
      },
      { messageId: 'b', timestamp: '2026-01-02T00:00:00.000Z', text: 'explicit id' },
      { messageId: 'a', timestamp: '2026-01-01T00:00:00.000Z', text: 'old' },
    ]);
    expect(ports.unlink).not.toHaveBeenCalled();
  });

  it('does not grow or rewrite canonical inbox when a preserved mixed duplicate is merged repeatedly', async () => {
    const inboxDir = '/fake/team/inboxes';
    const files = new Map<string, string>([
      ['Alice.json', '[]'],
      [
        'Alice-2.json',
        JSON.stringify([
          { messageId: 'b', timestamp: '2026-01-02T00:00:00.000Z', text: 'merge once' },
          { timestamp: '2026-01-03T00:00:00.000Z', text: 'preserve without identity' },
          'preserve corrupt string',
        ]),
      ],
    ]);
    const writeFileUtf8 = vi.fn(async (filePath: string, contents: string) => {
      files.set(path.basename(filePath), contents);
    });
    const ports = createPorts({
      readDir: vi.fn(async () => [...files.keys()]),
      readRegularFileUtf8: vi.fn(
        async (filePath: string) => files.get(path.basename(filePath)) ?? null
      ),
      writeFileUtf8,
    });
    const input = {
      inboxDir,
      baseNames: new Set(['Alice']),
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
      ports,
    };

    await mergeAndRemoveDuplicateInboxes(input);
    const canonicalAfterFirstMerge = files.get('Alice.json');
    await mergeAndRemoveDuplicateInboxes(input);

    expect(JSON.parse(canonicalAfterFirstMerge ?? '[]')).toEqual([
      { messageId: 'b', timestamp: '2026-01-02T00:00:00.000Z', text: 'merge once' },
    ]);
    expect(files.get('Alice.json')).toBe(canonicalAfterFirstMerge);
    expect(files.has('Alice-2.json')).toBe(true);
    expect(writeFileUtf8).toHaveBeenCalledTimes(1);
    expect(ports.unlink).not.toHaveBeenCalled();
  });

  it('merges valid rows from a mixed duplicate, preserves corrupt data, and reclaims empty files idempotently', async () => {
    const inboxDir = '/fake/team/inboxes';
    const files = new Map<string, string>([
      [
        'Alice.json',
        JSON.stringify(
          [{ messageId: 'a', timestamp: '2026-01-01T00:00:00.000Z', text: 'old' }],
          null,
          2
        ),
      ],
      [
        'Alice-2.json',
        JSON.stringify([
          { messageId: 'b', timestamp: '2026-01-02T00:00:00.000Z', text: 'deliver me' },
          'corrupt row that cannot be represented in an inbox',
        ]),
      ],
      ['Alice-3.json', ''],
      ['Alice-4.json', ' \n\t '],
    ]);
    const writeFileUtf8 = vi.fn(async (filePath: string, contents: string) => {
      files.set(path.basename(filePath), contents);
    });
    const unlink = vi.fn(async (filePath: string) => {
      files.delete(path.basename(filePath));
    });
    const ports = createPorts({
      readDir: vi.fn(async () => [...files.keys()]),
      readRegularFileUtf8: vi.fn(
        async (filePath: string) => files.get(path.basename(filePath)) ?? null
      ),
      writeFileUtf8,
      unlink,
    });
    const input = {
      inboxDir,
      baseNames: new Set(['Alice']),
      timeoutMs: 5_000,
      maxBytes: 1_000_000,
      ports,
    };

    await mergeAndRemoveDuplicateInboxes(input);
    await mergeAndRemoveDuplicateInboxes(input);

    expect(JSON.parse(files.get('Alice.json') ?? '[]')).toEqual([
      { messageId: 'b', timestamp: '2026-01-02T00:00:00.000Z', text: 'deliver me' },
      { messageId: 'a', timestamp: '2026-01-01T00:00:00.000Z', text: 'old' },
    ]);
    expect(files.has('Alice-2.json')).toBe(true);
    expect(files.has('Alice-3.json')).toBe(false);
    expect(files.has('Alice-4.json')).toBe(false);
    expect(writeFileUtf8).toHaveBeenCalledTimes(1);
    expect(unlink).toHaveBeenCalledTimes(2);
  });

  it('produces the same canonical inbox regardless of duplicate directory order', async () => {
    const inboxDir = '/fake/team/inboxes';
    const rawFiles = new Map<string, string>([
      ['Alice.json', '[]'],
      [
        'Alice-2.json',
        JSON.stringify([
          { messageId: 'shared', timestamp: '2026-01-02T00:00:00.000Z', text: 'from two' },
        ]),
      ],
      [
        'Alice-10.json',
        JSON.stringify([
          { messageId: 'shared', timestamp: '2026-01-10T00:00:00.000Z', text: 'from ten' },
        ]),
      ],
    ]);
    const mergeWithOrder = async (entries: string[]): Promise<string> => {
      const writeFileUtf8 = vi.fn(async (_filePath: string, _contents: string) => undefined);
      const ports = createPorts({
        readDir: vi.fn(async () => entries),
        readRegularFileUtf8: vi.fn(
          async (filePath: string) => rawFiles.get(path.basename(filePath)) ?? null
        ),
        writeFileUtf8,
      });

      await mergeAndRemoveDuplicateInboxes({
        inboxDir,
        baseNames: new Set(['Alice']),
        timeoutMs: 5_000,
        maxBytes: 1_000_000,
        ports,
      });

      return vi.mocked(writeFileUtf8).mock.calls[0]?.[1] ?? '';
    };

    const forward = await mergeWithOrder(['Alice.json', 'Alice-2.json', 'Alice-10.json']);
    const reverse = await mergeWithOrder(['Alice-10.json', 'Alice.json', 'Alice-2.json']);

    expect(reverse).toBe(forward);
    expect(JSON.parse(forward)).toEqual([
      { messageId: 'shared', timestamp: '2026-01-02T00:00:00.000Z', text: 'from two' },
    ]);
  });
});
