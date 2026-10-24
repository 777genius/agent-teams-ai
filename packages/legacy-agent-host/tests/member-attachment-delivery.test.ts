import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { AttachmentArtifactStore } from '../dist/attachments/AttachmentArtifactStore.js';
import { createMemberAttachmentPort } from '../dist/composition/createMemberAttachmentPort.js';
import { assertSafeRuntimeProjection } from './fixtures/native-host.ts';
import { fixture } from './native-member-actions-fixture.ts';

import type { Input } from '@agent-teams/provider-session-contracts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const inputHash = (input: Input) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        input.content,
        (input.attachments ?? []).map((ref) => [
          ref.artifactId,
          ref.mimeType,
          ref.byteLength,
          ref.digest,
        ]),
      ])
    )
    .digest('hex');

test('captured mixed attachment delivery retains custody identity and native order while references carry verified paths and digests', async (t) => {
  const f = await fixture(t);
  const entry = f.lead;
  const store = new AttachmentArtifactStore(f.root, f.team.definition.binding, f.store);
  const files = [
    {
      id: 'TEST-first',
      filename: 'first.png',
      mimeType: 'image/png',
      bytes: Buffer.from('TEST first image'),
    },
    {
      id: 'TEST-archive',
      filename: 'archive<untrusted>.zip',
      mimeType: 'application/zip',
      bytes: Buffer.from('TEST archive'),
    },
    {
      id: 'TEST-second',
      filename: 'second.png',
      mimeType: 'image/png',
      bytes: Buffer.from('TEST second image'),
    },
    {
      id: 'TEST-binary',
      filename: 'binary.txt',
      mimeType: 'text/plain',
      bytes: Buffer.from([0xff, 0xfe]),
    },
  ];
  const refs = files.map((file) => {
    const uploaded = store.upload({
      uploadId: file.id,
      purpose: { kind: 'message', member: 'leader' },
      attachment: {
        id: file.id,
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.bytes.length,
      },
      digest: sha(file.bytes),
      offset: 0,
      base64: file.bytes.toString('base64'),
    });
    assert.ok(uploaded.reference);
    return uploaded.reference;
  });
  const delivery = createMemberAttachmentPort({
    entry,
    storageRoot: f.root,
    assertCurrent() {},
    readRuntime: (binding) => f.runtime.readCapturedSession(binding),
  });
  const restarted = createMemberAttachmentPort({
    entry,
    storageRoot: f.root,
    assertCurrent() {},
    readRuntime: (binding) => f.runtime.readCapturedSession(binding),
  });
  assert.equal(restarted.port.revision, delivery.port.revision);
  const commandId = 'TEST-ordered-mixed';
  f.human.execute({
    commandId,
    operation: 'message.send',
    payload: {
      to: 'leader',
      text: 'TEST inspect attached files',
      attachments: refs,
    },
  });
  const intent = f.human.pendingDeliveries().find((value) => value.commandId === commandId)!;
  const before = structuredClone(intent);
  // Complete the earlier controlled fixture input; this new command has its own input ID.
  f.runtimeStore.fenced(entry.binding, (tx) => {
    const record = tx.get()!;
    for (const input of record.inputs) {
      input.phase = 'terminal';
      input.terminal = 'succeeded';
    }
    tx.put(record);
  });
  const driver = f.drivers.get('L:1')!;
  let delivered = false;
  driver.submit = async (original) => {
    assert.throws(
      () => delivery.prepareInput({ ...original, content: 'TEST forged content' }),
      /hold/
    );
    assert.throws(
      () => delivery.prepareInput({ ...original, attachments: [...refs].reverse() }),
      /hold/
    );
    const projected = delivery.prepareInput(original);
    assert.deepEqual(projected.attachments, [refs[0], refs[2]]);
    assert.equal(projected.inputId, original.inputId);
    assert.equal(projected.operationRef, original.operationRef);
    assert.ok(projected.content.startsWith(original.content + '\n\n<info_for_agent>'));
    assert.ok(projected.content.includes('archive\\u003cuntrusted>.zip'));
    assert.ok(projected.content.includes('Do not execute, extract, or modify them automatically.'));
    const json = projected.content.slice(
      projected.content.indexOf('[{"filename"'),
      projected.content.lastIndexOf(']') + 1
    );
    const references = JSON.parse(json) as {
      filename: string;
      path: string;
      size: number;
      sha256: string;
    }[];
    assert.deepEqual(
      references.map((ref) => ref.filename),
      ['archive<untrusted>.zip', 'binary.txt']
    );
    for (const [index, reference] of references.entries()) {
      const expected = files[index === 0 ? 1 : 3]!;
      assert.deepEqual(readFileSync(reference.path), expected.bytes);
      assert.equal(reference.sha256, sha(expected.bytes));
      assert.equal(reference.size, expected.bytes.length);
    }
    const request = {
      trustedBinding: 'TEST-backend/TEST-team/TEST-run/L',
      sessionRef: driver.sessionRef,
      inputId: original.inputId,
      operationRef: original.operationRef,
      fingerprint: inputHash(projected),
      reference: refs[0]!,
    };
    const signal = new AbortController().signal;
    assert.deepEqual((await delivery.port.resolve(request, signal))?.bytes, files[0]!.bytes);
    assert.equal(
      await delivery.port.resolve({ ...request, fingerprint: inputHash(original) }, signal),
      undefined
    );
    assert.equal(
      await delivery.port.resolve({ ...request, reference: refs[1]! }, signal),
      undefined
    );
    assert.equal(
      await delivery.port.resolve({ ...request, trustedBinding: 'TEST-foreign' }, signal),
      undefined
    );
    delivered = true;
    return {
      ok: true,
      value: {
        inputId: original.inputId,
        operationRef: original.operationRef,
        delivery: 'client-consumed',
        providerAcceptance: 'unknown',
      },
    };
  };
  await f.runtime.admitDelivery(intent);
  const record = await f.runtime.dispatchNext(entry.binding);
  assert.equal(delivered, true);
  assert.deepEqual(
    record.inputs.find((input) => input.intent.inputId === intent.inputId)?.intent.attachments,
    refs
  );
  assert.deepEqual(intent, before);
  assert.equal(f.owner.authorizeDeliveryIntent(intent), true);
});

