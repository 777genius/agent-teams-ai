import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export function verifyMacSigningPreflight(
  args: readonly string[],
  hostPlatform: string,
  env: NodeJS.ProcessEnv
): void {
  const isMac = args.includes('--mac') ||
    (hostPlatform === 'darwin' && !args.includes('--win') && !args.includes('--linux'));
  if (!isMac) return;

  const override = (name: string): string | undefined => {
    let value: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
      for (const prefix of [`--config.mac.${name}`, `-c.mac.${name}`]) {
        if (args[index] === prefix) value = args[index + 1];
        else if (args[index]?.startsWith(`${prefix}=`)) value = args[index]?.slice(prefix.length + 1);
      }
    }
    return value;
  };
  const identity = override('identity');
  const forceSigning = override('forceCodeSigning');
  const notarize = override('notarize');
  if (identity === 'null' && forceSigning === 'false' && notarize === 'false') return;
  if (identity === 'null' || forceSigning === 'false' || notarize === 'false') {
    throw new Error('Unsigned macOS packaging requires identity=null, forceCodeSigning=false and notarize=false together');
  }

  if (env.APPLE_TEAM_ID !== '86399583GS') throw new Error('APPLE_TEAM_ID must equal 86399583GS');
  for (const name of ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) {
    if (!env[name]?.trim()) throw new Error(`Missing ${name} for signed macOS packaging`);
  }
  if (!/^[A-Z0-9]{10}$/.test(env.APPLE_API_KEY_ID!)) throw new Error('Invalid APPLE_API_KEY_ID');
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(env.APPLE_API_ISSUER!)) {
    throw new Error('Invalid APPLE_API_ISSUER');
  }
  const keyPath = env.APPLE_API_KEY!;
  if (!isAbsolute(keyPath) || !keyPath.endsWith('.p8')) throw new Error('APPLE_API_KEY must be an absolute .p8 path');
  try {
    if (!statSync(keyPath).isFile()) throw new Error('not a file');
    accessSync(keyPath, constants.R_OK);
  } catch {
    throw new Error('APPLE_API_KEY must be an existing readable .p8 file');
  }
}
