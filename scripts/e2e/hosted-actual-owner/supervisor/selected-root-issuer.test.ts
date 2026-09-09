import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { test } from 'node:test';
import { Duplex } from 'node:stream';
import { SelectedControllerChannel } from './selected-controller-channel';
import { generationFixture } from '../../../../test/main/composition/hosted/fixtures/approvalGenerationFixture';
import { approvalGenerationTransitionSigningBytes, decodeApprovalGenerationTransition } from '../../../../src/main/composition/hosted/hostedApprovalGenerationTransitionContract';
import { decodeNativeSuccessorHandle, nativeSuccessorHandleSigningBytes } from '../../../../src/main/composition/hosted/hostedNativeSuccessorHandleContract';
import { SelectedRootIssuer } from './selected-root-issuer';
import { canonicalJson, sha256 } from './canonical';

import { nativeContractFixture } from './selected-native-admission.fixture';
import { decodeNativeAllocation } from './selected-operation-allocation';
import { decodeNativeLaunchAdmission, type NativeLaunchRequest } from './selected-native-admission-contract';

function fixture() {
  const keys = generateKeyPairSync('ed25519'), f = generationFixture(keys.privateKey);
  assert(f.input.ownerAdmission);
  const contract = nativeContractFixture();
  const manifests = [1, 2, 3, 4].map(generation => {
    const envelope = JSON.parse(f.manifest(generation));
    if (generation === 4) {
      const payload = JSON.parse(envelope.payload), a = payload.approvalRoutes[0];
      payload.approvalRoutes.push({ ...a, teamId: `team_${'2'.repeat(32)}`,
        socketPath: '/sandbox/lifecycle-B-4', socketIdentity: { ...a.socketIdentity, inode: '9004' } });
      payload.approvalSnapshot.authorities.push({ ...payload.approvalSnapshot.authorities[0], teamId: `team_${'2'.repeat(32)}` });
      const approvalDigest = `sha256:${sha256(JSON.stringify(payload.approvalSnapshot))}`;
      payload.approvalAdmission.approvalDigest = approvalDigest;
      for (const route of payload.approvalRoutes) route.approvalDigest = approvalDigest;
      envelope.payload = JSON.stringify(payload);
      envelope.authentication.signature = sign(null, Buffer.from(`${envelope.format}\0${envelope.payload}`), keys.privateKey).toString('base64url');
    }
    return JSON.stringify(envelope);
  });
  const documents = [1, 2, 3, 4].map(generation => {
    const doc = JSON.parse(f.ticket(generation).admissionDocument);
    if (generation === 4) {
      const a = doc.routes[0];
      doc.routes.push({ ...a, routeId: 'route-native-B', scope: { ...a.scope, teamId: `team_${'2'.repeat(32)}` },
        authority: { ...a.authority, teamId: `team_${'2'.repeat(32)}` } });
    }
    return JSON.stringify(doc) + '\n';
  });
  const aRoute = JSON.parse(documents[0]).routes[0], bRoute = JSON.parse(documents[3]).routes[1];
  const allocation = decodeNativeAllocation({ ...contract.native.allocation,
    generations: contract.native.allocation.generations.map((g, index) => ({ ...g,
      ownerSessionId: f.selection(index + 1).ownerSessionId,
      admissionDocumentSha256: sha256(documents[index]),
      manifestSha256: index === 0 ? f.input.ownerAdmission!.manifestDigest.slice(7) : sha256(manifests[index]),
      slots: g.slots.map(slot => ({ ...slot, routeId: slot.slot === 'A' ? aRoute.routeId : bRoute.routeId,
        routeDigest: sha256(canonicalJson(slot.slot === 'A' ? aRoute : bRoute)), lifecycleEndpoint: slot.slot === 'A'
        ? JSON.parse(JSON.parse(manifests[index]).payload).approvalRoutes[0].socketPath : slot.lifecycleEndpoint })),
    })), entries: contract.native.allocation.entries.map(e => ({ ...e,
      routeId: e.slot === 'A' ? aRoute.routeId : bRoute.routeId, routeDigest: sha256(canonicalJson(e.slot === 'A' ? aRoute : bRoute)) })) });
  const request = (generation: number): NativeLaunchRequest => ({ kind: 'native', generation,
    ownerProcessStartToken: f.selection(generation).ownerProcessStartToken,
    launch: { bootstrapV2HeaderSha256: f.selection(generation).bootstrapV2HeaderSha256, ownerProcessStartToken: f.selection(generation).ownerProcessStartToken,
      expectedHost: { activation: { ownerGeneration: generation, ownerSessionId: f.selection(generation).ownerSessionId,
        admissionDocumentDigest: `sha256:${allocation.generations[generation - 1].admissionDocumentSha256}`,
        bootstrapDigest: sha256(f.bootstrap) }, executable: { sha256: f.selection(generation).expectedOpenCodeExecutableSha256 } } },
    sealed: { fixture: 'sealed' } });
  const observations = { async observe(r: NativeLaunchRequest) { return {
    bootstrapV2HeaderSha256: f.selection(r.generation).bootstrapV2HeaderSha256,
    launchSha256: sha256(canonicalJson(r.launch)), sealedSha256: sha256(canonicalJson(r.sealed)), ownerProcessStartToken: r.ownerProcessStartToken,
    predecessorResults: r.generation === 4 ? [{ operationId: 'Rretry', generation: 3 as const, ownerProcessStartToken: f.selection(3).ownerProcessStartToken,
      requestRecordSha256: 'a'.repeat(64), responseRecordSha256: 'b'.repeat(64), bodySha256: 'c'.repeat(64),
      peerBindingSha256: 'd'.repeat(64), returnWitnessSha256: 'e'.repeat(64) }] : [],
  }; } };
  const inputs = { native: { ...contract.native, allocation, observations, endpointObservations: { async observe(generation: { generation: number }) {
    return { device: '1', inode: String(100 + generation.generation) }; } } }, launcherKey: keys.privateKey, predecessor: f.input.ownerAdmission,
    expectedOpenCodeExecutableSha256: f.selection(1).expectedOpenCodeExecutableSha256,
    serializedProductBootstrap: f.bootstrap, initialAdmissionDocument: documents[0],
    successors: [2, 3, 4].map(generation => ({ generation,
      admissionDocument: documents[generation - 1], successorManifest: manifests[generation - 1] })) };
  return { f, keys, inputs, request, issuer: new SelectedRootIssuer(inputs) };
}
test('existing root signs exact generation documents and actual handle selections across all replacements', async () => {
  const { f, keys, inputs, request, issuer } = fixture();
  let predecessorDigest = inputs.predecessor.manifestDigest;
  try {
    decodeNativeLaunchAdmission(await issuer.issue(request(1)));
    for (const generation of [2, 3, 4]) {
      const ticket = decodeApprovalGenerationTransition(await issuer.issue({ kind: 'transition', generation,
        predecessorManifestDigest: predecessorDigest,
        predecessorProcessStartToken: f.selection(generation - 1).ownerProcessStartToken }));
      assert(verify(null, approvalGenerationTransitionSigningBytes(ticket), keys.publicKey, Buffer.from(ticket.signature, 'base64url')));
      assert.equal(ticket.successorBootstrapDigest, sha256(f.bootstrap));
      assert.equal(ticket.admissionDocument, inputs.successors[generation - 2].admissionDocument);
      decodeNativeLaunchAdmission(await issuer.issue(request(generation)));
      const selection = f.selection(generation), endpointIdentity = { device: '1', inode: String(100 + generation) };
      const handle = decodeNativeSuccessorHandle(await issuer.issue({ kind: 'successor-handle', selection, endpointIdentity,
        transitionSha256: sha256(approvalGenerationTransitionSigningBytes(ticket)) }));
      assert(verify(null, nativeSuccessorHandleSigningBytes(handle), keys.publicKey, Buffer.from(handle.signature, 'base64url')));
      assert.deepEqual(handle.selection, selection); assert.deepEqual(handle.endpointIdentity, endpointIdentity);
      assert.equal(handle.successorManifest, inputs.successors[generation - 2].successorManifest);
      assert.equal(verify(null, nativeSuccessorHandleSigningBytes({ ...handle,
        endpointIdentity: { ...endpointIdentity, inode: '999' } }), keys.publicKey, Buffer.from(handle.signature, 'base64url')), false);
      predecessorDigest = `sha256:${sha256(handle.successorManifest)}`;
    }
    assert.throws(() => issuer.issue({ kind: 'transition', generation: 5,
      predecessorManifestDigest: predecessorDigest, predecessorProcessStartToken: f.selection(4).ownerProcessStartToken }));
  } finally { issuer.close(); }
});
test('wrong root key, changed bootstrap and wrong signed successor refuse construction', () => {
  const { inputs, issuer } = fixture(); issuer.close();
  assert.throws(() => new SelectedRootIssuer({ ...inputs, launcherKey: generateKeyPairSync('ed25519').privateKey }));
  assert.throws(() => new SelectedRootIssuer({ ...inputs, serializedProductBootstrap: inputs.serializedProductBootstrap + '\n' }));
  const foreign = generationFixture();
  assert.throws(() => new SelectedRootIssuer({ ...inputs, successors: inputs.successors.map((row, index) =>
    index ? row : { ...row, successorManifest: foreign.manifest(2) }) }));
});
test('overlap, selected image substitution and replay poison the bounded issuer', async () => {
  for (const variant of ['overlap', 'image', 'start', 'bootstrap'] as const) {
    const { f, inputs, issuer, request: nativeRequest } = fixture();
    await issuer.issue(nativeRequest(1));
    const request = { kind: 'transition', generation: 2, predecessorManifestDigest: inputs.predecessor.manifestDigest,
      predecessorProcessStartToken: f.selection(1).ownerProcessStartToken };
    const ticket = decodeApprovalGenerationTransition(await issuer.issue(request));
    if (variant === 'overlap') assert.throws(() => issuer.issue(request));
    else {
      await issuer.issue(nativeRequest(2));
      const selection = { ...f.selection(2), ...(variant === 'image' ? { expectedOpenCodeExecutableSha256: '0'.repeat(64) }
        : variant === 'start' ? { ownerProcessStartToken: f.selection(1).ownerProcessStartToken }
        : { bootstrapDigest: '0'.repeat(64) }) };
      await assert.rejects(issuer.issue({ kind: 'successor-handle', selection, endpointIdentity: { device: '1', inode: '101' },
        transitionSha256: sha256(approvalGenerationTransitionSigningBytes(ticket)) }));
    }
    assert.throws(() => issuer.issue(request)); issuer.close();
  }
});

