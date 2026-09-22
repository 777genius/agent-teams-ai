import { chmod, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { descriptorMountId, openFileAnchor, openRootAnchor } from '../../../../scripts/e2e/hosted-actual-owner/anchors';
import { canonicalJson, OPENCODE_IDENTITIES, sha256 } from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import { revalidateBeforeExecution } from '../../../../scripts/e2e/hosted-actual-owner/driver';
import { OWNER_V2_ARGV } from '../../../../scripts/e2e/hosted-actual-owner/owner-child-protocol';
import { selectedOwnerImages, verifyP3B2Recipe } from '../../../../scripts/e2e/hosted-actual-owner/owner-recipe';
import { closureDigestForTest, verifyClosure } from '../../../../scripts/e2e/hosted-actual-owner/secure-files';

import type { FileAnchor, RootAnchor } from '../../../../scripts/e2e/hosted-actual-owner/anchors';
import type { ClosurePin, FilePin, IntegrationDescriptor } from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import type { PreflightAdmission } from '../../../../scripts/e2e/hosted-actual-owner/preflight';
import type { DisposableSandbox } from '../../../../scripts/e2e/hosted-actual-owner/sandbox';
import type { ClosureEntry, WrittenFileEvidence } from '../../../../scripts/e2e/hosted-actual-owner/secure-files';

// Exercise the actual driver revalidation and real Owner filesystem checks. Only unrelated
// sandbox/authorization/OpenCode and other closure lanes are substituted; nothing is launched.
vi.mock('../../../../scripts/e2e/hosted-actual-owner/sandbox', () => ({ assertSandboxCurrent: vi.fn() }));
vi.mock('../../../../scripts/e2e/hosted-actual-owner/preflight', () => ({ assertOneRunAuthorizationConsumed: vi.fn() }));
vi.mock('../../../../scripts/e2e/hosted-actual-owner/contracts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../scripts/e2e/hosted-actual-owner/contracts')>();
  return { ...actual, OPENCODE_IDENTITIES: { ...actual.OPENCODE_IDENTITIES,
    linuxX64BinarySha256: actual.sha256('test-only-opencode') } };
});
vi.mock('../../../../scripts/e2e/hosted-actual-owner/secure-files', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../scripts/e2e/hosted-actual-owner/secure-files')>();
  return { ...actual,
    readStable: (file: FileAnchor) => file === undefined ? Promise.resolve(Buffer.from('test-only-opencode')) : actual.readStable(file),
    verifyClosure: (root: RootAnchor, pin: ClosurePin, images: readonly FilePin[] = []) =>
      root === undefined ? Promise.resolve({ merkleRoot: 'other-lane' }) : actual.verifyClosure(root, pin, images),
  };
});

