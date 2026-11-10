/**
 * Persistent CLI/auth diagnostics for packaged apps.
 * console.info/warn are suppressed in production (see shared logger); this file
 * appends NDJSON lines under Electron's logs directory when possible.
 */

import { appendFile, mkdir, stat, truncate } from 'fs/promises';
import { join } from 'path';

const FILE_NAME = 'claude-cli-auth-diag.ndjson';

/** Prevent unbounded growth if getStatus runs often (e.g. UI polling). */
const MAX_DIAG_FILE_BYTES = 512 * 1024;

function resolveLogsDirectory(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy: tests / non-Electron
    const { app } = require('electron') as typeof import('electron');
    if (!app?.getPath) {
      return null;
    }
    try {
      return app.getPath('logs');
    } catch {
      try {
        return join(app.getPath('userData'), 'logs');
      } catch {
        return null;
      }
    }
  } catch {
    return null;
  }
}

/**
 * Append one JSON line (NDJSON). Safe no-op outside Electron or on I/O errors.
 * Typical macOS path: ~/Library/Logs/<product>/claude-cli-auth-diag.ndjson
 */
export async function appendCliAuthDiag(entry: Record<string, unknown>): Promise<string | null> {
  const dir = resolveLogsDirectory();
  if (!dir) {
    return null;
  }
  const filePath = join(dir, FILE_NAME);
  let line: string;
  try {
    line =
      JSON.stringify({
        t: new Date().toISOString(),
        diagFile: filePath,
        ...entry,
      }) + '\n';
  } catch {
    return null;
  }
  try {
    await mkdir(dir, { recursive: true });
    try {
      const st = await stat(filePath);
      if (st.size > MAX_DIAG_FILE_BYTES) {
        await truncate(filePath, 0);
      }
    } catch {
      /* file missing — ok */
    }
    await appendFile(filePath, line, 'utf8');
    return filePath;
  } catch {
    return null;
  }
}
