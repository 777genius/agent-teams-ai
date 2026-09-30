import { isAbsolute, resolve } from 'node:path';

export function admitHostedReadRoot(reference: string): string {
  if (
    !isAbsolute(reference) ||
    resolve(reference) !== reference ||
    reference === resolve(reference, '/')
  ) {
    throw new TypeError('team-lifecycle-read-runtime-root-invalid');
  }
  return reference;
}

export function resolveStandaloneAuthDataDirectory(
  environment: Readonly<Record<string, string | undefined>>,
  hostedMode: boolean
): string {
  const configured = environment.AUTH_DATA_DIR;
  if (hostedMode && configured === undefined) throw new Error('hosted_auth_data_dir_required');
  return admitHostedReadRoot(configured ?? '/data/.agent-teams');
}
