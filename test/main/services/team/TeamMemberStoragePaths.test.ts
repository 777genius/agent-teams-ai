import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  encodeTeamMemberStorageKey,
  TeamMemberStoragePaths,
} from '@main/services/team/TeamMemberStoragePaths';

describe('TeamMemberStoragePaths', () => {
  let root: string;
  let paths: TeamMemberStoragePaths;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'team-member-storage-paths-'));
    paths = new TeamMemberStoragePaths(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('builds stable path-safe keys from canonical member names', () => {
    expect(encodeTeamMemberStorageKey(' Bob ')).toBe('bob');
    expect(encodeTeamMemberStorageKey('Jack Smith')).toBe('jack%20smith');
    expect(encodeTeamMemberStorageKey('../Alice')).toBe('..%2Falice');
    expect(encodeTeamMemberStorageKey('.')).toBe('%2E');
    expect(encodeTeamMemberStorageKey('..')).toBe('%2E%2E');
    expect(encodeTeamMemberStorageKey('Том')).toBe('%D1%82%D0%BE%D0%BC');
  });

  it('keeps member storage inside the team members directory', () => {
    expect(paths.getMemberDir('team-a', '../Alice')).toBe(
      join(root, 'team-a', 'members', '..%2Falice')
    );
    expect(paths.getMemberDir('team-a', '..')).toBe(
      join(root, 'team-a', 'members', '%2E%2E')
    );
    expect(paths.getMemberDir('team-a', '.')).toBe(
      join(root, 'team-a', 'members', '%2E')
    );
    expect(paths.getMemberFeatureDir('team-a', 'Bob', '.member-work-sync')).toBe(
      join(root, 'team-a', 'members', 'bob', '.member-work-sync')
    );
  });

  it('rejects empty member names and nested feature directory names', () => {
    expect(() => encodeTeamMemberStorageKey('   ')).toThrow('memberName is required');
    expect(() => paths.getMemberFeatureDir('team-a', 'Bob', '../unsafe')).toThrow(
      'featureDirName must be a single path segment'
    );
    expect(() => paths.getMemberFeatureDir('team-a', 'Bob', 'nested/unsafe')).toThrow(
      'featureDirName must be a single path segment'
    );
    expect(() => paths.getMemberFeatureDir('team-a', 'Bob', '..')).toThrow(
      'featureDirName must be a single path segment'
    );
    expect(() => paths.getMemberFeatureDir('team-a', 'Bob', '.')).toThrow(
      'featureDirName must be a single path segment'
    );
  });

  it('materializes canonical member meta without changing the path key', async () => {
    await paths.ensureMemberMeta('team-a', 'Bob');

    const meta = JSON.parse(
      await readFile(join(root, 'team-a', 'members', 'bob', 'member.meta.json'), 'utf8')
    );
    expect(meta).toMatchObject({
      schemaVersion: 1,
      memberName: 'Bob',
      memberKey: 'bob',
    });
  });
});