test('reservation precedes observation and overlap or disconnect poisons in-flight issuance', async () => {
  const f = fixture(); f.issuer.close();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  const issuer = new SelectedRootIssuer({ ...f.inputs, native: { ...f.inputs.native,
    observations: { async observe(request) { entered = true; await held; return f.inputs.native.observations.observe(request); } } } });
  const pending = issuer.issue(f.request(1));
  assert(entered);
  assert.throws(() => issuer.reserve(f.request(1)));
  release(); await assert.rejects(pending);
  assert.throws(() => issuer.reserve(f.request(1)));
});

test('native observed mismatch and cancellation never permit the next exchange', async () => {
  for (const mode of ['mismatch', 'abort'] as const) {
    const f = fixture(); f.issuer.close();
    const controller = new AbortController();
    const issuer = new SelectedRootIssuer({ ...f.inputs, native: { ...f.inputs.native,
      observations: { async observe(request) {
        const observed = await f.inputs.native.observations.observe(request);
        if (mode === 'abort') controller.abort();
        return { ...observed, ...(mode === 'mismatch' ? { sealedSha256: '0'.repeat(64) } : {}) };
      } } } });
    await assert.rejects(issuer.issue(f.request(1), controller.signal));
    assert.throws(() => issuer.reserve(f.request(1)));
  }
});

