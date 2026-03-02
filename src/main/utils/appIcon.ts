/**
 * Resolves the application icon path for native notifications and windows.
 *
 * On macOS the signed bundle provides the icon automatically,
 * so this is primarily needed for Windows and Linux.
 */

import { existsSync } from 'fs';
import { join } from 'path';

let cachedPath: string | undefined;
let resolved = false;

/**
 * Returns the absolute path to the app icon (PNG), or undefined if not found.
 * Result is cached after the first call.
 */
export function getAppIconPath(): string | undefined {
  if (resolved) return cachedPath;

  const isDev = process.env.NODE_ENV === 'development';
  const candidates = isDev
    ? [join(process.cwd(), 'resources/icon.png')]
    : [
        join(process.resourcesPath, 'resources/icon.png'),
        join(__dirname, '../../resources/icon.png'),
      ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedPath = candidate;
      break;
    }
  }

  resolved = true;
  return cachedPath;
}
