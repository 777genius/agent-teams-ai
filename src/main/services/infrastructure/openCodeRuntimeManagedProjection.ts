import { statSync } from 'node:fs';

type ManifestSelection = { binaryPath: string };
type ManagedProjection = { manifest: string; file: string; generation: number; path: string };
let projection: ManagedProjection | null = null;

export function managedFileIdentity(file: string): string | null {
  try {
    const info = statSync(file, { bigint: true });
    return info.isFile() ? [info.dev, info.ino, info.size, info.mtimeNs].join(':') : null;
  } catch {
    return null;
  }
}

/** Only the async admission owner publishes a capture after CPU/ABI and version verification. */
export function rememberManagedProjection(
  manifest: ManifestSelection,
  before: string | null,
  generation: number,
  current: ManifestSelection | null,
  currentGeneration: number
): boolean {
  if (
    !before ||
    JSON.stringify(current) !== JSON.stringify(manifest) ||
    managedFileIdentity(manifest.binaryPath) !== before
  )
    return false;
  if (generation === currentGeneration)
    projection = {
      manifest: JSON.stringify(manifest),
      file: before,
      generation,
      path: manifest.binaryPath,
    };
  return true;
}

/** Synchronous status reads do not discover or execute an unverified manifest selection. */
export function readManagedProjection(
  manifest: ManifestSelection | null,
  generation: number
): string | null {
  const capture = projection;
  return manifest &&
    capture &&
    capture.generation === generation &&
    capture.manifest === JSON.stringify(manifest) &&
    managedFileIdentity(capture.path) === capture.file
    ? capture.path
    : null;
}
