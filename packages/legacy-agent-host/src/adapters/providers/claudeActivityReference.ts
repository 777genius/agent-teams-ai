import { runtimeDigest } from '../../runtime/identity.js';
import type { RuntimeBinding } from '../../runtime/contracts.js';

/** Native references are private; stable aliases join related application log rows in one captured generation. */
export const claudeActivityReference = (binding: RuntimeBinding, sessionRef: string, kind: string, native: string): string =>
  `${kind}-${runtimeDigest({ binding, sessionRef, kind, native })}`;
