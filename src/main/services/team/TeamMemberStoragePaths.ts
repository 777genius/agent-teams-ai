import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { mkdir, readFile } from 'fs/promises';
import { join } from 'path';

export interface TeamMemberStorageMetaFile {
  schemaVersion: 1;
  memberName: string;
  memberKey: string;
  updatedAt: string;
}

export function normalizeTeamMemberStorageName(memberName: string): string {
  return memberName.trim().toLowerCase();
}

export function encodeTeamMemberStorageKey(memberName: string): string {
  const normalized = normalizeTeamMemberStorageName(memberName);
  if (!normalized) {
    throw new Error('memberName is required for member-scoped storage');
  }
  const encoded = encodeURIComponent(normalized);
  if (encoded === '.') {
    return '%2E';
  }
  if (encoded === '..') {
    return '%2E%2E';
  }
  return encoded;
}

function isMetaFile(value: unknown): value is TeamMemberStorageMetaFile {
  return (
    value != null &&
    typeof value === 'object' &&
    (value as TeamMemberStorageMetaFile).schemaVersion === 1 &&
    typeof (value as TeamMemberStorageMetaFile).memberName === 'string' &&
    typeof (value as TeamMemberStorageMetaFile).memberKey === 'string' &&
    typeof (value as TeamMemberStorageMetaFile).updatedAt === 'string'
  );
}

export class TeamMemberStoragePaths {
  constructor(private readonly teamsBasePath: string) {}

  getTeamDir(teamName: string): string {
    return join(this.teamsBasePath, teamName);
  }

  getMembersDir(teamName: string): string {
    return join(this.getTeamDir(teamName), 'members');
  }

  getMemberKey(memberName: string): string {
    return encodeTeamMemberStorageKey(memberName);
  }

  getMemberDir(teamName: string, memberName: string): string {
    return join(this.getMembersDir(teamName), this.getMemberKey(memberName));
  }

  getMemberMetaPath(teamName: string, memberName: string): string {
    return join(this.getMemberDir(teamName, memberName), 'member.meta.json');
  }

  getMemberFeatureDir(teamName: string, memberName: string, featureDirName: string): string {
    const featureDirSegment = featureDirName.trim();
    if (
      !featureDirSegment ||
      featureDirSegment === '.' ||
      featureDirSegment === '..' ||
      featureDirSegment.includes('/') ||
      featureDirSegment.includes('\\')
    ) {
      throw new Error('featureDirName must be a single path segment');
    }
    return join(this.getMemberDir(teamName, memberName), featureDirSegment);
  }

  async ensureMemberMeta(teamName: string, memberName: string): Promise<TeamMemberStorageMetaFile> {
    const canonicalMemberName = memberName.trim();
    const memberKey = this.getMemberKey(canonicalMemberName);
    const metaPath = this.getMemberMetaPath(teamName, canonicalMemberName);
    const existing = await this.readMeta(metaPath);
    if (existing?.memberName === canonicalMemberName && existing.memberKey === memberKey) {
      return existing;
    }

    const next: TeamMemberStorageMetaFile = {
      schemaVersion: 1,
      memberName: canonicalMemberName,
      memberKey,
      updatedAt: new Date().toISOString(),
    };
    await mkdir(this.getMemberDir(teamName, canonicalMemberName), { recursive: true });
    await atomicWriteAsync(metaPath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  private async readMeta(filePath: string): Promise<TeamMemberStorageMetaFile | null> {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return isMetaFile(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}
