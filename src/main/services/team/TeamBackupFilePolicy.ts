import {
  isTaskAttachmentInternalArtifactBackupPath,
  isTaskAttachmentInternalArtifactName,
} from './TaskAttachmentArtifacts';

export function isValidJson(content: string): boolean {
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

export function isValidConfig(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return typeof parsed.name === 'string' && parsed.name.trim() !== '';
  } catch {
    return false;
  }
}

export function shouldCollectTaskAttachmentBackupFile(fileName: string): boolean {
  return !isTaskAttachmentInternalArtifactName(fileName);
}

export function shouldRestoreTaskAttachmentBackupPath(relPath: string): boolean {
  return !isTaskAttachmentInternalArtifactBackupPath(relPath);
}
