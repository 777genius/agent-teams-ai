import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileHash } from './native-host.ts';

const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};

/** Follow the frozen Host dependency and its checked-in receipt, never a stale proof-only pin. */
export async function readNativeProviderArtifact(repo: string) {
  const manifest = object(JSON.parse(await readFile(join(repo, 'packages/legacy-agent-host/package.json'), 'utf8')));
  const dependency = object(manifest.dependencies)['@agent-teams/provider-implementations'];
  assert.ok(typeof dependency === 'string' &&
    /^file:\.\.\/\.\.\/vendor\/provider-migration\/[a-z0-9-]+\/agent-teams-provider-implementations-0\.0\.0\.tgz$/.test(dependency));
  const path = dependency.slice('file:../../'.length);
  const receipt = object(JSON.parse(await readFile(join(repo, dirname(path), 'source-receipt.json'), 'utf8')));
  const sha256 = object(object(receipt.packages)['provider-implementations']).newSha256;
  assert.ok(typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256));
  return { path, sha256 };
}

/** Check both archive identity and the actual JavaScript the native Host will import. */
export async function verifyNativeProviderArtifact(
  repo: string,
  selected?: { path: string; sha256: string }
): Promise<void> {
  selected ??= await readNativeProviderArtifact(repo);
  const archive = join(repo, selected.path);
  assert.equal(await fileHash(archive), selected.sha256);
  const providerRoot = await realpath(
    join(repo, 'packages/legacy-agent-host/node_modules/@agent-teams/provider-implementations')
  );
  const entries = execFileSync('/usr/bin/tar', ['-tf', archive], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter((path) => /^package\/dist\/.+\.js$/.test(path));
  assert.ok(entries.length > 0);
  for (const path of entries) {
    assert.ok(!path.includes('..'));
    assert.deepEqual(
      await readFile(join(providerRoot, path.slice('package/'.length))),
      execFileSync('/usr/bin/tar', ['-xOf', archive, path])
    );
  }
}

type SourceWindow = {
  offset: number; anchorOffset: number; bytes: number; sha256: string; excerpt: string;
};
type SourceAnchor = {
  anchor: string; matches: number; overflow: boolean;
  windows: SourceWindow[]; omittedWindows: number;
};
type SourceAuditFile = {
  kind: 'sdk' | 'declarations' | 'native';
  state: 'observed' | 'unavailable';
  sha256?: string; bytes?: number; reason?: string; anchors?: SourceAnchor[];
};

/** TEST-only source evidence, never a permission-support predicate or a native invocation. */
export async function auditPinnedClaudePermissionSource(options: {
  sdkVersion: '0.3.305';
  sdk: { path: string; sha256: string };
  native: { path: string; sha256: string };
  signal: AbortSignal;
}) {
  const specs = [
    { kind: 'sdk' as const, path: options.sdk.path, expected: options.sdk.sha256,
      cap: 16 * 1024 * 1024, anchors: ['permissionPrompts', 'hook_callback'] },
    { kind: 'declarations' as const, path: join(dirname(options.sdk.path), 'sdk.d.ts'),
      expected: undefined, cap: 16 * 1024 * 1024,
      anchors: ['permissionPrompts', 'PermissionRequestHookInput', 'HookCallback'] },
    { kind: 'native' as const, path: options.native.path, expected: options.native.sha256,
      cap: 1024 * 1024 * 1024, anchors: ['permissionPrompts', 'permission-prompts',
        'shouldAvoidPermissionPrompts', 'PermissionRequest', 'hook_callback'] },
  ];
  const reasons = ['aborted', 'unreadable', 'invalid-file', 'over-limit', 'changed-file',
    'pin-mismatch'] as const;
  const fail = (reason: typeof reasons[number]): never => { throw new Error(reason); };
  const active = () => { if (options.signal.aborted) fail('aborted'); };
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const reports: SourceAuditFile[] = [];
  for (const spec of specs) {
    let descriptor: Awaited<ReturnType<typeof open>> | undefined;
    try {
      active();
      const path = await realpath(spec.path);
      if (spec.kind === 'declarations' && path !== join(await realpath(dirname(options.sdk.path)), 'sdk.d.ts'))
        fail('invalid-file');
      const before = await lstat(path, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink()) fail('invalid-file');
      if (before.size < 1n || before.size > BigInt(spec.cap)) fail('over-limit');
      descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await descriptor.stat({ bigint: true });
      const sameFile = (value: typeof before) => value.isFile() && !value.isSymbolicLink() &&
        value.dev === before.dev && value.ino === before.ino && value.size === before.size &&
        value.mtimeNs === before.mtimeNs && value.ctimeNs === before.ctimeNs;
      if (!sameFile(opened)) fail('changed-file');
      const size = Number(before.size), digest = createHash('sha256');
      const needles = spec.anchors.map(anchor => ({
        anchor, bytes: Buffer.from(anchor), matches: 0, overflow: false, lastOffset: -1,
        windows: [] as { anchorOffset: number; offset: number; bytes?: Buffer }[],
      }));
      const carryLimit = 1024 + Math.max(...needles.map(needle => needle.bytes.length));
      const chunk = Buffer.alloc(64 * 1024);
      let offset = 0, carry: Buffer = Buffer.alloc(0);
      while (offset < size) {
        active();
        const read = await descriptor.read(chunk, 0, Math.min(chunk.length, size - offset), offset);
        if (!read.bytesRead) fail('changed-file');
        const bytes = chunk.subarray(0, read.bytesRead);
        digest.update(bytes);
        const block = Buffer.concat([carry, bytes]), blockOffset = offset - carry.length;
        const end = offset + read.bytesRead;
        for (const needle of needles) {
          if (!needle.overflow) {
            for (let at = block.indexOf(needle.bytes); at >= 0; at = block.indexOf(needle.bytes, at + 1)) {
              const found = blockOffset + at;
              if (found <= needle.lastOffset) continue;
              needle.lastOffset = found;
              needle.matches++;
              if (needle.matches > 64) { needle.overflow = true; break; }
              if (needle.windows.length < 2)
                needle.windows.push({ anchorOffset: found, offset: Math.max(0, found - 512) });
            }
          }
          for (const window of needle.windows) {
            if (window.bytes || (end < window.offset + 1024 && end !== size)) continue;
            if (window.offset < blockOffset) fail('changed-file');
            window.bytes = Buffer.from(block.subarray(
              window.offset - blockOffset, Math.min(window.offset + 1024, end) - blockOffset
            ));
          }
        }
        offset = end;
        carry = Buffer.from(block.subarray(Math.max(0, block.length - carryLimit)));
      }
      active();
      const extra = await descriptor.read(Buffer.alloc(1), 0, 1, size);
      const after = await descriptor.stat({ bigint: true }), final = await lstat(path, { bigint: true });
      if (extra.bytesRead || !sameFile(after) || !sameFile(final)) fail('changed-file');
      const sha256 = digest.digest('hex');
      if (spec.expected !== undefined && sha256 !== spec.expected) fail('pin-mismatch');
      await descriptor.close(); descriptor = undefined;
      reports.push({ kind: spec.kind, state: 'observed', sha256, bytes: size,
        anchors: needles.map(needle => ({
          anchor: needle.anchor, matches: needle.matches, overflow: needle.overflow,
          omittedWindows: Math.max(0, needle.matches - needle.windows.length),
          windows: needle.windows.map(window => {
            if (!window.bytes) return fail('changed-file');
            return { offset: window.offset, anchorOffset: window.anchorOffset,
              bytes: window.bytes.length, sha256: hash(window.bytes),
              excerpt: [...window.bytes].map(byte => byte >= 32 && byte <= 126
                ? String.fromCharCode(byte) : '\\x' + byte.toString(16).padStart(2, '0')).join('') };
          }),
        })) });
    } catch (error) {
      const candidate = error instanceof Error ? error.message : undefined;
      const reason = reasons.find(value => value === candidate) ?? 'unreadable';
      reports.push({ kind: spec.kind, state: 'unavailable', reason });
    } finally {
      if (descriptor) await descriptor.close().catch(() => undefined);
    }
  }
  const audit = { schemaVersion: 1, kind: 'pinned-claude-permission-source', sdkVersion: options.sdkVersion,
    qualification: 'unqualified', encoding: 'printable-ascii-with-escaped-bytes',
    files: reports };
  // Fixed metadata fits the cap; only complete, explicitly counted source windows are omitted.
  while (Buffer.byteLength(JSON.stringify(audit)) > 32 * 1024) {
    const anchor = reports.flatMap(file => file.anchors ?? []).reverse()
      .find(value => value.windows.length > 0);
    if (!anchor) throw new Error('TEST source audit metadata exceeded its fixed bound');
    anchor.windows.pop(); anchor.omittedWindows++;
  }
  return audit;
}
