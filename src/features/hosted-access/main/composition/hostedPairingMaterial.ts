import type { HostedAuthHostPlatform } from '../../core/application';

export const DEFAULT_HOSTED_PAIRING_CODE_FILE = '/run/agent-teams/pairing.json';

export type HostedPairingMaterialState = 'absent' | 'present' | 'unavailable';

export function resolveHostedPairingCodePath(
  environment: Readonly<Record<string, string | undefined>>
): string {
  return environment.PAIRING_CODE_FILE ?? DEFAULT_HOSTED_PAIRING_CODE_FILE;
}

/**
 * Observes whether plaintext pairing delivery is materialized. Any directory entry counts, even an
 * unparseable one, and a path that cannot be observed is never reported as absent.
 */
export async function probeHostedPairingMaterial(
  path: string,
  platform: Pick<HostedAuthHostPlatform, 'lstat'>
): Promise<HostedPairingMaterialState> {
  try {
    await platform.lstat(path);
    return 'present';
  } catch (error) {
    return (error as { readonly code?: string }).code === 'ENOENT' ? 'absent' : 'unavailable';
  }
}
