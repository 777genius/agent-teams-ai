import { readFile } from 'node:fs/promises';

import {
  normalizeOpenCodeBootstrapSessionRecord,
  type OpenCodeCommittedBootstrapSessionRecord,
} from './OpenCodeBootstrapSessionNormalization';

export async function readOpenCodeBootstrapSessionStore(
  filePath: string,
  expected: {
    teamName: string;
    laneId: string;
  }
): Promise<OpenCodeCommittedBootstrapSessionRecord[]> {
  const raw = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  const record =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  const data =
    record && Object.prototype.hasOwnProperty.call(record, 'data') ? record.data : record;
  const sessions =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>).sessions
      : null;
  if (!Array.isArray(sessions)) {
    return [];
  }
  return sessions.flatMap((session): OpenCodeCommittedBootstrapSessionRecord[] => {
    const normalized = normalizeOpenCodeBootstrapSessionRecord(session);
    if (!normalized) {
      return [];
    }
    if (normalized.teamName !== expected.teamName || normalized.laneId !== expected.laneId) {
      return [];
    }
    return [normalized];
  });
}
