import {
  isTaskAttachmentGenerationGuardBackupPath,
  isTaskAttachmentGenerationGuardName,
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
  return !isTaskAttachmentGenerationGuardName(fileName);
}

export function shouldCollectTaskAttachmentBackupPath(relPath: string): boolean {
  return !isTaskAttachmentGenerationGuardBackupPath(relPath);
}
