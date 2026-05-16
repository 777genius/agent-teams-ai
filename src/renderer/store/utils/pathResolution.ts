/**
 * Path resolution utilities for the store.
 */

import { isAbsoluteOrHomePath, stripTrailingSeparators } from '@shared/utils/platformPath';

/**
 * Resolves a relative path against a base path, handling various path formats.
 * Handles:
 * - Absolute paths: /full/path/file.tsx (returned as-is)
 * - Relative paths with ./: ./apps/foo/bar.tsx (strips ./)
 * - Parent paths with ../: ../other/file.tsx (walks up directories)
 * - Plain paths: apps/foo/bar.tsx (joins with base)
 * - Paths with @ prefix: @apps/foo/bar.tsx (strips @ then joins)
 */
export function resolveFilePath(base: string, relativePath: string): string {
  // If already absolute, return as-is
  if (isAbsoluteOrHomePath(relativePath)) {
    return relativePath;
  }

  const cleanBase = stripTrailingSeparators(base);

  // Handle @ prefix (file mention marker) - strip it if present
  let cleanRelative = relativePath;
  if (cleanRelative.startsWith('@')) {
    cleanRelative = cleanRelative.slice(1);
  }

  if (isAbsoluteOrHomePath(cleanRelative)) {
    return cleanRelative;
  }

  // Handle ./ prefix (current directory)
  if (cleanRelative.startsWith('./') || cleanRelative.startsWith('.\\')) {
    cleanRelative = cleanRelative.slice(2);
  }

  // Handle ../ prefixes (parent directory)
  const separator = cleanBase.includes('\\') ? '\\' : '/';
  const hasUncRoot = cleanBase.startsWith('\\\\') || cleanBase.startsWith('//');
  const hasUnixRoot = !hasUncRoot && cleanBase.startsWith('/');
  const minRootParts = hasUncRoot ? 2 : 1;
  const normalizedRelative = normalizeSeparators(cleanRelative, separator);
  const baseParts = splitPath(cleanBase);
  let remainingRelative = normalizedRelative;

  while (remainingRelative.startsWith(`..${separator}`)) {
    remainingRelative = remainingRelative.slice(3);
    if (baseParts.length > minRootParts) {
      baseParts.pop();
    }
  }

  // Join the normalized paths
  let normalizedBase = baseParts.join(separator);
  if (hasUnixRoot && !normalizedBase.startsWith('/')) {
    normalizedBase = `/${normalizedBase}`;
  }
  if (hasUncRoot && !normalizedBase.startsWith(`${separator}${separator}`)) {
    normalizedBase = `${separator}${separator}${normalizedBase}`;
  }
  return remainingRelative ? `${normalizedBase}${separator}${remainingRelative}` : normalizedBase;
}

function normalizeSeparators(input: string, separator: '/' | '\\'): string {
  let output = '';
  let prevWasSeparator = false;

  for (const char of input) {
    const isSeparator = char === '/' || char === '\\';
    if (isSeparator) {
      if (!prevWasSeparator) {
        output += separator;
      }
      prevWasSeparator = true;
    } else {
      output += char;
      prevWasSeparator = false;
    }
  }

  return output;
}

function splitPath(input: string): string[] {
  const parts: string[] = [];
  let current = '';

  for (const char of input) {
    if (char === '/' || char === '\\') {
      if (current.length > 0) {
        parts.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current.length > 0) {
    parts.push(current);
  }

  return parts;
}
