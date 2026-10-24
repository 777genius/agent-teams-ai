import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { Arch } from 'electron-builder';
import { z } from 'zod';

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    engineVersion: z.string().regex(/^\d+\.\d+\.\d+\+agentteams\.[a-f0-9]{12}$/),
    platform: z.string().regex(/^(darwin|linux|win32)-(arm64|x64)$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    executable: z.enum(['agentplugins', 'agentplugins.exe']),
  })
  .strict();

export interface UapPackContext {
  appOutDir: string;
  electronPlatformName: string;
  arch: number;
  packager: { appInfo: { productFilename: string } };
}

export function bundledUapDirectory(context: UapPackContext): string {
  if (context.electronPlatformName === 'darwin') {
    return path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
      'Resources',
      'uap'
    );
  }
  if (!['linux', 'win32'].includes(context.electronPlatformName)) {
    throw new Error('UAP packaging does not support this platform.');
  }
  return path.join(context.appOutDir, 'resources', 'uap');
}

function readRuntime(resourceRoot: string) {
  const manifestPath = path.join(resourceRoot, 'runtime.json');
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const expectedExecutable = manifest.platform.startsWith('win32-')
    ? 'agentplugins.exe'
    : 'agentplugins';
  if (manifest.executable !== expectedExecutable) {
    throw new Error('The UAP executable name does not match its packaging platform.');
  }
  const executable = realpathSync(path.join(resourceRoot, manifest.executable));
  if (path.dirname(executable) !== realpathSync(resourceRoot)) {
    throw new Error('The UAP executable is outside the packaged resource directory.');
  }
  const digest = createHash('sha256').update(readFileSync(executable)).digest('hex');
  return { manifestPath, manifest, digest };
}

export function verifyUapRuntimeDigest(resourceRoot: string): void {
  const { manifest, digest } = readRuntime(resourceRoot);
  if (manifest.sha256 !== digest) {
    throw new Error('The packaged UAP runtime does not match its final binary checksum.');
  }
}

// Signing changes executable bytes. Call only in the packaging lifecycle before
// its containing signed bundle/installer is sealed, never during application use.
export function refreshUapRuntimeDigest(resourceRoot: string): void {
  const { manifestPath, manifest, digest } = readRuntime(resourceRoot);
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, sha256: digest }, null, 2)}\n`);
}

export function verifyPackagedUap(context: UapPackContext): void {
  const resourceRoot = bundledUapDirectory(context);
  const { manifest, digest } = readRuntime(resourceRoot);
  const provenance = z
    .object({
      sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
      engineVersion: z.string(),
    })
    .parse(
      JSON.parse(
        readFileSync(new URL('../../vendor/uap/sdk/provenance.json', import.meta.url), 'utf8')
      )
    );
  if (
    manifest.platform !== `${context.electronPlatformName}-${Arch[context.arch]}` ||
    manifest.sourceSha !== provenance.sourceCommit ||
    manifest.engineVersion !== provenance.engineVersion ||
    manifest.sha256 !== digest
  ) {
    throw new Error(
      'The packaged UAP runtime must match the SDK source, target, and final checksum.'
    );
  }
}