test('abort bounds an observation port that has not returned; late completion cannot sign', async () => {
  const f = fixture(); f.issuer.close();
  const controller = new AbortController();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const issuer = new SelectedRootIssuer({ ...f.inputs, native: { ...f.inputs.native,
    observations: { async observe(request) { await held; return f.inputs.native.observations.observe(request); } } } });
  const pending = issuer.issue(f.request(1), controller.signal);
  controller.abort(); await assert.rejects(pending);
  release(); assert.throws(() => issuer.reserve(f.request(1)));
});

async function successorFixture() {
  const f = fixture();
  await f.issuer.issue(f.request(1));
  const ticket = decodeApprovalGenerationTransition(await f.issuer.issue({ kind: 'transition', generation: 2,
    predecessorManifestDigest: f.inputs.predecessor.manifestDigest,
    predecessorProcessStartToken: f.f.selection(1).ownerProcessStartToken }));
  await f.issuer.issue(f.request(2));
  return { ...f, handleRequest: { kind: 'successor-handle', selection: f.f.selection(2),
    endpointIdentity: { device: '1', inode: '102' }, transitionSha256: sha256(approvalGenerationTransitionSigningBytes(ticket)) } };
}
test('successor header and endpoint must match independent native and endpoint observations', async () => {
  for (const mode of ['header', 'device', 'inode'] as const) {
    const f = await successorFixture();
    const request = mode === 'header' ? { ...f.handleRequest,
      selection: { ...f.handleRequest.selection, bootstrapV2HeaderSha256: 'f'.repeat(64) } } :
      { ...f.handleRequest, endpointIdentity: { ...f.handleRequest.endpointIdentity, [mode]: '999' } };
    await assert.rejects(f.issuer.issue(request));
    assert.throws(() => f.issuer.reserve(f.handleRequest));
  }
  const f = fixture(); f.issuer.close();
  assert.throws(() => new SelectedRootIssuer({ ...f.inputs, native: { ...f.inputs.native,
    endpointObservations: undefined! } }));
});
test('valid signatures cannot bypass snapshot authority/team authentication', () => {
  const f = fixture(); f.issuer.close();
  const successors = f.inputs.successors.map(row => {
    if (row.generation !== 4) return row;
    const envelope = JSON.parse(row.successorManifest), payload = JSON.parse(envelope.payload);
    payload.approvalSnapshot.authorities.pop();
    const digest = `sha256:${sha256(JSON.stringify(payload.approvalSnapshot))}`;
    payload.approvalAdmission.approvalDigest = digest;
    for (const route of payload.approvalRoutes) route.approvalDigest = digest;
    envelope.payload = JSON.stringify(payload);
    envelope.authentication.signature = sign(null, Buffer.from(`${envelope.format}\0${envelope.payload}`), f.keys.privateKey).toString('base64url');
    return { ...row, successorManifest: JSON.stringify(envelope) };
  });
  const allocation = decodeNativeAllocation({ ...f.inputs.native.allocation,
    generations: f.inputs.native.allocation.generations.map(g => g.generation === 4 ?
      { ...g, manifestSha256: sha256(successors[2].successorManifest) } : g) });
  assert.throws(() => new SelectedRootIssuer({ ...f.inputs, successors, native: { ...f.inputs.native, allocation } }),
    /route-snapshot-mismatch/u);
});
test('FD3 separately delivered duplicate or next-sequence bytes abort held observation before first signature', async () => {
  for (const nextSequence of [1, 2]) {
    const f = fixture(); f.issuer.close();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const observing = new Promise<void>(resolve => { entered = resolve; });
    const issuer = new SelectedRootIssuer({ ...f.inputs, native: { ...f.inputs.native,
      observations: { async observe(request) { entered(); await held; return f.inputs.native.observations.observe(request); } } } });
    const writes: Buffer[] = [];
    const stream = new Duplex({ read() {}, write(chunk, _encoding, done) { writes.push(Buffer.from(chunk)); done(); } });
    const channel = new SelectedControllerChannel(stream);
    const send = (sequence: number) => {
      const request = sequence === 1 ? f.request(1) : { kind: 'transition', generation: 2,
        predecessorManifestDigest: f.inputs.predecessor.manifestDigest,
        predecessorProcessStartToken: f.f.selection(1).ownerProcessStartToken };
      const bytes = Buffer.from(canonicalJson({ sequence, request }));
      const frame = Buffer.alloc(bytes.length + 4); frame.writeUInt32BE(bytes.length); bytes.copy(frame, 4); stream.push(frame);
    };
    const serving = (async () => {
      const envelope = await channel.read(new AbortController().signal, 5000, true) as { request: unknown };
      const result = await issuer.reserve(envelope.request).finish(channel.closedSignal);
      await channel.write({ result }, true);
    })();
    send(1); await observing;
    send(nextSequence);
    await assert.rejects(serving);
    release(); await Promise.resolve();
    assert(channel.closedSignal.aborted); assert.equal(writes.length, 0);
    assert.throws(() => issuer.reserve(f.request(1)));
    issuer.close(); channel.close();
  }
});

