import { resolve } from 'node:path';

import { loadActualOwnerIntegration } from './contracts';
import { runActualOwnerE2E } from './driver';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--integration-manifest') {
  throw new Error(
    'usage: node --import tsx scripts/e2e/hosted-actual-owner/run.ts --integration-manifest <absolute-path>'
  );
}
const manifestPath = resolve(args[1]!);
if (manifestPath !== args[1]) throw new Error('actual_owner_integration_manifest_path_invalid');
process.stdout.write(
  `${await runActualOwnerE2E(await loadActualOwnerIntegration(manifestPath))}\n`
);
