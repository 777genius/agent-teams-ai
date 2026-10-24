// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { signAsync } from '@electron/osx-sign';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import signMacUap from '../../../scripts/electron-builder/signMacUap.ts';
import {
  refreshUapRuntimeDigest,
  verifyUapRuntimeDigest,
} from '../../../scripts/electron-builder/uapRuntimeIntegrity.ts';

vi.mock('@electron/osx-sign', () => ({ signAsync: vi.fn() }));

type SigningOptions = Parameters<typeof signAsync>[0];
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

function createRuntime(root: string, platform = 'darwin-x64') {
  mkdirSync(root, { recursive: true });
  const executable = platform.startsWith('win32-') ? 'agentplugins.exe' : 'agentplugins';
  const binary = path.join(root, executable);
  const manifest = path.join(root, 'runtime.json');
  writeFileSync(binary, 'unsigned helper fixture');
  writeFileSync(
    manifest,
    JSON.stringify({
      schemaVersion: 1,
      sourceSha: 'a'.repeat(40),
      platform,
      sha256: digest(readFileSync(binary)),
      executable,
    })
  );
  return { root, binary, manifest };
}

describe('UAP packaged runtime integrity', () => {
  let temporary: string;
  beforeEach(() => {
    temporary = mkdtempSync(path.join(os.tmpdir(), 'uap-signing-test-'));
    vi.mocked(signAsync).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(temporary, { recursive: true, force: true });
  });

  it('rejects changed binary bytes instead of silently updating runtime integrity', () => {
    const runtime = createRuntime(path.join(temporary, 'uap'));
    verifyUapRuntimeDigest(runtime.root);
    const originalManifest = readFileSync(runtime.manifest);
    writeFileSync(runtime.binary, 'modified bytes');
    expect(() => verifyUapRuntimeDigest(runtime.root)).toThrow('final binary checksum');
    expect(readFileSync(runtime.manifest)).toEqual(originalManifest);
  });

  it('publishes the final Windows signed-byte checksum without changing provenance', () => {
    const runtime = createRuntime(path.join(temporary, 'uap'), 'win32-x64');
    const original = JSON.parse(readFileSync(runtime.manifest, 'utf8'));
    writeFileSync(runtime.binary, 'fixture Authenticode bytes after resource copy');
    refreshUapRuntimeDigest(runtime.root);
    const current = JSON.parse(readFileSync(runtime.manifest, 'utf8'));
    expect(current).toEqual({ ...original, sha256: digest(readFileSync(runtime.binary)) });
    verifyUapRuntimeDigest(runtime.root);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a helper symlink outside its resource directory',
    () => {
      const runtime = createRuntime(path.join(temporary, 'uap'));
      const external = path.join(temporary, 'external');
      writeFileSync(external, readFileSync(runtime.binary));
      rmSync(runtime.binary);
      symlinkSync(external, runtime.binary);
      expect(() => refreshUapRuntimeDigest(runtime.root)).toThrow('outside');
    }
  );

  it('preserves signer options and refreshes only before the outer Mac app seal', async () => {
    const app = path.join(temporary, 'Fixture.app');
    const runtime = createRuntime(path.join(app, 'Contents', 'Resources', 'uap'));
    const originalManifest = readFileSync(runtime.manifest);
    const perFileOptions = {
      hardenedRuntime: true,
      entitlements: '/fixture/entitlements.plist',
    };
    const perFile = vi.fn(() => perFileOptions);
    const options: SigningOptions = {
      app,
      identity: 'fixture certificate',
      keychain: '/fixture/keychain',
      identityValidation: false,
      optionsForFile: perFile,
    };
    let sealedManifest: Buffer | undefined;
    vi.mocked(signAsync).mockImplementation(async (provided) => {
      expect(provided.identity).toBe(options.identity);
      expect(provided.keychain).toBe(options.keychain);
      expect(provided.identityValidation).toBe(false);
      expect(provided.optionsForFile?.(runtime.binary)).toEqual(perFileOptions);
      expect(readFileSync(runtime.manifest)).toEqual(originalManifest);
      writeFileSync(runtime.binary, 'signed nested helper');
      provided.optionsForFile?.(app);
      verifyUapRuntimeDigest(runtime.root);
      sealedManifest = readFileSync(runtime.manifest);
    });
    await signMacUap(options);
    expect(perFile.mock.calls).toEqual([[runtime.binary], [app]]);
    expect(readFileSync(runtime.manifest)).toEqual(sealedManifest);
  });

  it('retries partial signing with the existing bounded signer policy', async () => {
    vi.useFakeTimers();
    const app = path.join(temporary, 'Fixture.app');
    const runtime = createRuntime(path.join(app, 'Contents', 'Resources', 'uap'));
    vi.mocked(signAsync)
      .mockImplementationOnce(async () => {
        writeFileSync(runtime.binary, 'partially signed helper');
        throw new Error('transient signing failure');
      })
      .mockImplementationOnce(async (provided) => {
        writeFileSync(runtime.binary, 'fully signed helper');
        provided.optionsForFile?.(app);
      });
    const signing = signMacUap({ app });
    await vi.runAllTimersAsync();
    await signing;
    expect(signAsync).toHaveBeenCalledTimes(2);
    verifyUapRuntimeDigest(runtime.root);
  });

  it('fails if the signer never reaches the outer seal callback', async () => {
    const app = path.join(temporary, 'Fixture.app');
    createRuntime(path.join(app, 'Contents', 'Resources', 'uap'));
    vi.mocked(signAsync).mockResolvedValue(undefined);
    await expect(signMacUap({ app })).rejects.toThrow('outer app integrity checkpoint');
  });

  it('does not rewrite the manifest to hide a change after the outer seal', async () => {
    const app = path.join(temporary, 'Fixture.app');
    const runtime = createRuntime(path.join(app, 'Contents', 'Resources', 'uap'));
    let sealedManifest: Buffer | undefined;
    vi.mocked(signAsync).mockImplementation(async (provided) => {
      writeFileSync(runtime.binary, 'signed nested helper');
      provided.optionsForFile?.(app);
      sealedManifest = readFileSync(runtime.manifest);
      writeFileSync(runtime.binary, 'changed after app seal');
    });
    await expect(signMacUap({ app })).rejects.toThrow('final binary checksum');
    expect(readFileSync(runtime.manifest)).toEqual(sealedManifest);
  });

  it.skipIf(process.platform !== 'darwin')(
    'verifies actual ad-hoc Mac signatures and the sealed final helper checksum',
    async () => {
      const actual =
        await vi.importActual<typeof import('@electron/osx-sign')>('@electron/osx-sign');
      vi.mocked(signAsync).mockImplementation(actual.signAsync);
      const app = path.join(temporary, 'Fixture.app');
      const executableDir = path.join(app, 'Contents', 'MacOS');
      mkdirSync(executableDir, { recursive: true });
      const main = path.join(executableDir, 'Fixture');
      execFileSync('cc', ['-x', 'c', '-', '-o', main], { input: 'int main(void) { return 0; }\n' });
      // Apple arm64 linkers may add an ad-hoc signature by default. Start the
      // integrity fixture with genuinely unsigned bytes on either Mac architecture.
      const signature = spawnSync('codesign', ['--display', main], { stdio: 'pipe' });
      if (signature.error) throw signature.error;
      if (signature.status === 0) execFileSync('codesign', ['--remove-signature', main]);
      writeFileSync(
        path.join(app, 'Contents', 'Info.plist'),
        '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>ai.agentteams.uap-signing-fixture</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string></dict></plist>'
      );
      const runtime = createRuntime(
        path.join(app, 'Contents', 'Resources', 'uap'),
        `darwin-${process.arch}`
      );
      copyFileSync(main, runtime.binary);
      refreshUapRuntimeDigest(runtime.root);
      const unsigned = digest(readFileSync(runtime.binary));
      await signMacUap({
        app,
        platform: 'darwin',
        identity: '-',
        identityValidation: false,
        preAutoEntitlements: false,
        preEmbedProvisioningProfile: false,
        optionsForFile: () => ({ hardenedRuntime: false, entitlements: [] }),
      });
      expect(digest(readFileSync(runtime.binary))).not.toBe(unsigned);
      const sealedTime = statSync(runtime.manifest, { bigint: true }).mtimeNs;
      verifyUapRuntimeDigest(runtime.root);
      expect(statSync(runtime.manifest, { bigint: true }).mtimeNs).toBe(sealedTime);
      execFileSync('codesign', ['--verify', '--deep', '--strict', app]);
      execFileSync(runtime.binary);
    },
    60000
  );
});
