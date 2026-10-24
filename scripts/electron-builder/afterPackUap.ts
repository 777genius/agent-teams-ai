import { createRequire } from 'node:module';

import type { AfterPackContext } from 'electron-builder';

import {
  bundledUapDirectory,
  refreshUapRuntimeDigest,
  verifyPackagedUap,
} from './uapRuntimeIntegrity.ts';

const legacyAfterPack = createRequire(import.meta.url)('./afterPack.cjs') as (
  context: AfterPackContext
) => Promise<void>;

export default async function afterPackUap(context: AfterPackContext): Promise<void> {
  await legacyAfterPack(context);
  // electron-builder 26 signs extraResources EXEs during the awaited copy,
  // before afterPack. Its later Windows signApp pass does not sign resources/uap.
  if (context.electronPlatformName === 'win32') {
    refreshUapRuntimeDigest(bundledUapDirectory(context));
  }
  verifyPackagedUap(context);
}
