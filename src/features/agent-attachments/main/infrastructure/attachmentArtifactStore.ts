import { resolveAgentAttachmentArtifactPath as resolvePortable } from '@agent-teams/legacy-agent-host/attachments/storage';
import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { getAppDataPath } from '@main/utils/pathDecoder';

import type { ResolveAgentAttachmentArtifactPathInput as PortableArtifactPathInput } from '@agent-teams/legacy-agent-host/attachments/storage';
export type { AgentAttachmentArtifactFileName } from '@agent-teams/legacy-agent-host/attachments/storage';
export type ResolveAgentAttachmentArtifactPathInput = Omit<
  PortableArtifactPathInput,
  'appDataPath'
> & { appDataPath?: string };
export function resolveAgentAttachmentArtifactPath(
  input: ResolveAgentAttachmentArtifactPathInput
): string {
  return resolvePortable({ ...input, appDataPath: input.appDataPath ?? getAppDataPath() });
}
export async function writeFileAtomic(filePath: string, bytes: Buffer | string): Promise<void> {
  await atomicWriteAsync(filePath, bytes);
}
