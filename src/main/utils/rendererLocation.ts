import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { DEV_SERVER_PORT } from '@shared/constants';

/** Main bundle is in dist-electron/main; packaged layouts can retain either renderer path. */
export function resolveRendererIndexPath(mainBundleDirectory: string): string {
  const candidates = [
    join(mainBundleDirectory, '../../out/renderer/index.html'),
    join(mainBundleDirectory, '../renderer/index.html'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/** Shared by window loading and privileged IPC sender validation. */
export function getDevRendererLocation(env: Readonly<Record<string, string | undefined>>): {
  configured: boolean;
  url: string;
} {
  const selected =
    env.ELECTRON_RENDERER_URL || env.VITE_DEV_SERVER_URL || env.ELECTRON_VITE_DEV_SERVER_URL;
  return { configured: !!selected, url: selected?.trim() || `http://localhost:${DEV_SERVER_PORT}` };
}
