import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { verifyBrokerArchitecture } from '../../scripts/build/buildOwnedProcessBroker';

const version = '0.3.305';
const integrities = {
  x64: 'sha512-SI5PwkQsCF+HcW0KCA9dXKDX4q8LPebTGLGmsXXQvXChsqrrsVOKRM5TXuqRxxtLlg5Bvar+AbgzBFCSeaJAog==',
  arm64: 'sha512-lpH23fhToQybIL5ihzPRwWwhj8ajilcR+ePscopr7zK4UlLJZYUGod7UrKtEtXcAYSXh4KemLZgg7wyc7G7kxA==',
} as const;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Read selected regular bytes only; never unpack archive paths into a filesystem. */
function selectFiles(archive: Buffer): { executable: Buffer; member: string; manifest: Record<string, unknown> } {
  const files: { executable: Buffer; member: string }[] = [];
  let manifest: Record<string, unknown> | undefined;
  const string = (bytes: Buffer) => bytes.toString('utf8').split('\0', 1)[0]!;
  let offset = 0;
  for (; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const prefix = string(header.subarray(345, 500));
    const member = (prefix ? prefix + '/' : '') + string(header.subarray(0, 100));
    const encodedSize = string(header.subarray(124, 136)).trim();
    assert.match(encodedSize, /^[0-7]+$/);
    const size = Number.parseInt(encodedSize, 8);
    const start = offset + 512;
    assert.ok(Number.isSafeInteger(size) && size >= 0 && start + size <= archive.length);
    const selected = member === 'package/package.json' ||
      member === 'package/claude.exe' || member === 'package/bin/claude.exe';
    if (selected) {
      assert.ok(header[156] === 0 || header[156] === 48, 'Only a regular selected archive member');
      const bytes = archive.subarray(start, start + size);
      if (member === 'package/package.json') {
        assert.ok(!manifest && size <= 64 * 1024);
        manifest = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      } else files.push({ executable: bytes, member });
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  assert.ok(offset + 512 <= archive.length, 'Bounded complete tar termination');
  assert.equal(files.length, 1, 'One official native executable, no guessed PATH fallback');
  assert.ok(manifest);
  return { ...files[0]!, manifest };
}

export async function prepareNativeVendorInputs(destination: string, bashPath: string): Promise<void> {
  assert.equal(process.env.OWNED_PROCESS_VENDOR_TEST_GO, '1');
  assert.equal(process.platform, 'win32');
  assert.ok(process.arch === 'x64' || process.arch === 'arm64');
  const arch = process.arch, integrity = integrities[arch];
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const lock = readFileSync(join(repository, 'pnpm-lock.yaml'), 'utf8');
  const packageName = '@anthropic-ai/claude-agent-sdk-win32-' + arch;
  assert.ok(lock.includes("'" + packageName + '@' + version + "':\n    resolution: {integrity: " + integrity + '}'),
    'Selected official integrity is still in the exact frozen repository lock');
  const bash = realpathSync(bashPath), bashBytes = readFileSync(bash);
  assert.ok(/\\bash\.exe$/i.test(bash) && bashBytes.length > 64);
  const root = resolve(destination);
  mkdirSync(root); // A new explicit TEST directory; never replace a previous proof.
  const url = 'https://registry.npmjs.org/' + packageName + '/-/claude-agent-sdk-win32-' + arch + '-' + version + '.tgz';
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  assert.ok(response.ok && response.body, 'Official pinned native archive is available');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    assert.ok(length <= 256 * 1024 * 1024, 'Bounded native download');
    chunks.push(chunk);
  }
  const compressed = Buffer.concat(chunks);
  assert.equal('sha512-' + createHash('sha512').update(compressed).digest('base64'), integrity);
  const selected = selectFiles(gunzipSync(compressed, { maxOutputLength: 512 * 1024 * 1024 }));
  assert.equal(selected.manifest.name, packageName);
  assert.equal(selected.manifest.version, version);
  verifyBrokerArchitecture(selected.executable, arch);
  const executable = join(root, 'claude.exe');
  writeFileSync(executable, selected.executable, { flag: 'wx' });
  const receipt = { schemaVersion: 1, testOnly: true, platform: 'win32-' + arch,
    packageName, version, integrity, url, archiveSha256: digest(compressed), member: selected.member,
    executable: { path: realpathSync(executable), sha256: digest(selected.executable) },
    bash: { path: bash, sha256: digest(bashBytes) } };
  assert.equal(digest(readFileSync(executable)), receipt.executable.sha256);
  writeFileSync(join(root, 'selection.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(receipt));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [destination, bash] = process.argv.slice(2);
  assert.ok(destination && bash);
  await prepareNativeVendorInputs(destination, bash);
}
