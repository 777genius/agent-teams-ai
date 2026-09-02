/**
 * Notification history file handling.
 *
 * Owns the on-disk representation of the notification history:
 * - the storage path and the legacy paths migrated away from
 * - parsing (including recovery of a truncated/appended history file)
 * - the atomic write used by the save chain
 */

import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { getHomeDir } from '@main/utils/pathDecoder';
import * as fsp from 'fs/promises';
import * as path from 'path';

import type { DetectedError } from '../error/ErrorMessageBuilder';

/**
 * Stored notification with read status.
 */
export interface StoredNotification extends DetectedError {
  /** Whether the notification has been read */
  isRead: boolean;
  /** When the notification was created (may differ from error timestamp) */
  createdAt: number;
}

/** Path to notifications storage file */
export const NOTIFICATIONS_PATH = path.join(
  getHomeDir(),
  '.claude',
  'agent-teams-notifications.json'
);
const LEGACY_NOTIFICATION_FILENAMES = [
  'claude-devtools-notifications.json',
  'claude-code-context-notifications.json',
] as const;
const LEGACY_NOTIFICATION_PATHS = LEGACY_NOTIFICATION_FILENAMES.map((filename) =>
  path.join(getHomeDir(), '.claude', filename)
);

interface LegacyNotificationData {
  path: string;
  data: string;
}

export async function migrateLegacyNotificationPath(): Promise<string> {
  try {
    await fsp.readFile(NOTIFICATIONS_PATH, 'utf8');
    return NOTIFICATIONS_PATH;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return NOTIFICATIONS_PATH;
    }
  }

  const legacyNotificationData = await selectLegacyNotificationData();
  if (!legacyNotificationData) {
    return NOTIFICATIONS_PATH;
  }

  try {
    await fsp.mkdir(path.dirname(NOTIFICATIONS_PATH), { recursive: true });
    await fsp.writeFile(NOTIFICATIONS_PATH, legacyNotificationData.data, {
      encoding: 'utf8',
      flag: 'wx',
    });
    return NOTIFICATIONS_PATH;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return NOTIFICATIONS_PATH;
    }

    return legacyNotificationData.path;
  }
}

async function selectLegacyNotificationData(): Promise<LegacyNotificationData | null> {
  const readableData: LegacyNotificationData[] = [];

  for (const legacyPath of LEGACY_NOTIFICATION_PATHS) {
    try {
      const legacyData = await fsp.readFile(legacyPath, 'utf8');
      const candidate = { path: legacyPath, data: legacyData };
      if (isNotificationHistoryJson(legacyData)) {
        return candidate;
      }
      readableData.push(candidate);
    } catch {
      // Continue to older legacy filenames.
    }
  }

  return readableData[0] ?? null;
}

function isNotificationHistoryJson(data: string): boolean {
  return parseNotificationHistory(data) !== null;
}

export interface NotificationHistoryParseResult {
  notifications: StoredNotification[];
  recovered: boolean;
}

export function parseNotificationHistory(data: string): NotificationHistoryParseResult | null {
  const parsed = parseNotificationHistoryArray(data);
  if (parsed) {
    return { notifications: parsed, recovered: false };
  }

  const firstArrayEnd = findFirstJsonArrayEnd(data);
  if (firstArrayEnd === null) {
    return null;
  }

  const recovered = parseNotificationHistoryArray(data.slice(0, firstArrayEnd));
  return recovered ? { notifications: recovered, recovered: true } : null;
}

function parseNotificationHistoryArray(data: string): StoredNotification[] | null {
  try {
    const parsed = JSON.parse(data) as unknown;
    return Array.isArray(parsed) ? (parsed as StoredNotification[]) : null;
  } catch {
    return null;
  }
}

function findFirstJsonArrayEnd(data: string): number | null {
  const start = data.search(/\S/u);
  if (start === -1 || data[start] !== '[') {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < data.length; index++) {
    const char = data[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '[') {
      depth += 1;
      continue;
    }

    if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }

  return null;
}

export async function writeNotificationsFileAtomically(
  filePath: string,
  data: string
): Promise<void> {
  await atomicWriteAsync(filePath, data);
}