test('native header disagreement rejects and endpoint observation cancellation cannot sign late', async () => {
  const mismatch = fixture(); mismatch.issuer.close();
  const issuer = new SelectedRootIssuer({ ...mismatch.inputs, native: { ...mismatch.inputs.native,
    observations: { async observe(request) { return { ...await mismatch.inputs.native.observations.observe(request),
      bootstrapV2HeaderSha256: '0'.repeat(64) }; } } } });
  await assert.rejects(issuer.issue(mismatch.request(1)));
  assert.throws(() => issuer.reserve(mismatch.request(1)));
  const f = fixture(); f.issuer.close();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const observing = new Promise<void>(resolve => { entered = resolve; });
  const selected = new SelectedRootIssuer({ ...f.inputs, native: { ...f.inputs.native,
    endpointObservations: { async observe(generation) { entered(); await held;
      return f.inputs.native.endpointObservations.observe(generation); } } } });
  await selected.issue(f.request(1));
  const ticket = decodeApprovalGenerationTransition(await selected.issue({ kind: 'transition', generation: 2,
    predecessorManifestDigest: f.inputs.predecessor.manifestDigest,
    predecessorProcessStartToken: f.f.selection(1).ownerProcessStartToken }));
  await selected.issue(f.request(2));
  const controller = new AbortController();
  const pending = selected.issue({ kind: 'successor-handle', selection: f.f.selection(2),
    endpointIdentity: { device: '1', inode: '102' },
    transitionSha256: sha256(approvalGenerationTransitionSigningBytes(ticket)) }, controller.signal);
  await observing; controller.abort(); await assert.rejects(pending);
  release(); assert.throws(() => selected.reserve(f.request(3)));
});
