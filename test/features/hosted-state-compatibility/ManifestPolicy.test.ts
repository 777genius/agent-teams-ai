import {
  type BuiltArtifactStateManifest,
  inspectBuiltArtifactStateManifest,
} from '@features/hosted-state-compatibility';

import { artifactManifest, DIGEST_B } from './fixtures';

describe('built artifact state manifest policy', () => {
  it('materializes and freezes the immutable N+1 contract', () => {
    const input = artifactManifest();
    const inspection = inspectBuiltArtifactStateManifest(input);

    expect(inspection.status).toBe('valid');
    if (inspection.status !== 'valid') return;
    expect(inspection.manifest).toEqual(input);
    expect(inspection.manifest).not.toBe(input);
    expect(Object.isFrozen(inspection.manifest)).toBe(true);
    expect(Object.isFrozen(inspection.manifest.orderedMigrations)).toBe(true);
    expect(Object.isFrozen(inspection.manifest.orderedMigrations[0])).toBe(true);
  });

  it('accepts an N contract with no forward migrations', () => {
    const inspection = inspectBuiltArtifactStateManifest(
      artifactManifest({
        manifestId: 'hosted-state-n',
        artifactVersion: '1.0.0',
        hostedStateSchemaVersion: 1,
        minimumReadableHostedStateVersion: 1,
        orderedMigrations: [],
      })
    );

    expect(inspection).toMatchObject({ status: 'valid' });
  });

  it('accepts only a complete, ordered N through N+2 chain', () => {
    const inspection = inspectBuiltArtifactStateManifest(
      artifactManifest({
        hostedStateSchemaVersion: 3,
        orderedMigrations: [
          ...artifactManifest().orderedMigrations,
          {
            migrationId: 'hosted-state-2-to-3',
            fromVersion: 2,
            toVersion: 3,
            sha256: DIGEST_B,
            backupRequirement: 'none',
          },
        ],
      })
    );

    expect(inspection).toMatchObject({ status: 'valid' });
  });

  it.each([
    ['future manifest schema', { schemaVersion: 2 }],
    ['reversed version range', { minimumReadableHostedStateVersion: 3 }],
    ['missing migration', { orderedMigrations: [] }],
    [
      'non-adjacent migration',
      {
        orderedMigrations: [
          {
            ...artifactManifest().orderedMigrations[0],
            toVersion: 3,
          },
        ],
      },
    ],
    [
      'invalid checksum',
      {
        orderedMigrations: [
          {
            ...artifactManifest().orderedMigrations[0],
            sha256: 'not-a-checksum',
          },
        ],
      },
    ],
  ])('refuses %s', (_label, overrides) => {
    const inspection = inspectBuiltArtifactStateManifest({
      ...artifactManifest(),
      ...overrides,
    });

    expect(inspection.status).toBe('invalid');
  });

  it('refuses duplicate migration identities', () => {
    const first = artifactManifest().orderedMigrations[0];
    const inspection = inspectBuiltArtifactStateManifest(
      artifactManifest({
        hostedStateSchemaVersion: 3,
        orderedMigrations: [first, { ...first, fromVersion: 2, toVersion: 3 }],
      })
    );

    expect(inspection).toEqual({ status: 'invalid', reasons: ['migration_order_invalid'] });
  });

  it('refuses unknown same-schema fields and never invokes accessors', () => {
    let getterInvoked = false;
    const input = artifactManifest() as BuiltArtifactStateManifest & { unexpected?: string };
    Object.defineProperty(input, 'unexpected', {
      enumerable: true,
      get() {
        getterInvoked = true;
        return 'unsafe';
      },
    });

    const inspection = inspectBuiltArtifactStateManifest(input);

    expect(inspection).toMatchObject({ status: 'invalid' });
    expect(getterInvoked).toBe(false);
  });
});
