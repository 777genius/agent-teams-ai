import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { verifyBrokerArchitecture } from '../../scripts/build/buildOwnedProcessBroker';
import { assertSafeRuntimeZip } from '../../scripts/lib/runtime-archive-extraction.mts';
import { extractWindowsRuntimeZip } from '../../scripts/lib/runtime-windows-zip-extraction.mts';

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
  const lock = readFileSync(join(repository, 'pnpm-lock.yaml'), 'utf8').replace(/\r\n/g, '\n');
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

type Provider = 'codex' | 'opencode-v1';
const providerInputs = {
  codex: {
    version: '0.162.0', tag: 'https://github.com/openai/codex/releases/download/rust-v0.162.0/',
    x64: { asset: 'codex-x86_64-pc-windows-msvc.exe.tar.gz',
      bytes: 111636000, sha256: '38a0fa27656ec23b9faa7d91ec84d8d8a6895ebf8616e872399949db44c55ba6',
      executable: 'dce685d569526ef4712fa82d20ff20e1309baad5fcd34215e1126698f611242f' },
    arm64: { asset: 'codex-aarch64-pc-windows-msvc.exe.tar.gz',
      bytes: 102346096, sha256: 'e661c0ce6ff3a39eb63608c98116bf12abb1399e7b9fdb0b350d1a1de6114bf8',
      executable: 'd5d233fa93a8ea6ff856cdc2146eb216121144c2fed5568f5dea7ee47cb409f1' },
  },
  'opencode-v1': {
    version: '1.19.4', tag: 'https://github.com/anomalyco/opencode/releases/download/v1.19.4/',
    x64: { asset: 'opencode-windows-x64.zip', bytes: 81744896,
      sha256: '93b899277bd6f68803009e32bf71772ce43c34b18adf1e93b9b4d8780fdf62e5' },
    arm64: { asset: 'opencode-windows-arm64.zip', bytes: 75791921,
      sha256: '36e696fd1d275b469ab02a1ccc00d161bfdcc0a4ffa93c2b7a4e57399f3ff347' },
  },
} as const;

/** Select only the exact official regular PE bytes. No tar member path is an output path. */
function selectCodex(archive: Buffer, expected: string) {
  let offset = 0;
  const matches: { executable: Buffer; member: string }[] = [];
  const text = (bytes: Buffer) => bytes.toString('utf8').split('\0', 1)[0]!;
  for (; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) break;
    const sizeText = text(header.subarray(124, 136)).trim(), checksumText = text(header.subarray(148, 156)).trim();
    assert.match(sizeText, /^[0-7]+$/); assert.match(checksumText, /^[0-7]+$/);
    const size = Number.parseInt(sizeText, 8), start = offset + 512;
    assert.ok(Number.isSafeInteger(size) && size >= 0 && start + size <= archive.length);
    const checksum = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
    assert.equal(checksum, Number.parseInt(checksumText, 8));
    const bytes = archive.subarray(start, start + size);
    if (digest(bytes) === expected) {
      assert.ok(header[156] === 0 || header[156] === 48, 'Official selected executable is regular');
      const prefix = text(header.subarray(345, 500));
      matches.push({ executable: bytes, member: (prefix ? prefix + '/' : '') + text(header.subarray(0, 100)) });
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  assert.ok(offset + 512 <= archive.length, 'Complete bounded official tar');
  assert.equal(matches.length, 1, 'One exact official Codex executable');
  return matches[0]!;
}

export async function prepareNativeProviderInputs(destination: string, bashPath: string, provider: Provider) {
  assert.equal(process.env.OWNED_PROCESS_VENDOR_TEST_GO, '1');
  assert.equal(process.platform, 'win32'); assert.ok(process.arch === 'x64' || process.arch === 'arm64');
  const arch = process.arch, recipe = providerInputs[provider], asset = recipe[arch];
  const bash = realpathSync(bashPath), bashBytes = readFileSync(bash);
  assert.ok(/\\bash\.exe$/i.test(bash) && bashBytes.length > 64);
  const root = resolve(destination); mkdirSync(root);
  const url = recipe.tag + asset.asset;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  assert.ok(response.ok && response.body, 'Official pinned native provider archive');
  const chunks: Uint8Array[] = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    assert.ok(length <= 256 * 1024 * 1024, 'Original compressed input ceiling'); chunks.push(chunk);
  }
  const compressed = Buffer.concat(chunks);
  assert.equal(compressed.length, asset.bytes); assert.equal(digest(compressed), asset.sha256);
  let selected: { executable: Buffer; member: string };
  if (provider === 'codex') {
    selected = selectCodex(gunzipSync(compressed, { maxOutputLength: 512 * 1024 * 1024 }),
      providerInputs.codex[arch].executable);
  } else {
    const archivePath = join(root, 'official-opencode.zip'), destination = join(root, 'official-extracted');
    writeFileSync(archivePath, compressed, { flag: 'wx' });
    const entries = assertSafeRuntimeZip(archivePath);
    assert.ok(entries.reduce((sum, entry) => sum + entry.size, 0) <= 512 * 1024 * 1024);
    const binaries = entries.filter(entry => !entry.directory && basename(entry.name).toLowerCase() === 'opencode.exe');
    assert.equal(binaries.length, 1, 'One validated official OpenCode executable');
    mkdirSync(destination);
    extractWindowsRuntimeZip(archivePath, destination, entries, process.env, (command, args, options) => {
      const result = spawnSync(command, args, { ...options, timeout: 60_000 });
      assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0);
    });
    const member = binaries[0]!.name, path = join(destination, member), stat = lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size === binaries[0]!.size);
    assert.equal(realpathSync(path), path);
    selected = { executable: readFileSync(path), member };
    assert.equal(digest(readFileSync(archivePath)), asset.sha256);
  }
  verifyBrokerArchitecture(selected.executable, arch);
  const executable = join(root, provider === 'codex' ? 'codex.exe' : 'opencode.exe');
  writeFileSync(executable, selected.executable, { flag: 'wx' });
  const receipt = { schemaVersion: 1, testOnly: true, provider, platform: 'win32-' + arch,
    version: recipe.version, integrity: 'sha256-' + asset.sha256, url,
    archiveSha256: asset.sha256, archiveBytes: asset.bytes, member: selected.member,
    executable: { path: realpathSync(executable), sha256: digest(selected.executable) },
    bash: { path: bash, sha256: digest(bashBytes) } };
  assert.equal(digest(readFileSync(executable)), receipt.executable.sha256);
  writeFileSync(join(root, 'selection.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(receipt));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [destination, bash, provider] = process.argv.slice(2);
  assert.ok(destination && bash);
  if (provider === undefined) await prepareNativeVendorInputs(destination, bash);
  else {
    assert.ok(provider === 'codex' || provider === 'opencode-v1');
    await prepareNativeProviderInputs(destination, bash, provider);
  }
}
