import path from 'node:path';

import { signAsync } from '@electron/osx-sign';
import { retry } from 'builder-util-runtime';

import { refreshUapRuntimeDigest, verifyUapRuntimeDigest } from './uapRuntimeIntegrity.ts';

type SigningOptions = Parameters<typeof signAsync>[0];

export default async function signMacUap(options: SigningOptions): Promise<void> {
  const resourceRoot = path.join(options.app, 'Contents', 'Resources', 'uap');
  verifyUapRuntimeDigest(resourceRoot);
  let refreshedBeforeSeal = false;
  const signingOptions: SigningOptions = {
    ...options,
    optionsForFile(filePath) {
      const original = options.optionsForFile?.(filePath);
      // osx-sign 1.3.3 signs each nested binary, then the outer app, in order.
      // This callback runs immediately before each codesign invocation. Updating
      // the final helper checksum here makes runtime.json part of the app seal.
      if (path.resolve(filePath) === path.resolve(options.app)) {
        refreshUapRuntimeDigest(resourceRoot);
        refreshedBeforeSeal = true;
      }
      return original ?? {};
    },
  };
  // Match electron-builder's existing retry policy, using its public helper.
  // A partial signing attempt legitimately changes helper bytes; only the first
  // attempt checks the unsigned digest, and every successful seal refreshes it.
  await retry(
    () => {
      refreshedBeforeSeal = false;
      return signAsync(signingOptions);
    },
    { retries: 3, interval: 5000, backoff: 5000 }
  );
  if (!refreshedBeforeSeal) {
    throw new Error('The macOS signer did not reach the outer app integrity checkpoint.');
  }
  // Read-only after signing: rewriting runtime.json now would invalidate macOS's seal.
  verifyUapRuntimeDigest(resourceRoot);
}
