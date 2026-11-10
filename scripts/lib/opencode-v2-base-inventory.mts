import fs from 'node:fs';
import path from 'node:path';

import { readOpenCodeV2DeliveryMap } from '../../src/features/opencode-runtime-installer/core/domain/v2Delivery.ts';

/** Legacy locks keep bundled support. New external bases must be graph-free before packaging. */
export function verifyExternalOpenCodeV2Base(
  runtime: string,
  lock: unknown,
  platformKey: string
): boolean {
  const descriptors = readOpenCodeV2DeliveryMap(lock);
  if (descriptors === null) return false;
  const descriptor = descriptors[platformKey];
  // Even an unqualified/base-only target must belong to this same source build.
  const sourceCommit = Object.values(descriptors)[0]?.sourceCommit;
  if (
    !sourceCommit ||
    fs.readFileSync(path.join(runtime, 'COMMIT_SHA'), 'utf8').trim() !== sourceCommit
  )
    throw new Error('OpenCode V2 support and base runtime source identities differ');
  const baseDelivery = JSON.parse(
    fs.readFileSync(path.join(runtime, 'opencode-delivery.json'), 'utf8')
  ) as { bunVersion?: unknown };
  if (descriptor && baseDelivery.bunVersion !== descriptor.requiredBunVersion)
    throw new Error('OpenCode V2 support requires a different base Bun version');
  for (const required of [
    'local-cli/cli.js',
    platformKey.startsWith('win32-') ? 'bun/bun.exe' : 'bun/bun',
  ])
    if (!fs.lstatSync(path.join(runtime, required)).isFile())
      throw new Error(`Missing graph-free base entry: ${required}`);
  const pending = [runtime];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(runtime, file).replaceAll(path.sep, '/');
      if (
        relative === 'local-cli/node_modules' ||
        /(?:^|\/)(?:opencodeV2(?:Server|ExecutionServer|RunOwner)\.js|opencode-v2-graphs\.json|opencode-v2-engine-manifest\.json|agent-teams-opencode-v2-support-.*\.zip)$/i.test(
          relative
        )
      )
        throw new Error(`Optional OpenCode V2 bytes in base runtime: ${relative}`);
      if (entry.isDirectory()) pending.push(file);
      else if (!entry.isFile()) throw new Error(`Unsupported base runtime entry: ${relative}`);
    }
  }
  return true;
}
