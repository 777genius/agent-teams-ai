import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { applyOpenCodeAutoUpdatePolicy } from '@main/services/runtime/openCodeAutoUpdatePolicy';
import { buildMergedCliPath } from '@main/utils/cliPathMerge';
import { getAppDataPath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

const logger = createLogger('AttachmentBridgeEnvironment');

/** Establish the trusted root before profile fingerprinting; invalid roots retain legacy denial. */
export async function createAttachmentBridgeEnvironment(
  binaryPath: string
): Promise<NodeJS.ProcessEnv> {
  let attachmentRoot: string | undefined;
  try {
    const root = join(getAppDataPath(), 'attachments');
    await mkdir(getAppDataPath(), { recursive: true, mode: 0o700 });
    await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Attachment root must be a regular directory');
    attachmentRoot = await realpath(root);
  } catch (error) {
    logger.warn(
      `Attachment root unavailable; OpenCode retains external-directory denial: ${String(error)}`
    );
  }
  return applyOpenCodeAutoUpdatePolicy({
    ...process.env,
    PATH: buildMergedCliPath(binaryPath),
    CLAUDE_AGENT_TEAMS_ATTACHMENT_ROOT: attachmentRoot,
  });
}
