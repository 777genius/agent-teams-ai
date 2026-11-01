import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { HelperMode } from './publicationHelperProtocol';

export interface PublicationHelperConfiguration {
  directory: string;
  mode: HelperMode;
  prepareStandaloneRoot?: boolean;
}
/** App-owned build binding, not a defense against arbitrary same-user code replacement. */
export async function resolvePublicationHelper(
  configuration: PublicationHelperConfiguration,
): Promise<{
  executable: string;
  entry: string;
  buildId: string;
}> {
  const type = (process as NodeJS.Process & { type?: string }).type;
  if (
    configuration.mode === 'node'
      ? type !== undefined || !!process.versions.electron
      : type !== 'browser' || !process.versions.electron
  )
    throw new Error('Unsupported publication owner');
  const directory = configuration.directory;
  if (
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory ||
    (await realpath(directory)) !== directory
  )
    throw new Error('Invalid publication helper location');
  const entry = path.join(directory, 'publication-helper.cjs');
  const manifestPath = path.join(directory, 'manifest.json');
  for (const file of [entry, manifestPath]) {
    if ((await realpath(file)) !== file || !(await stat(file)).isFile())
      throw new Error('Invalid helper artifact');
  }
  const manifestStat = await stat(manifestPath);
  const entryStat = await stat(entry);
  if (manifestStat.size > 4_096 || entryStat.size > 2_000_000)
    throw new Error('Invalid helper artifact');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<
    string,
    unknown
  >;
  if (
    Object.keys(manifest).sort().join(',') !==
      'buildId,bytes,schemaVersion,sha256' ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.buildId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(manifest.buildId) ||
    manifest.bytes !== entryStat.size ||
    typeof manifest.sha256 !== 'string' ||
    createHash('sha256')
      .update(await readFile(entry))
      .digest('hex') !== manifest.sha256
  )
    throw new Error('Invalid helper build binding');
  if (!path.isAbsolute(process.execPath))
    throw new Error('Invalid publication executable');
  return { executable: process.execPath, entry, buildId: manifest.buildId };
}
