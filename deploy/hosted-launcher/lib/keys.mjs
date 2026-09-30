import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ensureDirectory, readRegularFile, sha256, syncDirectory } from './fsutil.mjs';

function describe(privateKey) {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
    throw new Error('hostedctl-launcher-key-not-ed25519');
  }
  return Object.freeze({ privateKey, publicKey: jwk.x,
    keyId: sha256(Buffer.from(jwk.x, 'base64url')) });
}

/**
 * Creates the long-lived launcher signing key once. Product pins its public half in the release
 * pin; losing it means reissuing the pin, which `install owner` does.
 */
export async function createLauncherKey(path) {
  await ensureDirectory(dirname(path), { mode: 0o700 });
  const { privateKey } = generateKeyPairSync('ed25519');
  const handle = await open(path, 'wx', 0o400);
  try {
    await handle.writeFile(privateKey.export({ format: 'pem', type: 'pkcs8' }));
    await handle.chown(0, 0);
    await handle.chmod(0o400);
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(dirname(path));
  return describe(privateKey);
}

export async function loadLauncherKey(path) {
  const pem = await readRegularFile(path, { maxBytes: 4096, uid: 0, mode: 0o400 });
  return describe(createPrivateKey(pem));
}