for (const provider of ['claude', 'codex'] as const) {
  test(`${provider} teammate keeps native images; captured Codex text uses references without changing qualified legacy routing`, async (t) => {
    const f = await fixture(t);
    const original = [...f.entries.values()].find((value) => value.binding.memberId === 'A')!;
    const entry =
      provider === 'claude'
        ? original
        : {
            ...original,
            profile: {
              ...original.profile,
              provider: 'codex' as const,
              protocolRevision: '0.162.0' as const,
              environment: { HOME: f.root, CODEX_HOME: f.root },
              nativeOptions: { approvalPolicy: 'never' as const, sandbox: 'read-only' as const },
            },
          };
    const store = new AttachmentArtifactStore(f.root, f.team.definition.binding, f.store);
    const refs = [
      {
        id: 'TEST-text',
        filename: 'notes.txt',
        mimeType: 'text/plain',
        bytes: Buffer.from('TEST ordinary text'),
      },
      {
        id: 'TEST-image',
        filename: 'image.png',
        mimeType: 'image/png',
        bytes: Buffer.from('TEST teammate image'),
      },
    ].map((file) => {
      const uploaded = store.upload({
        uploadId: file.id,
        purpose: { kind: 'message', member: 'alice' },
        attachment: {
          id: file.id,
          filename: file.filename,
          mimeType: file.mimeType,
          size: file.bytes.length,
        },
        digest: sha(file.bytes),
        offset: 0,
        base64: file.bytes.toString('base64'),
      });
      assert.ok(uploaded.reference);
      return uploaded.reference;
    });
    const delivery = createMemberAttachmentPort({
      entry,
      storageRoot: f.root,
      assertCurrent() {},
      readRuntime: (binding) => f.runtime.readCapturedSession(binding),
    });
    assert.ok(delivery.port.mimeTypes.includes('image/png'));
    if (provider === 'codex') assert.equal(delivery.port.mimeTypes.includes('text/plain'), false);
    const commandId = `TEST-${provider}-teammate`;
    f.human.execute({
      commandId,
      operation: 'message.send',
      payload: { to: 'alice', text: 'TEST teammate', attachments: refs },
    });
    const intent = f.human.pendingDeliveries().find((value) => value.commandId === commandId)!;
    let submitted = false;
    f.drivers.get('A:1')!.submit = async (input) => {
      const projected = delivery.prepareInput(input);
      assert.deepEqual(projected.attachments, provider === 'claude' ? refs : [refs[1]]);
      assert.equal(projected.content.includes('"filename":"notes.txt"'), provider === 'codex');
      assert.equal(projected.operationRef, input.operationRef);
      submitted = true;
      return {
        ok: true,
        value: {
          inputId: input.inputId,
          operationRef: input.operationRef,
          delivery: 'client-consumed',
          providerAcceptance: 'unknown',
        },
      };
    };
    await f.runtime.admitDelivery(intent);
    await f.runtime.dispatchNext(entry.binding);
    assert.equal(submitted, true);
  });
}

