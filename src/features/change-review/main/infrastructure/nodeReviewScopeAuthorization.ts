import {
  cleanupAtomicCreateTempLinks,
  isOwnedReviewFileTransactionHardlink,
} from '@main/utils/atomicWrite';
import { isPathWithinRoot, matchesSensitivePattern } from '@main/utils/pathValidation';
import * as fs from 'fs/promises';
import * as path from 'path';

import type {
  ReviewScopeFileStat,
  ReviewScopeFileSystemPort,
  ReviewScopePathPort,
} from '../application/ReviewScopeAuthorizationPorts';

function toReviewFileStat(stat: Awaited<ReturnType<typeof fs.stat>>): ReviewScopeFileStat {
  return {
    kind: stat.isSymbolicLink()
      ? 'symbolic-link'
      : stat.isDirectory()
        ? 'directory'
        : stat.isFile()
          ? 'file'
          : 'other',
    linkCount: Number(stat.nlink),
  };
}

export const nodeReviewScopePathPort: ReviewScopePathPort = {
  normalize: (filePath) => path.resolve(path.normalize(filePath)),
  dirname: (filePath) => path.dirname(filePath),
  isAbsolute: (filePath) => path.isAbsolute(path.normalize(filePath)),
  isWithinRoot: isPathWithinRoot,
  isSensitive: matchesSensitivePattern,
  normalizeIdentity: (filePath) => {
    const normalized = path.resolve(path.normalize(filePath));
    return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
  },
};

export const nodeReviewScopeFileSystemPort: ReviewScopeFileSystemPort = {
  stat: async (filePath) => toReviewFileStat(await fs.stat(filePath)),
  lstat: async (filePath) => toReviewFileStat(await fs.lstat(filePath)),
  realpath: (filePath) => fs.realpath(filePath),
  cleanupOwnedTemporaryLinks: cleanupAtomicCreateTempLinks,
  isOwnedTransactionHardlink: isOwnedReviewFileTransactionHardlink,
};
