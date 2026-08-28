#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_PACKAGE = '@agent-teams/desktop-file-lock-native';
const FORBIDDEN_PACKAGE = '@claude-teams/desktop-file-lock-native';

export function verifyDesktopFileLockMainBundle(bundleDir) {
  if (!fs.existsSync(bundleDir)) {
    throw new Error(`Electron main bundle directory is missing: ${bundleDir}`);
  }

  const bundleFiles = fs
    .readdirSync(bundleDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.cjs'))
    .map((entry) => path.join(bundleDir, entry.name));
  if (bundleFiles.length === 0) {
    throw new Error(`Electron main bundle contains no CommonJS entries: ${bundleDir}`);
  }

  const contents = bundleFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  if (!contents.includes(REQUIRED_PACKAGE)) {
    throw new Error(
      `Electron main bundle does not retain the required external package ${REQUIRED_PACKAGE}`
    );
  }
  if (contents.includes(FORBIDDEN_PACKAGE)) {
    throw new Error(`Electron main bundle references obsolete package name ${FORBIDDEN_PACKAGE}`);
  }

  console.log(
    `[desktop-file-lock-native] main bundle retains deterministic external ${REQUIRED_PACKAGE}`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyDesktopFileLockMainBundle(path.resolve('dist-electron/main'));
}
