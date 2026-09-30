import {
  BACKUP_COMMIT_MARKER_FILE,
  BACKUP_ROOT_MANIFEST_FILE,
  BACKUP_STAGE_OWNER_FILE,
  validateArtifactEntryId,
} from '@features/coordination-backup/main/infrastructure';
import { describe, expect, it } from 'vitest';

describe('backup artifact path layout', () => {
  it.each([BACKUP_STAGE_OWNER_FILE, BACKUP_ROOT_MANIFEST_FILE, BACKUP_COMMIT_MARKER_FILE])(
    'rejects reserved metadata name as the first path segment: %s',
    (reservedName) => {
      expect(() => validateArtifactEntryId(`${reservedName}/nested`)).toThrow(
        'coordination-backup-artifact-entry-id-reserved'
      );
    }
  );

  it('keeps ordinary nested artifact IDs valid', () => {
    expect(validateArtifactEntryId('sqlite/internal-storage.sqlite')).toEqual([
      'sqlite',
      'internal-storage.sqlite',
    ]);
  });
});
