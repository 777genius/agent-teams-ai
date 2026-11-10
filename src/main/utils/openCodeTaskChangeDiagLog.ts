/**
 * Dev-only OpenCode task-change diagnostics.
 *
 * The normal logger is intentionally quiet in production. This file writes a
 * bounded NDJSON trace under Electron's logs dir so local dev sessions can
 * explain why OpenCode task changes were or were not backfilled.
 */

import { appendFile, mkdir, stat, truncate } from 'fs/promises';
import { join } from 'path';

const FILE_NAME = 'opencode-task-change-diag.ndjson';
const MAX_DIAG_FILE_BYTES = 1024 * 1024;

function getElectronApp(): typeof import('electron').app | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy for tests / non-Electron.
    const { app } = require('electron') as typeof import('electron');
    return app ?? null;
  } catch {
    return null;
  }
}

function isEnabled(): boolean {
  if (process.env.CLAUDE_TEAM_OPENCODE_TASK_CHANGE_DIAG === '1') {
    return true;
  }
  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    return true;
  }
  const app = getElectronApp();
  return app !== null && typeof app.isPackaged === 'boolean' && app.isPackaged === false;
}

function resolveLogsDirectory(): string | null {
  const app = getElectronApp();
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
}

export async function appendOpenCodeTaskChangeDiag(
  entry: Record<string, unknown>
): Promise<string | null> {
  if (!isEnabled()) {
    return null;
  }
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
      // Missing file is fine.
    }
    await appendFile(filePath, line, 'utf8');
    return filePath;
  } catch {
    return null;
  }
}
