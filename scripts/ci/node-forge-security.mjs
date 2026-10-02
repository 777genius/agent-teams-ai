// Temporary backport of digitalbazaar/forge#1152, commit ceba34402e329f0365134f23fe19898756527d65.
// Remove the patch and advisory exception together when a fixed upstream release is adopted.
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ADVISORY = 'GHSA-86w9-cpqp-85rv';
export const ORIGINAL_SHA = 'fd4740238145ec26470eb3f06a627c72039538ce1307dbdce40521f94dfd0a50';
export const PATCHED_SHA = 'acc22e5d36e27832c34e02dd3933aad7977d45b047eead5016520735efedc9c5';
const script = fileURLToPath(import.meta.url);
const sha = (source) => createHash('sha256').update(source).digest('hex');

export function verifyRsaBehavior(packageRoot) {
  const forge = createRequire(join(packageRoot, 'package.json'))(packageRoot);
  const fixture = JSON.parse(
    readFileSync(new URL('./node-forge-security-fixture.json', import.meta.url), 'utf8')
  );
  const n = new forge.jsbn.BigInteger(fixture.n, 16);
  const e = new forge.jsbn.BigInteger('3');
  const publicKey = forge.pki.rsa.setPublicKey(n, e);
  const digest = forge.md.sha256.create().update('hello world!');
  const valid = forge.pki.rsa
    .setPrivateKey(n, e, new forge.jsbn.BigInteger(fixture.d, 16))
    .sign(digest);
  if (publicKey.verify(digest.digest().getBytes(), valid) !== true) {
    throw new Error('node-forge rejected a valid RSA signature');
  }
  try {
    publicKey.verify(digest.digest().getBytes(), forge.util.hexToBytes(fixture.signature));
  } catch (error) {
    if (/does not contain a valid RSASSA-PKCS1-v1_5 DigestInfo/.test(error.message)) return;
    throw error;
  }
  throw new Error('node-forge accepted the forged nested DigestAlgorithm signature');
}

export function verifyForgePackage(packageRoot) {
  const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (
    metadata.name !== 'node-forge' ||
    metadata.version !== '1.4.0' ||
    metadata.main !== 'lib/index.js'
  ) {
    throw new Error(`Unsupported node-forge package at ${packageRoot}`);
  }
  if (sha(readFileSync(join(packageRoot, 'lib/rsa.js'))) !== PATCHED_SHA) {
    throw new Error(`Missing or unexpected node-forge security patch at ${packageRoot}`);
  }
  // Fresh process avoids proving a cached module instead of the current installed source.
  const result = spawnSync(process.execPath, [script, '--probe', packageRoot], {
    encoding: 'utf8',
    timeout: 10000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `node-forge RSA regression verification failed: ${result.error?.message ?? result.stderr}`
    );
  }
}

export function applyForgePatch(packageRoot) {
  const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (
    metadata.name !== 'node-forge' ||
    metadata.version !== '1.4.0' ||
    metadata.main !== 'lib/index.js'
  ) {
    throw new Error(`Unsupported node-forge package at ${packageRoot}`);
  }
  const target = join(packageRoot, 'lib/rsa.js');
  const source = readFileSync(target, 'utf8');
  if (sha(source) === PATCHED_SHA) {
    verifyForgePackage(packageRoot);
    return false;
  }
  if (sha(source) !== ORIGINAL_SHA) throw new Error(`Unexpected node-forge source at ${target}`);
  const updated = source
    .replace(
      '          // validate DigestInfo structure and element count\n',
      '          // validate DigestInfo structure and element counts (outer DigestInfo\n' +
        '          // and nested DigestAlgorithm). asn1.validate ignores extra children,\n' +
        '          // so length must be checked explicitly at each nesting level to\n' +
        '          // prevent low-exponent PKCS#1 v1.5 signature forgery (CVE-2026-85393).\n'
    )
    .replace(
      'obj.value.length !== 2) {',
      "obj.value.length !== 2 ||\n            obj.value[0].value.length !==\n              (('parameters' in capture) ? 2 : 1)) {"
    );
  if (sha(updated) !== PATCHED_SHA) throw new Error('node-forge backport hash mismatch');
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, updated, { flag: 'wx', mode: statSync(target).mode & 0o777 });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  verifyForgePackage(packageRoot);
  return true;
}

export function installedForgePackages(cwd) {
  const targets = new Set();
  const add = (candidate, required = false) => {
    if (existsSync(candidate)) targets.add(realpathSync(candidate));
    else if (required) throw new Error(`Missing installed node-forge package at ${candidate}`);
  };
  add(join(cwd, 'node_modules/node-forge'));
  // pnpm's transitive packages are not necessarily resolvable from the workspace root.
  for (const store of [join(cwd, 'node_modules/.pnpm'), join(cwd, 'node_modules/.store')]) {
    if (!existsSync(store)) continue;
    for (const entry of readdirSync(store)) {
      if (entry.startsWith('node-forge@')) add(join(store, entry, 'node_modules/node-forge'), true);
    }
  }
  const lock = join(cwd, 'package-lock.json');
  if (existsSync(lock)) {
    for (const path of Object.keys(JSON.parse(readFileSync(lock, 'utf8')).packages ?? {})) {
      if (path.endsWith('node_modules/node-forge')) add(join(cwd, path), true);
    }
  }
  if (targets.size === 0) throw new Error(`No installed node-forge package found in ${cwd}`);
  return [...targets];
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  try {
    if (process.argv[2] === '--probe') verifyRsaBehavior(resolve(process.argv[3]));
    else {
      if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--apply'))
        throw new Error('Usage: node node-forge-security.mjs [--apply]');
      const targets = installedForgePackages(process.cwd());
      for (const target of targets)
        process.argv[2] === '--apply' ? applyForgePatch(target) : verifyForgePackage(target);
      console.log(`Verified node-forge security backport in ${targets.length} package(s)`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
