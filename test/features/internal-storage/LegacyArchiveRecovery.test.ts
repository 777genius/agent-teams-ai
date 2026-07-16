import { ImportLegacyJsonStoreUseCase } from '@features/internal-storage/core/application/ImportLegacyJsonStoreUseCase';
import {
  archiveFileWithGenerations,
  TeamScopedLegacyJsonSource,
} from '@features/internal-storage/main/adapters/output/TeamScopedLegacyJsonSource';
import { access, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface TestRecord {
  id: string;
  value: string;
}

describe('legacy pre-sqlite archive recovery', () => {
  let root: string | null = null;

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = null;
    }
  });

  async function makeHarness() {
    root = await mkdtemp(join(tmpdir(), 'legacy-archive-recovery-'));
    const filePath = join(root, 'teams', 'demo', 'journal.json');
    await mkdir(dirname(filePath), { recursive: true });
    const source = new TeamScopedLegacyJsonSource<TestRecord>({
      getFilePath: () => filePath,
      parse: (raw) => JSON.parse(raw) as TestRecord[],
    });
    const readArchives = vi.spyOn(source, 'readArchives');
    const records: TestRecord[] = [];
    const imported = { value: false };
    return {
      filePath,
      records,
      imported,
      source,
      readArchives,
      makeImporter: () =>
        new ImportLegacyJsonStoreUseCase({
          storeId: 'test-journal',
          source,
          loadExisting: () => Promise.resolve([...records]),
          replaceAll: (_teamName, next) => {
            records.splice(0, records.length, ...next);
            return Promise.resolve();
          },
          recordIdentity: (record) => record.id,
          areEquivalent: (left, right) => JSON.stringify(left) === JSON.stringify(right),
          recordImport: () => {
            imported.value = true;
            return Promise.resolve();
          },
          hasRecordedImport: () => Promise.resolve(imported.value),
        }),
    };
  }

  it('overlays archive generations numerically without shrinking an earlier snapshot', async () => {
    const harness = await makeHarness();
    await writeFile(
      `${harness.filePath}.pre-sqlite`,
      JSON.stringify([
        { id: 'a', value: 'generation-1' },
        { id: 'b', value: 'generation-1' },
      ])
    );
    await writeFile(
      `${harness.filePath}.pre-sqlite-10`,
      JSON.stringify([
        { id: 'b', value: 'generation-10' },
        { id: 'd', value: 'generation-10' },
      ])
    );
    await writeFile(
      `${harness.filePath}.pre-sqlite-2`,
      JSON.stringify([
        { id: 'b', value: 'generation-2' },
        { id: 'c', value: 'generation-2' },
      ])
    );

    await harness.makeImporter().ensureImported('demo');

    expect(harness.records).toEqual([
      { id: 'a', value: 'generation-1' },
      { id: 'b', value: 'generation-10' },
      { id: 'c', value: 'generation-2' },
      { id: 'd', value: 'generation-10' },
    ]);
    expect(harness.imported.value).toBe(true);
  });

  it('skips a corrupt older generation and keeps the newest valid record', async () => {
    const harness = await makeHarness();
    await writeFile(`${harness.filePath}.pre-sqlite`, '{ not valid json');
    await writeFile(
      `${harness.filePath}.pre-sqlite-2`,
      JSON.stringify([
        { id: 'a', value: 'generation-2' },
        { id: 'b', value: 'generation-2' },
      ])
    );
    await writeFile(
      `${harness.filePath}.pre-sqlite-3`,
      JSON.stringify([{ id: 'a', value: 'generation-3' }])
    );

    await harness.makeImporter().ensureImported('demo');

    expect(harness.records).toEqual([
      { id: 'a', value: 'generation-3' },
      { id: 'b', value: 'generation-2' },
    ]);
    expect(harness.imported.value).toBe(true);
    expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain(
      'skipped unreadable legacy archive team=demo generation=1'
    );
    vi.mocked(console.warn).mockClear();
  });

  it('returns an empty archive snapshot deterministically when every generation is corrupt', async () => {
    const harness = await makeHarness();
    await writeFile(`${harness.filePath}.pre-sqlite`, '{ broken generation 1');
    await writeFile(`${harness.filePath}.pre-sqlite-2`, '{ broken generation 2');

    await expect(harness.source.readArchives('demo')).resolves.toEqual([]);
    await expect(harness.source.readArchives('demo')).resolves.toEqual([]);

    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(4);
    vi.mocked(console.warn).mockClear();
  });

  it('combines archived and still-live halves, then skips immutable replay after marking import', async () => {
    const harness = await makeHarness();
    await writeFile(
      `${harness.filePath}.pre-sqlite`,
      JSON.stringify([
        { id: 'a', value: 'archived' },
        { id: 'b', value: 'archived' },
      ])
    );
    await writeFile(
      harness.filePath,
      JSON.stringify([
        { id: 'b', value: 'live' },
        { id: 'c', value: 'live' },
      ])
    );

    await harness.makeImporter().ensureImported('demo');
    expect(harness.records).toEqual([
      { id: 'a', value: 'archived' },
      { id: 'b', value: 'live' },
      { id: 'c', value: 'live' },
    ]);

    harness.records[1] = { id: 'b', value: 'canonical-newer' };
    harness.readArchives.mockClear();
    await harness.makeImporter().ensureImported('demo');

    expect(harness.records[1]).toEqual({ id: 'b', value: 'canonical-newer' });
    expect(harness.readArchives).not.toHaveBeenCalled();
  });

  it('allocates the next numeric generation after the current maximum', async () => {
    const harness = await makeHarness();
    await writeFile(`${harness.filePath}.pre-sqlite`, '[]');
    await writeFile(`${harness.filePath}.pre-sqlite-10`, '[]');
    await writeFile(harness.filePath, '[]');

    await archiveFileWithGenerations(harness.filePath);

    await expect(access(`${harness.filePath}.pre-sqlite-11`)).resolves.toBeUndefined();
    await expect(access(`${harness.filePath}.pre-sqlite-2`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
