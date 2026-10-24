import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import sdkProvenance from '../../../../../vendor/uap/sdk/provenance.json';

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    engineVersion: z.string(),
    platform: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    executable: z.enum(['agentplugins', 'agentplugins.exe']),
  })
  .strict();

export async function resolveUapExecutable(resourceRoot: string): Promise<string> {
  let content: string;
  try {
    content = await readFile(path.join(resourceRoot, 'runtime.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        'The extension manager is missing. Repair the Agent Teams installation; in a development checkout, run pnpm stage-uap-runtime.'
      );
    }
    throw error;
  }
  const manifest = manifestSchema.parse(JSON.parse(content));
  if (manifest.platform !== `${process.platform}-${process.arch}`)
    throw new Error('The bundled extension manager does not match this platform.');
  if (manifest.sourceSha !== sdkProvenance.sourceCommit)
    throw new Error('The bundled extension manager and SDK must use the same reviewed source.');
  if (manifest.engineVersion !== sdkProvenance.engineVersion)
    throw new Error('The bundled extension manager does not match its reviewed build version.');
  const executable = await realpath(path.join(resourceRoot, manifest.executable));
  const root = await realpath(resourceRoot);
  if (path.dirname(executable) !== root)
    throw new Error('The extension manager executable is outside its package.');
  const digest = createHash('sha256')
    .update(await readFile(executable))
    .digest('hex');
  if (digest !== manifest.sha256)
    throw new Error('The bundled extension manager failed its integrity check.');
  return executable;
}