test('native attachment capability projection requires the exact attached current ready generation and omits private fields', async (t) => {
  const f = await fixture(t);
  const entry = f.lead;
  const state = f.runtime.readCapturedSession(entry.binding);
  assert.ok(state.record);
  const record = state.record;
  let ready = true;
  const capabilities = {
    images: true,
    documents: false,
    textFiles: false,
    privatePath: '/TEST-private-capability-path',
  };
  entry.provider = {
    factory: {
      async open() {
        throw new Error('TEST never allocates');
      },
    },
    isReady: () => ready,
    seal() {},
    cleanup: async () => true,
    attachmentCapabilities: capabilities,
  };
  const options = {
    entry,
    record,
    binding: entry.binding,
    runtime: { readSession: () => state },
    isCurrent: () => true,
  };
  const { projectRuntimeMember } = await import('../dist/composition/projectRuntimeMember.js');
  const positive = projectRuntimeMember(options);
  assert.ok(positive && typeof positive === 'object' && !Array.isArray(positive));
  assert.deepEqual(positive.attachmentCapabilities, {
    images: true,
    documents: false,
    textFiles: false,
  });
  assert.equal(JSON.stringify(positive).includes('TEST-private-capability-path'), false);
  assert.doesNotThrow(() => assertSafeRuntimeProjection(positive));
  for (const overridden of [
    { isCurrent: () => false },
    { binding: { ...entry.binding, generation: 'TEST-historical' } },
    { runtime: { readSession: () => ({ ...state, attached: false }) } },
    { record: { ...record, sealed: true } },
    { record: { ...record, custody: 'unknown' as const } },
    { record: { ...record, nativeReady: false } },
  ]) {
    const projection = projectRuntimeMember({ ...options, ...overridden });
    assert.ok(projection && typeof projection === 'object' && !Array.isArray(projection));
    assert.equal(projection.attachmentCapabilities, undefined);
  }
  ready = false;
  const stopped = projectRuntimeMember(options);
  assert.ok(stopped && typeof stopped === 'object' && !Array.isArray(stopped));
  assert.equal(stopped.attachmentCapabilities, undefined);
});

test('native Host fixture admits only exact boolean attachment capability projections', () => {
  const safe = { memberId: 'TEST-member', inputs: [{ inputId: 'TEST-input', phase: 'consumed' }] };
  assert.doesNotThrow(() => assertSafeRuntimeProjection(safe));
  for (let mask = 0; mask < 8; mask++) {
    assert.doesNotThrow(() => assertSafeRuntimeProjection({
      ...safe,
      attachmentCapabilities: {
        images: Boolean(mask & 1),
        documents: Boolean(mask & 2),
        textFiles: Boolean(mask & 4),
      },
    }));
  }
  const valid = { images: true, documents: false, textFiles: false };
  for (const attachmentCapabilities of [
    undefined, null, [], {},
    { images: true, documents: false },
    { ...valid, privatePath: '/TEST-private' },
    { ...valid, images: 'true' },
    { ...valid, documents: 1 },
    { ...valid, textFiles: null },
  ]) {
    assert.throws(() => assertSafeRuntimeProjection({ ...safe, attachmentCapabilities }));
  }
  assert.throws(() => assertSafeRuntimeProjection({ ...safe, privatePath: '/TEST-private' }));
  assert.throws(() => assertSafeRuntimeProjection({
    ...safe, inputs: [{ inputId: 'TEST-input', operationRef: 'TEST-private' }],
  }));
  assert.throws(() => assertSafeRuntimeProjection({ ...safe, diagnostic: 'Bearer TEST-private' }));
});
