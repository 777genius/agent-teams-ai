import * as path from 'node:path';

const TASK_ATTACHMENT_GENERATION_GUARD_RE = /^\.review-create\.[a-f0-9-]+\.tmp$/i;

export function isTaskAttachmentGenerationGuardName(fileName: string): boolean {
  return TASK_ATTACHMENT_GENERATION_GUARD_RE.test(fileName);
}

export function isTaskAttachmentGenerationGuardBackupPath(relPath: string): boolean {
  const segments = relPath.split('/');
  return (
    segments[0] === 'task-attachments' &&
    segments.length === 3 &&
    isTaskAttachmentGenerationGuardName(path.basename(relPath))
  );
}