async function packagedClosure() {
  const path = await mkdtemp(join(tmpdir(), 'r962-descriptor-admission-'));
  const anchors: FileAnchor[] = [];
  let root: RootAnchor | undefined;
  const close = async () => {
    await Promise.allSettled(anchors.map(a => a.handle.close()));
    await root?.handle.close();
    await rm(path, { recursive: true, force: true });
  };
  try {
    await chmod(path, 0o700);
    const entries: ClosureEntry[] = [];
    const put = async (relativePath: string, content: string, mode: ClosureEntry['mode']): Promise<FilePin> => {
      await writeFile(join(path, relativePath), content, { flag: 'wx', mode });
      await chmod(join(path, relativePath), mode);
      const handle = await open(join(path, relativePath), 'r');
      try {
        const stat = await handle.stat({ bigint: true });
        const digest = sha256(content);
        entries.push({ path: relativePath, mode, size: Number(stat.size), sha256: digest });
        return { root: 'p3b2', relativePath, mode, size: Number(stat.size), sha256: digest,
          device: String(stat.dev), inode: String(stat.ino), nlink: 1 };
      } finally { await handle.close(); }
    };
    await put('.test-owned', 'r962 sandbox fixture\n', 0o444);
    const entry = await put('owner.ts', 'export {};\n', 0o444);
    const supervisor = await put('supervisor', 'test supervisor\n', 0o555);
    const executable = await put('bun', 'test source image\n', 0o500);
    const helper = await put('helper', 'test helper image\n', 0o500);
    const sourceBaseCommit = 'a'.repeat(40), resultCommit = 'b'.repeat(40);
    // Ordinary packaging order: immutable recipe, complete manifest/root, external freeze tuple.
    const recipeValue = { schemaVersion: 2, purpose: 'agent-teams.p3b2.source-actual-owner-entry/v2',
      sourceBaseCommit, resultCommit, entry: { relativePath: entry.relativePath, sha256: entry.sha256 },
      supervisor: { relativePath: supervisor.relativePath, sha256: supervisor.sha256 },
      candidateOpenCodeSha256: OPENCODE_IDENTITIES.linuxX64BinarySha256,
      argv: ['run', '/p3b2/owner.ts', ...OWNER_V2_ARGV], sourceTreeRequired: true, accepted: true,
      sourceInvocation: { format: 'agent-teams.hosted-owner-source-invocation/v1', executable,
        module: { path: '/p3b2/owner.ts', sha256: entry.sha256 } }, launchHelper: helper };
    const bytes = Buffer.from(canonicalJson(recipeValue));
    const recipe = await put('recipe.json', bytes.toString(), 0o444);
    entries.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
    const manifestBytes = Buffer.from(canonicalJson(entries));
    // The sole exclusion is the manifest itself, never the recipe or any source/image file.
    await writeFile(join(path, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o400 });
    await chmod(join(path, 'manifest.json'), 0o400);
    const manifestHandle = await open(join(path, 'manifest.json'), 'r');
    let manifest: FilePin;
    try {
      const s = await manifestHandle.stat({ bigint: true });
      manifest = { root: 'p3b2', relativePath: 'manifest.json', sha256: sha256(manifestBytes), mode: 0o400,
        device: String(s.dev), inode: String(s.ino), size: Number(s.size), nlink: 1 };
    } finally { await manifestHandle.close(); }
    const directory = await open(path, 'r');
    try {
      const s = await directory.stat({ bigint: true });
      root = await openRootAnchor('p3b2', { path, device: String(s.dev), inode: String(s.ino),
        mountId: await descriptorMountId(directory), mode: 0o700 });
    } finally { await directory.close(); }
    const closure = { manifest, manifestSha256: manifest.sha256, merkleRoot: closureDigestForTest(entries),
      fileCount: entries.length, totalBytes: entries.reduce((sum, e) => sum + e.size, 0) };
    const descriptor = { p3b2: { sourceBaseCommit, resultCommit, entry, supervisor, recipe,
      recipeSha256: recipe.sha256, closure }, openCode: { linuxX64Binary: { sha256: OPENCODE_IDENTITIES.linuxX64BinarySha256 },
      identities: OPENCODE_IDENTITIES }, product: {}, toolchain: {} } as unknown as IntegrationDescriptor;
    const selection = verifyP3B2Recipe(bytes, descriptor)!;
    const evidence = await verifyClosure(root, closure, selectedOwnerImages(selection));
    for (const pin of [executable, helper]) anchors.push(await openFileAnchor(root, pin));
    const other = { merkleRoot: 'other-lane' };
    const admission = { descriptor, roots: { p3b2: root }, execution: {},
      ownerLaunch: { selection, executable: anchors[0], helper: anchors[1] },
      closures: { p3b2: evidence, harness: other, toolchain: other, productRuntime: other, browserBundle: other },
    } as unknown as PreflightAdmission;
    const revalidate = (value = admission) => revalidateBeforeExecution(value, {} as DisposableSandbox, {} as WrittenFileEvidence);
    return { path, root, bytes, recipeValue, descriptor, selection, evidence, admission, revalidate, close };
  } catch (error) { await close(); throw error; }
}

