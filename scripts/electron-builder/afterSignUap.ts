import type { AfterPackContext } from 'electron-builder';

import { verifyPackagedUap } from './uapRuntimeIntegrity.ts';

export default function afterSignUap(context: AfterPackContext): void {
  // Verification only. No file in a signed app bundle may be changed here.
  verifyPackagedUap(context);
}
