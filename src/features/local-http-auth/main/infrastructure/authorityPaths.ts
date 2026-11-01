import { createHash } from 'node:crypto';
import path from 'node:path';

export function apiProfileScope(root: string): string {
  return createHash('sha256').update(root).digest('hex');
}

export function apiReferencePath(root: string, instanceId: string): string {
  return path.join(root, 'local-http-auth', `api-${instanceId}.ref.json`);
}
