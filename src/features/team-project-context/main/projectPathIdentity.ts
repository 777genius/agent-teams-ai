import * as path from 'node:path';

/** A Windows project identity must name a drive or UNC share, not the app's current drive. */
export function isAbsoluteProjectPath(value: string, platform = process.platform): boolean {
  if (platform !== 'win32') return path.posix.isAbsolute(value);
  return (
    path.win32.isAbsolute(value) &&
    (/^[a-z]:[\\/]/i.test(value) || /^[/\\]{2}[^/\\]+[/\\]+[^/\\]+(?:[/\\]|$)/.test(value))
  );
}
