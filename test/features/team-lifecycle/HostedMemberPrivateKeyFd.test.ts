import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { closeSync, fstatSync, mkdtempSync, openSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHostedMemberPrivateKeyFdProvider } from '@features/team-lifecycle/main/adapters/output/orchestrator/hostedMemberPrivateKeyFd';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const descriptors: number[] = [];
afterEach(() => {
  for (const fd of descriptors.splice(0)) {
    try { closeSync(fd); } catch { /* provider owns successful closes */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const key = createPrivateKey({
  key: Buffer.from('302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc4' +
    '4449c5697b326919703bac031cae7f60', 'hex'),
  format: 'der', type: 'pkcs8',
});
const der = key.export({ format: 'der', type: 'pkcs8' }) as Buffer;
const pin = createHash('sha256').update(createPublicKey(key).export({ format: 'der', type: 'spki' })).digest('hex');

function unlinkedFd(bytes: Buffer, mode = 0o600): number {
  const root = mkdtempSync(join(tmpdir(), 'member-key-fd-'));
  roots.push(root);
  const file = join(root, 'ephemeral.pk8');
  writeFileSync(file, bytes, { mode });
  const fd = openSync(file, 'r');
  descriptors.push(fd);
  unlinkSync(file);
  return fd;
}

describe('Product member private key FD custody', () => {
  it('disposes an unused inherited FD after an admission is rejected before key load', async () => {
    const fd = unlinkedFd(der);
    const provider = createHostedMemberPrivateKeyFdProvider({ fd, spkiSha256: pin });
    provider.dispose();
    expect(() => fstatSync(fd)).toThrow();
    await expect(provider.loadPrivateKey()).rejects.toThrow('member-admission-key-fd-consumed');
  });

  it('supports a fixed inherited FD without passing key bytes in argv or env', () => {
    const fd = unlinkedFd(der);
    const child = spawnSync(process.execPath, ['-e',
      "const fs=require('node:fs');const s=fs.fstatSync(3);const b=Buffer.alloc(s.size);fs.readSync(3,b,0,b.length,0);process.stdout.write(String(s.nlink)+':'+require('node:crypto').createHash('sha256').update(b).digest('hex'))",
    ], { stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8' });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe(`0:${createHash('sha256').update(der).digest('hex')}`);
    expect(child.stderr).toBe('');
  });

  it('loads a matching Ed25519 PKCS8 key from an unlinked inherited-style FD and closes it', async () => {
    const fd = unlinkedFd(der);
    const provider = createHostedMemberPrivateKeyFdProvider({ fd, spkiSha256: pin });
    const loaded = await provider.loadPrivateKey();
    expect(loaded.asymmetricKeyType).toBe('ed25519');
    expect(loaded.export({ format: 'der', type: 'pkcs8' })).toEqual(der);
    expect(() => fstatSync(fd)).toThrow();
    expect(await provider.loadPrivateKey()).toBe(loaded);
  });

  it('rejects a different Ed25519 key even when its DER is well formed', async () => {
    const other = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    const fd = unlinkedFd(other);
    const provider = createHostedMemberPrivateKeyFdProvider({ fd, spkiSha256: pin });
    await expect(provider.loadPrivateKey()).rejects.toThrow('member-admission-key-pin-mismatch');
    expect(() => fstatSync(fd)).toThrow();
  });

  it('rejects stdin, a linked file, public permissions, and oversized bytes', async () => {
    expect(() => createHostedMemberPrivateKeyFdProvider({ fd: 0, spkiSha256: pin }))
      .toThrow('member-admission-key-fd-invalid');
    const linkedRoot = mkdtempSync(join(tmpdir(), 'linked-member-key-'));
    roots.push(linkedRoot);
    const linkedPath = join(linkedRoot, 'key.pk8');
    writeFileSync(linkedPath, der, { mode: 0o600 });
    const linkedFd = openSync(linkedPath, 'r');
    descriptors.push(linkedFd);
    await expect(createHostedMemberPrivateKeyFdProvider({ fd: linkedFd, spkiSha256: pin })
      .loadPrivateKey()).rejects.toThrow('member-admission-key-fd-unsafe');
    expect(() => fstatSync(linkedFd)).toThrow();
    const permissive = unlinkedFd(der, 0o644);
    await expect(createHostedMemberPrivateKeyFdProvider({ fd: permissive, spkiSha256: pin })
      .loadPrivateKey()).rejects.toThrow('member-admission-key-fd-unsafe');
    const oversized = unlinkedFd(Buffer.alloc(4097, 1));
    await expect(createHostedMemberPrivateKeyFdProvider({ fd: oversized, spkiSha256: pin })
      .loadPrivateKey()).rejects.toThrow('member-admission-key-size-invalid');
  });

  it('rejects malformed and non-Ed25519 material without echoing key bytes', async () => {
    const malformed = unlinkedFd(Buffer.from('secret sentinel value'));
    const provider = createHostedMemberPrivateKeyFdProvider({ fd: malformed, spkiSha256: pin });
    await expect(provider.loadPrivateKey()).rejects.toThrow('member-admission-key-invalid');
    await expect(provider.loadPrivateKey()).rejects.toThrow('member-admission-key-fd-consumed');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
      .export({ format: 'der', type: 'pkcs8' }) as Buffer;
    const rsaFd = unlinkedFd(rsa);
    await expect(createHostedMemberPrivateKeyFdProvider({ fd: rsaFd, spkiSha256: pin })
      .loadPrivateKey()).rejects.toThrow('member-admission-key-invalid');
  });
});
