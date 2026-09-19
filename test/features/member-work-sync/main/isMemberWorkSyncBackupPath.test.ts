import { isMemberWorkSyncBackupPath } from '@features/member-work-sync/main/infrastructure/isMemberWorkSyncBackupPath';
import { expect, it } from 'vitest';

it.each([
  '.member-work-sync/status.json',
  '.member-work-sync/sqlite-fallback-replica.json',
  'members/bob%20smith/.member-work-sync/status.json.pre-sqlite.1',
  'members\\bob\\.member-work-sync\\outbox.json',
])('owns safety path %s', (input) => { expect(isMemberWorkSyncBackupPath(input)).toBe(true); });
it.each(['config.json', 'members/bob/profile.json', 'other/.member-work-sync/status.json', 'members/bob/.member-work-sync-other/status.json'])('leaves unrelated path %s generic', (input) => { expect(isMemberWorkSyncBackupPath(input)).toBe(false); });
it.each(['../config.json', '/config.json', 'members/../.member-work-sync/status.json', 'C:\\config.json', 'members//bob', './config.json'])('rejects ambiguous path %s', (input) => { expect(() => isMemberWorkSyncBackupPath(input)).toThrow(); });
