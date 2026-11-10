import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { APP_RELEASE, BUILD_GIT_SHA, BUILD_ID } from '@shared/utils/buildMetadata';
import {
  parseSentryArtifactInventory,
  SENTRY_INVENTORY_FILE,
  SENTRY_INVENTORY_MAX_BYTES,
  type SentryBuildIdentity,
  type SentryRuntimeInventory,
} from '@shared/utils/sentryArtifactInventory';
import {
  createMainSentryArtifactPolicy,
  type SentryArtifactPolicy,
} from '@shared/utils/sentryArtifactPolicy';

/** Read at most one bounded sidecar from an application-owned path, including asar. */
function readInventory(file: string, expected: SentryBuildIdentity): SentryRuntimeInventory | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, 'r');
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > SENTRY_INVENTORY_MAX_BYTES) return null;
    const bytes = Buffer.alloc(SENTRY_INVENTORY_MAX_BYTES + 1);
    const count = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count > SENTRY_INVENTORY_MAX_BYTES) return null;
    return parseSentryArtifactInventory(bytes.subarray(0, count).toString('utf8'), expected);
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
export function loadMainSentryArtifactPolicy(): SentryArtifactPolicy | null {
  try {
    // Electron stays optional in standalone mode; no user config or event supplies this root.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional Electron startup dependency.
    const electron = require('electron') as { app?: { getAppPath(): string } };
    const root = electron.app?.getAppPath();
    if (!root) return null;
    const identity = { release: APP_RELEASE, buildId: BUILD_ID, gitSha: BUILD_GIT_SHA };
    const main = readInventory(join(root, 'dist-electron/main', SENTRY_INVENTORY_FILE), identity);
    const renderer = readInventory(join(root, 'out/renderer', SENTRY_INVENTORY_FILE), identity);
    return createMainSentryArtifactPolicy(main, renderer, identity, {
      fileUrl: pathToFileURL(root + sep).href,
      nativePath: root,
      nativeSeparator: sep === '\\' ? '\\' : '/',
    });
  } catch {
    return null;
  }
}
