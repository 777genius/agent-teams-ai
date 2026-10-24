import * as fs from 'fs';

export interface MutationAuthorityOptions {
  assertCurrent?: () => void;
}
export type ArtifactIdentity = Pick<fs.Stats, 'dev' | 'ino'>;
export function sameArtifact(left: ArtifactIdentity, right: ArtifactIdentity): boolean {
  return left.dev === right.dev && left.ino !== 0 && left.ino === right.ino;
}
/** Stable FD establishes ownership before an awaited staging write can race a replacement. */
export async function writeGuardedTemp(
  path: string,
  data: string | Buffer,
  mode: number | undefined,
  options: MutationAuthorityOptions,
  owned: (identity: ArtifactIdentity) => void
): Promise<void> {
  options.assertCurrent?.();
  const handle = await fs.promises.open(path, 'wx', mode);
  try {
    owned(await handle.stat());
    options.assertCurrent?.();
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}
/** No await between final identity/current checks and cleanup of this exact private artifact. */
export function unlinkOwnedArtifact(
  path: string,
  identity: ArtifactIdentity | undefined,
  options: MutationAuthorityOptions
): void {
  if (!identity) return;
  options.assertCurrent?.();
  try {
    const current = fs.lstatSync(path);
    if (!sameArtifact(current, identity) || current.isSymbolicLink()) return;
    options.assertCurrent?.();
    const latest = fs.lstatSync(path);
    if (!sameArtifact(latest, identity) || latest.isSymbolicLink()) return;
    fs.unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
