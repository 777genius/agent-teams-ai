import * as path from 'node:path';
import { assertSafeAttachmentStorageId } from './portable.js';
export type AgentAttachmentArtifactFileName =
  | 'original.png'
  | 'original.jpg'
  | 'original.webp'
  | 'optimized.png'
  | 'optimized.jpg'
  | 'optimized.webp'
  | 'thumb.jpg'
  | 'meta.json'
  | 'payload';

export interface ResolveAgentAttachmentArtifactPathInput {
  teamName: string;
  messageId: string;
  attachmentId: string;
  fileName: AgentAttachmentArtifactFileName;
  appDataPath: string;
}

export function resolveAgentAttachmentArtifactPath(
  input: ResolveAgentAttachmentArtifactPathInput
): string {
  assertSafeAttachmentStorageId('teamName', input.teamName);
  assertSafeAttachmentStorageId('messageId', input.messageId);
  assertSafeAttachmentStorageId('attachmentId', input.attachmentId);

  const root = input.appDataPath;
  if (!path.isAbsolute(root) || path.resolve(root) !== root)
    throw new Error('Invalid attachment root');
  const base = path.resolve(
    root,
    'attachments',
    input.teamName,
    input.messageId,
    input.attachmentId
  );
  const resolved = path.resolve(base, input.fileName);
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error('Attachment artifact path escaped managed directory');
  }
  return resolved;
}
