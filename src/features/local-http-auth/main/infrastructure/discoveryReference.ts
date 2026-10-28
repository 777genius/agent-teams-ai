import { constants, type Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

import { normalizeEndpoint } from '../../core/domain/authority';

import { replacePrivateJson } from './privateFiles';
import { assertPrivateWindowsAcl } from './windowsPrivateAcl';

import type { ApiDiscoveryReference } from '../../contracts';

const referenceKeys = [
  'descriptorPath',
  'generation',
  'instanceId',
  'profileScope',
  'schemaVersion',
  'service',
];
export function validateDiscoveryReference(
  value: unknown,
  root: string,
  scope: string
): ApiDiscoveryReference {
  const reference = value as Partial<ApiDiscoveryReference> | null;
  if (
    !reference ||
    typeof reference !== 'object' ||
    Object.keys(reference).sort().join(',') !== referenceKeys.join(',') ||
    reference.schemaVersion !== 1 ||
    reference.service !== 'api' ||
    reference.profileScope !== scope ||
    typeof reference.instanceId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(reference.instanceId) ||
    typeof reference.generation !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(reference.generation) ||
    reference.descriptorPath !==
      path.join(root, 'local-http-auth', `api-${reference.instanceId}-${reference.generation}.json`)
  )
    throw new Error('Invalid private API discovery reference');
  return reference as ApiDiscoveryReference;
}

function isLegacyMetadata(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (
    !['baseUrl,pid,updatedAt', 'authToken,baseUrl,pid,updatedAt'].includes(
      Object.keys(record).sort().join(',')
    ) ||
    ('authToken' in record &&
      (typeof record.authToken !== 'string' || !/^\S{32,512}$/.test(record.authToken))) ||
    typeof record.baseUrl !== 'string' ||
    typeof record.pid !== 'number' ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.updatedAt))
  )
    return false;
  return normalizeEndpoint(record.baseUrl) === record.baseUrl;
}

/** Only the historical manual metadata path can migrate; no URL/PID is adopted or contacted. */
export async function writeManualDiscovery(
  root: string,
  reference: ApiDiscoveryReference
): Promise<void> {
  const file = path.join(root, 'team-control-api.json');
  await replacePrivateJson(file, reference, async (target): Promise<Stats> => {
    const before = await lstat(target);
    const mode = before.mode & 0o777;
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > 16_384 ||
      (process.getuid && (before.uid !== process.getuid() || ![0o600, 0o644].includes(mode)))
    )
      throw new Error('Unsafe legacy API metadata');
    if (process.platform === 'win32') assertPrivateWindowsAcl(target);
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.uid !== before.uid ||
        opened.mode !== before.mode ||
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.size > 16_384
      )
        throw new Error('Legacy API metadata changed');
      const value: unknown = JSON.parse(await handle.readFile('utf8'));
      if (
        value &&
        typeof value === 'object' &&
        'authToken' in value &&
        process.getuid &&
        mode !== 0o600
      )
        throw new Error('Legacy API credentials are not private');
      if (!isLegacyMetadata(value)) {
        // A current descriptor must meet the normal private policy; no schema downgrade.
        if (process.getuid && mode !== 0o600)
          throw new Error('Current API reference is not private');
        validateDiscoveryReference(value, root, reference.profileScope);
      }
      return opened;
    } finally {
      await handle.close();
    }
  });
}
