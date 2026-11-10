import * as fs from 'node:fs';
import * as path from 'node:path';

export interface BackupFileDescriptor {
  sourcePath: string;
  relPath: string;
}

const ATOMIC_WRITE_TEMP_FILE_PREFIX = '.tmp.';
const FILE_LOCK_SUFFIX = '.lock';
const QUARANTINED_OPENCODE_LANE_INDEX_RE = /^lanes\.invalid\.\d+\.json$/;
const MEMBER_WORK_SYNC_DIR = '.member-work-sync';
const MEMBER_WORK_SYNC_JOURNAL_FILE = 'journal.jsonl';

function shouldCollectRecursiveBackupFile(relPath: string): boolean {
  const fileName = path.basename(relPath);
  if (fileName.startsWith(ATOMIC_WRITE_TEMP_FILE_PREFIX)) {
    return false;
  }
  if (fileName.endsWith(FILE_LOCK_SUFFIX)) {
    return false;
  }
  if (QUARANTINED_OPENCODE_LANE_INDEX_RE.test(fileName)) {
    return false;
  }
  const segments = relPath.split('/');
  const workSyncIndex = segments.lastIndexOf(MEMBER_WORK_SYNC_DIR);
  return !(
    segments[0] === 'members' &&
    workSyncIndex >= 2 &&
    segments[workSyncIndex + 1] === MEMBER_WORK_SYNC_JOURNAL_FILE
  );
}

export async function collectRecursiveFiles(
  rootDir: string,
  relPrefix: string
): Promise<BackupFileDescriptor[]> {
  const files: BackupFileDescriptor[] = [];
  const walk = async (dirPath: string, relDir: string): Promise<void> => {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(dirPath, entry.name);
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(sourcePath, relPath);
      } else if (entry.isFile()) {
        const descriptorRelPath = relPrefix ? `${relPrefix}/${relPath}` : relPath;
        if (shouldCollectRecursiveBackupFile(descriptorRelPath)) {
          files.push({ sourcePath, relPath: descriptorRelPath });
        }
      }
    }
  };
  await walk(rootDir, '');
  return files;
}

export function collectRecursiveFilesSync(
  rootDir: string,
  relPrefix: string
): BackupFileDescriptor[] {
  const files: BackupFileDescriptor[] = [];
  const walk = (dirPath: string, relDir: string): void => {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const sourcePath = path.join(dirPath, entry.name);
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(sourcePath, relPath);
      } else if (entry.isFile()) {
        const descriptorRelPath = relPrefix ? `${relPrefix}/${relPath}` : relPath;
        if (shouldCollectRecursiveBackupFile(descriptorRelPath)) {
          files.push({ sourcePath, relPath: descriptorRelPath });
        }
      }
    }
  };
  walk(rootDir, '');
  return files;
}