describe('r945 descriptor admission repairs', () => {
  it('packages a recipe-containing complete closure and passes actual driver revalidation with both selected 0500 pins', async () => {
    const f = await packagedClosure();
    try {
      expect(f.evidence.entries.map(e => e.path)).toEqual(['.test-owned', 'bun', 'helper', 'owner.ts', 'recipe.json', 'supervisor']);
      expect(f.evidence.entries.find(e => e.path === 'recipe.json')?.sha256).toBe(sha256(f.bytes));
      await expect(f.revalidate()).resolves.toBeUndefined();
      await expect(f.revalidate({ ...f.admission, ownerLaunch: undefined })).rejects.toThrow('p3c_closure_entry_value');
      for (const key of ['executable', 'helper'] as const) {
        const selection = { ...f.selection, [key]: { ...f.selection[key], inode: '999999999' } };
        await expect(f.revalidate({ ...f.admission, ownerLaunch: { ...f.admission.ownerLaunch!, selection } }))
          .rejects.toThrow('p3c_anchor_file_pin');
      }
    } finally { await f.close(); }
  });

  it.each([0o4500, 0o2500])('rejects special mode %i at initial anchor/closure admission and driver revalidation', async mode => {
    const f = await packagedClosure();
    try {
      for (const pin of selectedOwnerImages(f.selection)) {
        await chmod(join(f.path, pin.relativePath), mode);
        await expect(openFileAnchor(f.root, pin)).rejects.toThrow('p3c_anchor_file_pin');
        await expect(verifyClosure(f.root, f.descriptor.p3b2.closure, selectedOwnerImages(f.selection)))
          .rejects.toThrow('p3c_closure_file_metadata');
        await expect(f.revalidate()).rejects.toThrow('p3c_anchor_file_no_longer_current');
        await chmod(join(f.path, pin.relativePath), 0o500);
      }
    } finally { await f.close(); }
  });

  it.each(['recipe.json', 'owner.ts', 'bun', 'helper'])('rejects post-admission mutation of %s', async name => {
    const f = await packagedClosure();
    try {
      const mode = name === 'bun' || name === 'helper' ? 0o500 : 0o444;
      await chmod(join(f.path, name), 0o600);
      await writeFile(join(f.path, name), 'mutated bytes\n');
      await chmod(join(f.path, name), mode);
      await expect(f.revalidate()).rejects.toThrow();
    } finally { await f.close(); }
  });

  it('rejects an otherwise rehashed manifest that omits the recipe', async () => {
    const f = await packagedClosure();
    try {
      const entries = f.evidence.entries.filter(e => e.path !== 'recipe.json');
      const bytes = Buffer.from(canonicalJson(entries));
      await chmod(join(f.path, 'manifest.json'), 0o600);
      await writeFile(join(f.path, 'manifest.json'), bytes);
      await chmod(join(f.path, 'manifest.json'), 0o400);
      const closure = { ...f.descriptor.p3b2.closure,
        manifest: { ...f.descriptor.p3b2.closure.manifest, sha256: sha256(bytes), size: bytes.length },
        manifestSha256: sha256(bytes), merkleRoot: closureDigestForTest(entries), fileCount: entries.length,
        totalBytes: entries.reduce((sum, e) => sum + e.size, 0) };
      await expect(verifyClosure(f.root, closure, selectedOwnerImages(f.selection)))
        .rejects.toThrow('p3c_closure_disagreement');
    } finally { await f.close(); }
  });

  it('rejects recipe substitution, old circular schema, changed closure root and incomplete enumeration', async () => {
    const f = await packagedClosure();
    try {
      const changed = Buffer.from(canonicalJson({ ...f.recipeValue, accepted: false }));
      expect(() => verifyP3B2Recipe(changed, f.descriptor)).toThrow('version_digest');
      const circular = Buffer.from(canonicalJson({ ...f.recipeValue, closureMerkleRoot: f.evidence.merkleRoot }));
      expect(() => verifyP3B2Recipe(circular, f.descriptor)).toThrow();
      await expect(f.revalidate({ ...f.admission, descriptor: { ...f.descriptor, p3b2: { ...f.descriptor.p3b2,
        closure: { ...f.descriptor.p3b2.closure, merkleRoot: '0'.repeat(64) } } } })).rejects.toThrow('p3c_closure_disagreement');
      await writeFile(join(f.path, 'unlisted.ts'), 'export {};\n', { flag: 'wx', mode: 0o444 });
      await chmod(join(f.path, 'unlisted.ts'), 0o444);
      await expect(f.revalidate()).rejects.toThrow('p3c_closure_disagreement');
    } finally { await f.close(); }
  });
});
