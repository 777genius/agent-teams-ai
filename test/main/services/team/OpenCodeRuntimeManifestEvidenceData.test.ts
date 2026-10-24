import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readRuntimeStoreManifestEvidenceData } from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceData';
import { createDefaultRuntimeStoreManifest } from '../../../../src/main/services/team/opencode/store/RuntimeStoreManifest';
import { VersionedJsonStore } from '../../../../src/main/services/team/opencode/store/VersionedJsonStore';

const roots: string[] = [];
const clock = () => new Date('2026-10-02T00:00:00.000Z');
async function fixture(value: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'TEST-opencode-manifest-preservation-'));
  roots.push(root);
  const file = join(root, 'manifest.json');
  const raw = JSON.stringify(value);
  await writeFile(file, raw);
  return { root, file, raw };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OpenCode manifest preserve-only authority', () => {
  it.each([true, false])(
    'future envelope never supplies authority or invokes a writer, complete=%s',
    async (complete) => {
      const data = createDefaultRuntimeStoreManifest('TEST-team', clock().toISOString());
      const value = complete
        ? { schemaVersion: 2, updatedAt: clock().toISOString(), data }
        : { schemaVersion: 2, data };
      const { root, file, raw } = await fixture(value);
      await expect(
        readRuntimeStoreManifestEvidenceData(file, 'TEST-team', clock)
      ).rejects.toMatchObject({ reason: 'future_schema' });
      const store = new VersionedJsonStore({
        filePath: file,
        schemaVersion: 1,
        defaultData: () => data,
        validate: (value) => value,
        clock,
      });
      expect(await store.read()).toMatchObject({
        ok: false,
        reason: 'future_schema',
        quarantinePath: null,
      });
      const update = vi.fn(() => data);
      await expect(store.updateLocked(update)).rejects.toMatchObject({
        reason: 'future_schema',
        quarantinePath: null,
      });
      expect(update).not.toHaveBeenCalled();
      expect(await readFile(file, 'utf8')).toBe(raw);
      expect(await readdir(root)).toEqual(['manifest.json']);
    }
  );
  it('supported envelope and genuine bare V1 manifest retain identical authority', async () => {
    const data = createDefaultRuntimeStoreManifest('TEST-team', clock().toISOString());
    for (const value of [data, { schemaVersion: 1, updatedAt: clock().toISOString(), data }]) {
      const { root, file, raw } = await fixture(value);
      expect(await readRuntimeStoreManifestEvidenceData(file, 'TEST-team', clock)).toEqual(data);
      expect(await readFile(file, 'utf8')).toBe(raw);
      expect(await readdir(root)).toEqual(['manifest.json']);
    }
  });
  it.each([0, '1', null])(
    'invalid outer schema %s cannot be lifted into valid V1 authority',
    async (schemaVersion) => {
      const data = createDefaultRuntimeStoreManifest('TEST-team', clock().toISOString());
      const { file, raw } = await fixture({
        schemaVersion,
        updatedAt: clock().toISOString(),
        data,
      });
      await expect(
        readRuntimeStoreManifestEvidenceData(file, 'TEST-team', clock)
      ).rejects.toMatchObject({ reason: 'invalid_envelope' });
      expect(await readFile(file, 'utf8')).toBe(raw);
    }
  );
  it('fractional outer schema is invalid and cannot supply authority', async () => {
    const data = createDefaultRuntimeStoreManifest('TEST-team', clock().toISOString());
    const { root, file, raw } = await fixture({
      schemaVersion: 2.5,
      updatedAt: clock().toISOString(),
      data,
    });
    await expect(
      readRuntimeStoreManifestEvidenceData(file, 'TEST-team', clock)
    ).rejects.toMatchObject({
      reason: 'invalid_envelope',
    });
    const store = new VersionedJsonStore({
      filePath: file,
      schemaVersion: 1,
      defaultData: () => data,
      validate: (value) => value,
      clock,
    });
    const outcome = await store.read();
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_envelope' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('Invalid schema supplied authority');
    expect(outcome.quarantinePath).not.toBeNull();
    expect(await readFile(outcome.quarantinePath!, 'utf8')).toBe(raw);
    expect(await readFile(file, 'utf8')).toBe(raw);
    expect(await readdir(root)).toHaveLength(2);
  });
  it('missing is distinct from a present incomplete envelope', async () => {
    const data = createDefaultRuntimeStoreManifest('TEST-team', clock().toISOString());
    const { root, file, raw } = await fixture({ schemaVersion: 1, data });
    await expect(
      readRuntimeStoreManifestEvidenceData(file, 'TEST-team', clock)
    ).rejects.toMatchObject({ reason: 'invalid_envelope' });
    expect(
      await readRuntimeStoreManifestEvidenceData(join(root, 'missing.json'), 'TEST-team', clock)
    ).toEqual(data);
    expect(await readFile(file, 'utf8')).toBe(raw);
    expect(await readdir(root)).toEqual(['manifest.json']);
  });
});
