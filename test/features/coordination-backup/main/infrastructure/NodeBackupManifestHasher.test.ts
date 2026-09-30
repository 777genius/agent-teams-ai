import { createHash } from 'node:crypto';

import {
  canonicalBackupJson,
  CanonicalBackupJsonError,
  NodeBackupManifestHasher,
} from '@features/coordination-backup/main/infrastructure';
import { describe, expect, it } from 'vitest';

describe('NodeBackupManifestHasher', () => {
  it('recursively canonicalizes objects while retaining array order', () => {
    expect(canonicalBackupJson({ z: [{ beta: 2, alpha: 1 }], a: { d: true, c: null } })).toBe(
      '{"a":{"c":null,"d":true},"z":[{"alpha":1,"beta":2}]}'
    );
  });

  it('hashes the exact canonical UTF-8 bytes with SHA-256', async () => {
    const body = { z: 3, nested: { second: 'b', first: 'a' } };
    const expected = createHash('sha256')
      .update('{"nested":{"first":"a","second":"b"},"z":3}', 'utf8')
      .digest('hex');
    const hasher = new NodeBackupManifestHasher();

    await expect(hasher.hashCanonicalManifest(body as never)).resolves.toBe(expected);
  });

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    BigInt(1),
    Array(3),
    new Date('2026-01-01T00:00:00.000Z'),
  ])('rejects values outside the lossless JSON data model: %s', (value) => {
    expect(() => canonicalBackupJson(value)).toThrow(CanonicalBackupJsonError);
  });

  it('rejects cycles instead of partially serializing them', () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(() => canonicalBackupJson(value)).toThrow('coordination-backup-canonical-json-cycle');
  });

  it('rejects symbol, hidden, accessor, and array side-channel properties', () => {
    const symbolValue = { visible: true, [Symbol('hidden')]: true };
    const hiddenValue = { visible: true };
    Object.defineProperty(hiddenValue, 'hidden', { value: true });
    const accessorValue = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => true,
    });
    const extendedArray = [1] as number[] & { extra?: number };
    extendedArray.extra = 2;

    expect(() => canonicalBackupJson(symbolValue)).toThrow('symbol-key');
    expect(() => canonicalBackupJson(hiddenValue)).toThrow('non-enumerable-property');
    expect(() => canonicalBackupJson(accessorValue)).toThrow('object-accessor');
    expect(() => canonicalBackupJson(extendedArray)).toThrow('array-property');
  });
});
