import * as path from 'node:path';

const TASK_ATTACHMENT_GENERATION_GUARD_RE = /^\.review-create\.[a-f0-9-]+\.tmp$/i;
const TASK_ATTACHMENT_STAGED_DELETE_RE =
  /^\.attachment-delete\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.staged$/i;

export function isTaskAttachmentGenerationGuardName(fileName: string): boolean {
  return TASK_ATTACHMENT_GENERATION_GUARD_RE.test(fileName);
}

export function isTaskAttachmentInternalArtifactName(fileName: string): boolean {
  return (
    isTaskAttachmentGenerationGuardName(fileName) || TASK_ATTACHMENT_STAGED_DELETE_RE.test(fileName)
  );
}

export function isTaskAttachmentInternalArtifactBackupPath(relPath: string): boolean {
  const segments = relPath.split('/');
  return (
    segments[0] === 'task-attachments' &&
    segments.length === 3 &&
    isTaskAttachmentInternalArtifactName(path.basename(relPath))
  );
}
