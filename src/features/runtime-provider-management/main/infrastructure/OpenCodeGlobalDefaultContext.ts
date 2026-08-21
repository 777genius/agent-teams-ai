import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { getAppDataPath } from '@main/utils/pathDecoder';

const OPEN_CODE_GLOBAL_DEFAULT_CONTEXT_DIRECTORY = 'opencode-global-default-context';

export function getOpenCodeGlobalDefaultContextPath(): string {
  return path.join(
    getAppDataPath(),
    'runtime-provider-management',
    OPEN_CODE_GLOBAL_DEFAULT_CONTEXT_DIRECTORY
  );
}

export async function ensureOpenCodeGlobalDefaultContextPath(): Promise<void> {
  await mkdir(getOpenCodeGlobalDefaultContextPath(), { recursive: true });
}
