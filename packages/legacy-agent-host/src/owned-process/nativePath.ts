import { posix, win32 } from 'node:path';

/** Lexical guard only. Canonical file identity and native ownership are checked separately. */
export function isCanonicalNativePath(platform: string, value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192 || value.includes('\0')) return false;
  if (platform.startsWith('win32-')) {
    const root = win32.parse(value).root;
    return /^[A-Za-z]:\\/.test(value) && win32.isAbsolute(value) && win32.normalize(value) === value &&
      value.length > root.length && value.slice(root.length).split('\\').every(segment =>
        segment.length > 0 && !/[ .]$/.test(segment) && !/[<>:"|?*\x00-\x1f]/.test(segment) &&
        !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(segment));
  }
  return posix.isAbsolute(value) && !value.endsWith('/') && posix.normalize(value) === value && value !== '/';
}

/** Preserve legacy POSIX admission; Windows always uses its real current-OS drive path. */
export const isNativeProfilePath = (value: string): boolean => process.platform === 'win32'
  ? isCanonicalNativePath(`win32-${process.arch}`, value)
  : value.startsWith('/') && !value.includes('\0');
