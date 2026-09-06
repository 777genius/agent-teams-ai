import { chmod, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { descriptorMountId, openRootAnchor } from '../../../../scripts/e2e/hosted-actual-owner/anchors';
import { legacyOwnerChildPlan, OWNER_V2_ARGV,ownerChildPlanV2 } from '../../../../scripts/e2e/hosted-actual-owner/owner-child-protocol';
import { assertOwnerDescriptorCaptureBindings,parseOwnerChildDescriptorCleanup, parseOwnerLaunchEnvelope } from '../../../../scripts/e2e/hosted-actual-owner/owner-descriptor-cleanup';
import { parseOwnerDescriptorMapV2, parseOwnerLaunchEvidenceV2 } from '../../../../scripts/e2e/hosted-actual-owner/owner-descriptor-v2';
import { assertOwnerPlanV2, assertSelectedSupervisorTranscript, selectOwnerPlan } from '../../../../scripts/e2e/hosted-actual-owner/owner-plan';
import { verifyP3B2Recipe } from '../../../../scripts/e2e/hosted-actual-owner/owner-recipe';
import { parseSupervisorTranscript, type SupervisorOutcome } from '../../../../scripts/e2e/hosted-actual-owner/processes';
import { closureDigestForTest, type ClosureEntry,verifyClosure } from '../../../../scripts/e2e/hosted-actual-owner/secure-files';
import { canonicalJson, sha256 } from '../../../../scripts/e2e/hosted-actual-owner/supervisor/canonical';

import { fixture, hex } from './owner-descriptor-v2.fixtures';

import type { FilePin, IntegrationDescriptor } from '../../../../scripts/e2e/hosted-actual-owner/contracts';
import type { PreflightAdmission } from '../../../../scripts/e2e/hosted-actual-owner/preflight';

const joined = (f = fixture()) => parseOwnerChildDescriptorCleanup({ schemaVersion: 3,
  contract: 'agent-teams.hosted-owner-child-parent-fd-cleanup/v3', records: [f.evidence.parentCleanup] }, [f.context.owner], {
  plan: f.context.plan, supervisor: f.context.supervisor,
  filesystem: { pidNamespaceInode: f.context.pidNamespaceInode } as SupervisorOutcome['filesystem'],
  network: { namespaceInode: f.context.networkNamespaceInode } as SupervisorOutcome['network'], launches: [f.evidence],
});

describe('Product v2 native descriptor evidence (structural, non-qualifying)', () => {
  it('joins distinct parent/child tokens and arbitrary parent numbers to the actual eight roles', () => {
    const f = fixture(), accepted = parseOwnerLaunchEvidenceV2(f.evidence, f.context);
    expect(accepted.parentCleanup.wrapperPid).not.toBe(accepted.parentCleanup.ownerPid);
    expect(accepted.parentCleanup.wrapperStartToken).not.toBe(accepted.parentCleanup.ownerProcessStartToken);
    expect(accepted.parentCleanup.descriptors.map(d => d.parentFd)).toEqual([41, 27, 63, 39, 52, 70, 74, 81]);
    expect(accepted.descriptorMap.descriptors.map(d => d.childFd)).toEqual([3, 4, 5, 6, 7, 8, 9, 11]);
    expect(joined(f).ownerStartTokens).toEqual([f.context.owner.startToken]);
  });
  const mutations: [string, (f: ReturnType<typeof fixture>) => void][] = [
    ['wrong parent', f => { f.evidence.parentCleanup.wrapperPid++; }],
    ['wrong child', f => { f.evidence.parentCleanup.ownerPid++; }],
    ['wrong child start', f => { f.context.owner = { ...f.context.owner, startTime: '13' }; }],
    ['wrong child token', f => { f.evidence.parentCleanup.ownerProcessStartToken = hex(55); }],
    ['child token conflated with wrapper', f => { f.context.owner = { ...f.context.owner, startToken: f.evidence.parentCleanup.wrapperStartToken };
      f.evidence.ownerProcessStartToken = f.context.owner.startToken; f.evidence.parentCleanup.ownerProcessStartToken = f.context.owner.startToken; }],
    ['wrong nonce', f => { f.evidence.parentCleanup.spawnNonce = hex(55); }],
    ['wrong boundary', f => { f.evidence.parentCleanup.spawnBoundaryMonotonicNs = '201'; }],
    ['wrapper observation replacement', f => { f.evidence.wrapperObservation.startTicks = '99'; }],
    ['wrong actual helper image', f => { f.evidence.wrapperObservation.executable.sha256 = hex(55); }],
    ['wrong independent parent', f => { f.evidence.wrapperObservation.parentPid++; }],
    ['wrong namespace', f => { f.context.networkNamespaceInode = '5003'; }],
    ['numeric parent reuse', f => { f.evidence.parentCleanup.descriptors[1].parentFd = 41; }],
    ['FD10 is reserved', f => { f.evidence.descriptorMap.descriptors[7].childFd = 10 as 11; }],
    ['read-write lease handle', f => { f.evidence.descriptorMap.descriptors[0].accessMode = 'read-write'; }],
    ['raw append flag lost', f => { f.evidence.descriptorMap.descriptors[5].append = false; }],
    ['bootstrap map digest disagreement', f => { f.evidence.bootstrapDigests.descriptorMapSha256 = hex(90); }],
    ['role reordered', f => { f.evidence.parentCleanup.descriptors.reverse(); }],
    ['private auth swapped with raw', f => { [f.evidence.descriptorMap.descriptors[4], f.evidence.descriptorMap.descriptors[5]] =
      [f.evidence.descriptorMap.descriptors[5], f.evidence.descriptorMap.descriptors[4]]; }],
    ['WAL swapped with raw identity', f => { f.evidence.descriptorMap.descriptors[5].inode = '1006'; }],
    ['relabelled EBADF time', f => { f.evidence.parentCleanup.descriptors[0].afterSpawn.observedMonotonicNs = '250'; }],
    ['close before fork', f => { f.held.descriptors[0].closedMonotonicNs = '199'; f.repack(); }],
    ['out of order adjacent closes', f => { f.held.descriptors[1].closedMonotonicNs = '209';
      f.evidence.parentCleanup.descriptors[1].afterSpawn.observedMonotonicNs = '209'; f.repack(); }],
    ['unsealed kernel observation', f => { f.sealed.construction.seals = 7; f.repack(); }],
    ['held is not sealed', f => { f.held.descriptors[0].seals = 15; f.repack(); }],
    ['construction write handle still owned', f => { f.sealed.constructionClosedMonotonicNs = '401'; f.repack(); }],
    ['exec before seals', f => { f.executed.observedMonotonicNs = '320'; f.repack(); }],
    ['exec image substituted', f => { f.executed.executable.inode = '999'; f.repack(); }],
    ['entry digest substituted for runtime image', f => { f.evidence.executedImageSha256 = hex(55); }],
    ['missing binary proof', f => { f.evidence.nativeEvents = []; }],
    ['native event reorder', f => { f.evidence.nativeEvents.reverse(); }],
    ['noncanonical binary encoding', f => { f.evidence.nativeEvents[0].bodyBase64 += '\n'; }],
    ['declared parent made equal to child', f => { f.held.parentPid = f.held.ownerPid; f.repack(); }],
  ];
  it.each(mutations)('rejects %s', (_label, mutate) => {
    const f = fixture(); mutate(f);
    // Rehashing a self-contained map does not grant authorship or repair kernel disagreement.
    f.evidence.descriptorMapSha256 = sha256(canonicalJson(f.evidence.descriptorMap));
    expect(() => parseOwnerLaunchEvidenceV2(f.evidence, f.context)).toThrow();
  });
  it('rejects self-labelled proof/custody and JSON-only seals', () => {
    const f = fixture();
    expect(() => parseSupervisorTranscript(Buffer.from(canonicalJson({ custodyVerified: true,
      receipt: { pid: f.context.supervisor.pid, startTime: f.context.supervisor.startTime } }) + '\n'), f.context.plan))
      .toThrow('p3c_owner_plan_selected_transcript_receipt');
    expect(() => parseOwnerLaunchEvidenceV2({ ...f.evidence, custodyVerified: true }, f.context)).toThrow();
    expect(() => parseOwnerLaunchEvidenceV2({ ...f.evidence, nativeEvents: [{ sealed: true }] }, f.context)).toThrow();
    expect(() => parseOwnerDescriptorMapV2({ ...f.evidence.descriptorMap, seals: 15 })).toThrow();
  });
  it('does not reinterpret either legacy FD convention or cleanup-v2', () => {
    for (const slots of [[3, 4, 5], [6, 7, 8]]) {
      const f = fixture();
      const descriptors = f.evidence.descriptorMap.descriptors.slice(0, 3).map((d, i) => ({ ...d, childFd: slots[i] }));
      expect(() => parseOwnerDescriptorMapV2({ ...f.evidence.descriptorMap, descriptors })).toThrow();
    }
    const f = fixture();
    expect(() => parseOwnerChildDescriptorCleanup({ schemaVersion: 3,
      contract: f.evidence.parentCleanup.contract, records: [f.evidence.parentCleanup] }, [f.context.owner])).toThrow();
    expect(() => parseOwnerDescriptorMapV2({ ...f.evidence.descriptorMap, schemaVersion: 1,
      contract: 'agent-teams.hosted-owner-child-fd-map/v1' })).toThrow();
  });
  it('binds the separate launch envelope and selected supervisor receipt', () => {
    const f = fixture(), envelope = { schemaVersion: 2, protocol: f.context.plan.protocol, type: 'owner-native-launch',
      sequence: 4, controllerNonce: f.context.plan.controllerNonce, runId: f.context.plan.runId,
      observerStartToken: f.context.supervisor.startToken, evidence: f.evidence };
    expect(parseOwnerLaunchEnvelope(envelope, f.context.plan, 4, f.context.supervisor.startToken).parentToken)
      .toBe(f.context.owner.parentStartToken);
    expect(() => parseOwnerLaunchEnvelope({ ...envelope, runId: hex(33) }, f.context.plan, 4, f.context.supervisor.startToken)).toThrow();
    const bytes = Buffer.from('non-qualifying receipt binding fixture'), start = f.context.supervisor;
    const receipt = { pid: start.pid, startTime: start.startTime, transcriptSha256: sha256(bytes) };
    expect(() => assertSelectedSupervisorTranscript(bytes, f.context.plan, start, receipt)).not.toThrow();
    expect(() => assertSelectedSupervisorTranscript(bytes, f.context.plan, start)).toThrow();
    expect(() => assertSelectedSupervisorTranscript(bytes, f.context.plan, start, { ...receipt, pid: 101 })).toThrow();
    expect(() => assertSelectedSupervisorTranscript(Buffer.from('replaced'), f.context.plan, start, receipt)).toThrow();
  });
  it('cross-checks FD8 and FD9 against independently parsed capture identities', () => {
    const f = fixture(), cleanup = joined(f);
    const raw = { opencode: { captureDevice: '1', captureInode: '1005', producerStartTokens: [f.context.owner.startToken] } } as unknown as SupervisorOutcome['rawFiles'];
    const captures = { ownerWalTimelinePath: { shards: [{ producerStartToken: f.context.owner.startToken,
      producerRole: 'owner', producerFd: 9, captureDevice: '1', captureInode: '1006' }] } } as unknown as SupervisorOutcome['captureFiles'];
    expect(() => assertOwnerDescriptorCaptureBindings(cleanup, raw, captures)).not.toThrow();
    expect(() => assertOwnerDescriptorCaptureBindings(cleanup, { ...raw, opencode: { ...raw.opencode, captureInode: '1006' } }, captures)).toThrow();
    expect(() => assertOwnerDescriptorCaptureBindings(cleanup, raw, { ...captures, ownerWalTimelinePath: {
      ...captures.ownerWalTimelinePath, shards: [{ ...captures.ownerWalTimelinePath.shards[0], captureInode: '1005' }] } })).toThrow();
  });
});

function recipeFixture() {
  const pin = (path: string, n: number, mode = 0o555) => ({ root: 'p3b2', relativePath: path, sha256: hex(n), size: 128,
    mode, device: '1', inode: String(n), nlink: 1 });
  const descriptor = { p3b2: { sourceBaseCommit: 'a'.repeat(40), resultCommit: 'b'.repeat(40),
    entry: pin('owner.ts', 11), supervisor: pin('supervisor', 12), recipe: pin('recipe.json', 13),
    recipeSha256: hex(13), closure: { merkleRoot: hex(14) } },
    openCode: { linuxX64Binary: { sha256: hex(15) }, identities: { linuxX64BinarySha256: hex(15) } },
  } as unknown as IntegrationDescriptor;
  const recipe = { schemaVersion: 2, purpose: 'agent-teams.p3b2.source-actual-owner-entry/v2',
    sourceBaseCommit: descriptor.p3b2.sourceBaseCommit, resultCommit: descriptor.p3b2.resultCommit,
    entry: { relativePath: 'owner.ts', sha256: hex(11) }, supervisor: { relativePath: 'supervisor', sha256: hex(12) },
    closureMerkleRoot: hex(14), candidateOpenCodeSha256: hex(15), argv: ['run', '/p3b2/owner.ts', ...OWNER_V2_ARGV],
    sourceTreeRequired: true, accepted: true, sourceInvocation: { format: 'agent-teams.hosted-owner-source-invocation/v1',
      executable: pin('bun', 16, 0o500), module: { path: '/p3b2/owner.ts', sha256: hex(11) } }, launchHelper: pin('helper', 17, 0o500) };
  const bound = (value = recipe) => {
    const bytes = Buffer.from(canonicalJson(value)), digest = sha256(bytes);
    return { bytes, descriptor: { ...descriptor, p3b2: { ...descriptor.p3b2,
      recipeSha256: digest, recipe: { ...descriptor.p3b2.recipe, sha256: digest } } } };
  };
  return { recipe, bound };
}

describe('explicit source recipe and caller version', () => {
  it('keeps a separately selected image and exact module in the actual plan builder seam', () => {
    const f = recipeFixture(), { bytes, descriptor } = f.bound(), selection = verifyP3B2Recipe(bytes, descriptor)!;
    const admission = { descriptor, ownerLaunch: { selection, executable: { pin: selection.executable }, helper: { pin: selection.helper } },
      execution: { ownerEntry: { pin: descriptor.p3b2.entry } }, closures: { harness: { entries: [{
        path: 'scripts/e2e/hosted-actual-owner/actual-owner-contract.v2.json', sha256: hex(18) }] } } } as unknown as PreflightAdmission;
    const selected = selectOwnerPlan(admission);
    expect(selected.protocol).toEqual(ownerChildPlanV2());
    expect(selected.argv).toEqual(['run', '/p3b2/owner.ts', ...OWNER_V2_ARGV]);
    expect(selected.image.sha256).not.toBe(descriptor.p3b2.entry.sha256);
    const p = fixture().context.plan;
    expect(() => assertOwnerPlanV2({ ...p, ...selected.selection, ownerChildProtocol: selected.protocol,
      expectedArgv: { ...p.expectedArgv, owner: selected.argv },
      expectedExecutableDevice: { ...p.expectedExecutableDevice, owner: selected.image.device },
      expectedExecutableInode: { ...p.expectedExecutableInode, owner: selected.image.inode },
      expectedExecutableSha256: { ...p.expectedExecutableSha256, owner: selected.image.sha256 },
      expectedProducerModuleSha256: { ...p.expectedProducerModuleSha256, owner: descriptor.p3b2.entry.sha256 } })).not.toThrow();
    expect(selectOwnerPlan({ ...admission, ownerLaunch: undefined }).protocol).toEqual(legacyOwnerChildPlan());
    expect(() => selectOwnerPlan({ ...admission, ownerLaunch: { ...admission.ownerLaunch!, executable: admission.execution.ownerEntry } })).toThrow();
  });
  it('rejects recipe digest, path, candidate, helper and legacy invocation substitutions', () => {
    const f = recipeFixture(), selected = f.bound();
    expect(() => verifyP3B2Recipe(Buffer.from(canonicalJson({ ...f.recipe, accepted: false })), selected.descriptor)).toThrow();
    const mutations = [
      { ...f.recipe, argv: ['--runtime-manifest', '/sandbox/runtime-manifest.json'] },
      { ...f.recipe, candidateOpenCodeSha256: hex(99) },
      { ...f.recipe, sourceInvocation: { ...f.recipe.sourceInvocation, module: { path: '/p3b2/other.ts', sha256: hex(11) } } },
      { ...f.recipe, launchHelper: f.recipe.sourceInvocation.executable },
      { ...f.recipe, sourceTreeRequired: false },
      { ...f.recipe, schemaVersion: 1 },
    ];
    for (const value of mutations) { const b = f.bound(value); expect(() => verifyP3B2Recipe(b.bytes, b.descriptor)).toThrow(); }
  });
  it('refuses v2 plans with a legacy caller, manifest digest mismatch or unselected source image', () => {
    const f = fixture(), p = f.context.plan;
    expect(() => assertOwnerPlanV2({ ...p, ownerChildProtocol: legacyOwnerChildPlan() })).toThrow();
    expect(() => assertOwnerPlanV2({ ...p, expectedArgv: { ...p.expectedArgv, owner: legacyOwnerChildPlan().wrapperArgv } })).toThrow();
    expect(() => assertOwnerPlanV2({ ...p, runtimeManifest: { ...p.runtimeManifest,
      refs: { ...p.runtimeManifest.refs, openCodeExecutableSha256: hex(99) as typeof p.runtimeManifest.refs.openCodeExecutableSha256 } } })).toThrow();
    expect(() => assertOwnerPlanV2({ ...p, ownerSourceInvocation: { format: 'agent-teams.hosted-owner-source-invocation/v1',
      executable: { device: '1', inode: '999', sha256: hex(77) }, module: { path: '/p3b2/owner.ts', sha256: hex(7) } } })).toThrow();
  });
});


it('admits mode 0500 only for exact recipe-selected images in an independently walked private closure', async () => {
  const path = await mkdtemp(join(tmpdir(), 'r931-private-closure-'));
  let root: Awaited<ReturnType<typeof openRootAnchor>> | undefined;
  try {
    await chmod(path, 0o700);
    const entries: ClosureEntry[] = [
      { path: '.test-owned', mode: 0o444, size: 5, sha256: sha256('r931\n') },
      { path: 'helper', mode: 0o500, size: 6, sha256: sha256('image\n') },
      { path: 'module.ts', mode: 0o555, size: 7, sha256: sha256('source\n') },
    ];
    for (const [i, content] of ['r931\n', 'image\n', 'source\n'].entries()) {
      await writeFile(join(path, entries[i].path), content, { flag: 'wx', mode: entries[i].mode });
      await chmod(join(path, entries[i].path), entries[i].mode);
    }
    const bytes = Buffer.from(canonicalJson(entries));
    await writeFile(join(path, 'manifest.json'), bytes, { flag: 'wx', mode: 0o400 });
    await chmod(join(path, 'manifest.json'), 0o400);
    const directory = await open(path, 'r');
    try {
      const s = await directory.stat({ bigint: true });
      root = await openRootAnchor('p3b2', { path, device: String(s.dev), inode: String(s.ino),
        mountId: await descriptorMountId(directory), mode: 0o700 });
    } finally { await directory.close(); }
    const pin = async (relativePath: string, sha256: string, mode: FilePin['mode']): Promise<FilePin> => {
      const file = await open(join(path, relativePath), 'r');
      try { const s = await file.stat({ bigint: true }); return { root: 'p3b2', relativePath, sha256,
        mode, device: String(s.dev), inode: String(s.ino), size: Number(s.size), nlink: 1 }; }
      finally { await file.close(); }
    };
    const image = await pin('helper', entries[1].sha256, 0o500);
    const closure = { manifest: await pin('manifest.json', sha256(bytes), 0o400), manifestSha256: sha256(bytes),
      merkleRoot: closureDigestForTest(entries), fileCount: entries.length, totalBytes: 18 };
    await expect(verifyClosure(root, closure)).rejects.toThrow();
    await expect(verifyClosure(root, closure, [image])).resolves.toMatchObject({ fileCount: 3 });
    await expect(verifyClosure(root, closure, [{ ...image, sha256: hex(90) }])).rejects.toThrow();
    await chmod(join(path, 'module.ts'), 0o500);
    await expect(verifyClosure(root, closure, [image])).rejects.toThrow();
  } finally { await root?.handle.close(); await rm(path, { recursive: true, force: true }); }
});
