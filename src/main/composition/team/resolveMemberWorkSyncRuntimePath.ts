import path from 'node:path';

export function resolveMemberWorkSyncRuntimePath(value: string | undefined): string | null {
  return value?.trim() ? path.resolve(value.trim()) : null;
}
