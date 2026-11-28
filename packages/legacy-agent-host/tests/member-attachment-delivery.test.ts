import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { AttachmentArtifactStore } from '../dist/attachments/AttachmentArtifactStore.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { resolveAgentAttachmentArtifactPath } from '../dist/attachments/storage.js';
import { bindOpenCodeV2AttachmentPort } from '../dist/adapters/providers/OpenCodeV2AttachmentPort.js';
import { createMemberAttachmentPort } from '../dist/composition/createMemberAttachmentPort.js';
import { createTeamContextPreparation } from '../dist/composition/createTeamContextPreparation.js';
import { digest } from '../dist/team/identity.js';
import { deliveryFingerprint, runtimeDigest } from '../dist/runtime/identity.js';
import { assertSafeRuntimeProjection } from './fixtures/native-host.ts';
import { NATIVE_MESSAGE_PNG } from './fixtures/native-message-image.ts';
import { fixture } from './native-member-actions-fixture.ts';

import type { Input } from '@agent-teams/provider-session-contracts';

test('context admission refuses oversized saved-file decoration even without a pending context epoch', async (t) => {
  const f = await fixture(t);
  const entry = f.lead, bytes = Buffer.from('TEST bounded file');
  const artifacts = new AttachmentArtifactStore(f.root, f.team.definition.binding, f.store);
  const uploaded = artifacts.upload({
    uploadId: 'TEST-context-file', purpose: { kind: 'message', member: 'leader' },
    attachment: { id: 'TEST-context-file', filename: 'документ<漢>.zip', mimeType: 'application/zip', size: bytes.length },
    digest: sha(bytes), offset: 0, base64: bytes.toString('base64'),
  });
  assert.ok(uploaded.reference);
  const content = 'TEST original content';
  entry.profile.limits.inputBytes = entry.baseProfile.limits.inputBytes = Buffer.byteLength(content) + 1;
  const callbacks = createTeamContextPreparation({
    entries: f.entries, principalId: 'profile-admin', storageRoot: f.root,
    assertCurrent() {},
  });
  const request = {
    sessionRef: 'TEST-session-L-1', inputId: 'TEST-budget-input', operationRef: 'TEST-budget-operation',
    intentFingerprint: 'a'.repeat(64), originalContent: content,
    originalContentBytes: Buffer.byteLength(content), attachments: [uploaded.reference],
    epochs: [], priorProofs: [],
  };
  const before = readFileSync(join(f.root, 'teams', entry.delivery.teamName, '.host-owner', 'state.json'), 'utf8');
  assert.throws(() => callbacks.prepareInput!(entry.binding, request), /hold/);
  assert.equal(readFileSync(join(f.root, 'teams', entry.delivery.teamName, '.host-owner', 'state.json'), 'utf8'), before);
  assert.deepEqual(Buffer.from(artifacts.resolve(uploaded.reference).bytes), bytes);
});

test('context admission applies the captured content limit before preserving a native slash command', async (t) => {
  const f = await fixture(t), entry = f.lead;
  const callbacks = createTeamContextPreparation({
    entries: f.entries, principalId: 'profile-admin', storageRoot: f.root,
    assertCurrent() {},
  });
  const content = '/compact ' + '漢'.repeat(50);
  const request = {
    sessionRef: 'TEST-session-L-1', inputId: 'TEST-slash-input', operationRef: 'TEST-slash-operation',
    intentFingerprint: 'b'.repeat(64), originalContent: content,
    originalContentBytes: Buffer.byteLength(content), epochs: [], priorProofs: [],
  };
  entry.profile.limits.inputBytes = entry.baseProfile.limits.inputBytes = Buffer.byteLength(content) - 1;
  assert.throws(() => callbacks.prepareInput!(entry.binding, request), /hold/);
  entry.profile.limits.inputBytes++; entry.baseProfile.limits.inputBytes++;
  assert.equal(callbacks.prepareInput!(entry.binding, request), undefined);
});

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

const portableImageUpload = () => ({
  uploadId: 'TEST-portable-image-upload',
  purpose: { kind: 'message' as const, member: 'leader' },
  attachment: { id: 'TEST-portable-image', filename: 'изображение.png', mimeType: 'image/png', size: NATIVE_MESSAGE_PNG.length },
  digest: sha(NATIVE_MESSAGE_PNG), offset: 0, base64: NATIVE_MESSAGE_PNG.toString('base64'),
});

test('attachment upload creates native nested Unicode directories and reads back the exact PNG', async t => {
  const f = await fixture(t, false), root = join(f.root, 'тест изображения', 'nested');
  const store = new AttachmentArtifactStore(root, f.team.definition.binding, f.store), request = portableImageUpload();
  const uploaded = store.upload(request);
  assert.equal(uploaded.nextOffset, null); assert.ok(uploaded.reference);
  const resolved = store.resolve(uploaded.reference);
  assert.equal(realpathSync(dirname(resolved.nativePath)), dirname(resolved.nativePath));
  assert.ok(resolved.nativePath.startsWith(root));
  assert.deepEqual(readFileSync(resolved.nativePath), NATIVE_MESSAGE_PNG);
  assert.deepEqual(Buffer.from(resolved.bytes), NATIVE_MESSAGE_PNG);
  const metadata = store.metadata([uploaded.reference], request.purpose);
  const read = store.read(metadata, request.attachment.id, 0, request.digest);
  assert.ok(read); assert.equal(read.nextOffset, null); assert.equal(read.sha256, request.digest);
  assert.equal(read.base64, request.base64); assert.equal(read.attachment.filename, request.attachment.filename);
});

test('attachment upload refuses an intermediate junction without publishing foreign bytes', async t => {
  const f = await fixture(t, false), root = join(f.root, 'тест guarded'), outside = join(f.root, 'TEST-outside');
  mkdirSync(join(root, 'appData'), { recursive: true }); mkdirSync(outside);
  symlinkSync(outside, join(root, 'appData', 'attachments'), 'junction');
  const store = new AttachmentArtifactStore(root, f.team.definition.binding, f.store);
  assert.throws(() => store.upload(portableImageUpload()), /hold/);
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(f.store.list<{ completed: boolean }>('attachments').some(value => value.completed), false);
});

for (const code of ['EINVAL', 'EPERM', 'EIO', 'ENOSPC'] as const) {
  test(`attachment publication distinguishes unsupported directory sync from ${code} storage refusal`, async t => {
    const f = await fixture(t, false), root = join(f.root, 'тест durable'), request = portableImageUpload();
    const store = new AttachmentArtifactStore(root, f.team.definition.binding, f.store);
    const artifactId = digest([request.uploadId, request.attachment.id]);
    const target = resolveAgentAttachmentArtifactPath({ appDataPath: join(root, 'appData'),
      teamName: f.team.definition.binding.teamName, messageId: request.uploadId, attachmentId: artifactId, fileName: 'payload' });
    const open = fs.openSync; let attempts = 0;
    t.mock.method(fs, 'openSync', ((path, flags, mode) => {
      if (path === dirname(target) && flags === fs.constants.O_RDONLY) {
        attempts++; throw Object.assign(new Error(`TEST directory sync ${code}`), { code });
      }
      return open(path, flags, mode);
    }) as typeof fs.openSync);
    syncBuiltinESMExports();
    const unsupported = code === 'EINVAL' || (process.platform === 'win32' && code === 'EPERM');
    try {
      if (unsupported) assert.ok(store.upload(request).reference);
      else {
        assert.throws(() => store.upload(request), { code });
        assert.equal(f.store.read<{ completed: boolean }>(`attachments/${artifactId}.json`)?.completed, false);
        assert.throws(() => store.upload(request), { code }, 'an identical retry cannot skip the failed durable sync');
      }
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.equal(attempts, unsupported ? 1 : 2);
    assert.equal(f.store.read<{ completed: boolean }>(`attachments/${artifactId}.json`)?.completed, unsupported);
    assert.deepEqual(readFileSync(target), NATIVE_MESSAGE_PNG);
    if (!unsupported) {
      const recovered = store.upload(request);
      assert.ok(recovered.reference); assert.equal(recovered.nextOffset, null);
      assert.equal(f.store.read<{ completed: boolean }>(`attachments/${artifactId}.json`)?.completed, true);
      assert.deepEqual(Buffer.from(store.resolve(recovered.reference).bytes), NATIVE_MESSAGE_PNG);
    }
  });
}

test('unsupported attachment directory sync cannot conceal a real descriptor close failure', async t => {
  const f = await fixture(t, false), root = join(f.root, 'тест close'), request = portableImageUpload();
  const store = new AttachmentArtifactStore(root, f.team.definition.binding, f.store);
  const artifactId = digest([request.uploadId, request.attachment.id]);
  const target = resolveAgentAttachmentArtifactPath({ appDataPath: join(root, 'appData'),
    teamName: f.team.definition.binding.teamName, messageId: request.uploadId, attachmentId: artifactId, fileName: 'payload' });
  const open = fs.openSync, sync = fs.fsyncSync, close = fs.closeSync;
  let directory: number | undefined, syncFailures = 0, closeFailures = 0;
  t.mock.method(fs, 'openSync', ((path, flags, mode) => {
    // The original payload descriptor allows the exact fault sequence on Windows,
    // where the real directory open may itself be unsupported.
    if (path === dirname(target) && flags === fs.constants.O_RDONLY)
      return directory = open(target, fs.constants.O_RDONLY);
    return open(path, flags, mode);
  }) as typeof fs.openSync);
  t.mock.method(fs, 'fsyncSync', ((fd: number) => {
    if (fd === directory) { syncFailures++; throw Object.assign(new Error('TEST unsupported directory sync'), { code: 'EINVAL' }); }
    return sync(fd);
  }) as typeof fs.fsyncSync);
  t.mock.method(fs, 'closeSync', ((fd: number) => {
    close(fd);
    if (fd === directory) { directory = undefined; closeFailures++; throw Object.assign(new Error('TEST real close failure'), { code: 'EIO' }); }
  }) as typeof fs.closeSync);
  syncBuiltinESMExports();
  try { assert.throws(() => store.upload(request), { code: 'EIO' }); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(syncFailures, 1); assert.equal(closeFailures, 1);
  assert.equal(f.store.read<{ completed: boolean }>(`attachments/${artifactId}.json`)?.completed, false);
  assert.deepEqual(readFileSync(target), NATIVE_MESSAGE_PNG);
});

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
  const { projectMemberInput } = await import('../dist/composition/projectMemberInput.js');
  const admittedProjection = projectMemberInput({ entry, storageRoot: f.root, input: intent,
    assertCurrent() {} });
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
    assert.equal(projected.content, admittedProjection.content);
    assert.deepEqual(projected.attachments, admittedProjection.attachments);
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
    // The V2 checkpoint binding is stable across runs, while this real Host
    // port must still validate the exact current owner/run/claimed input.
    const stableBinding = 'TEST-stable-V2-checkpoint-binding';
    const stableRequest = { ...request, trustedBinding: stableBinding };
    assert.equal(await delivery.port.resolve(stableRequest, signal), undefined);
    let current = true;
    const bridge = bindOpenCodeV2AttachmentPort(
      delivery.port,
      stableBinding,
      request.trustedBinding,
      () => current
    );
    const resolved = await bridge.resolve(stableRequest, signal);
    assert.deepEqual(resolved?.binding, stableRequest);
    assert.deepEqual(resolved?.bytes, files[0]!.bytes);
    assert.equal(sha(readFileSync(resolved!.nativePath!)), refs[0]!.digest);
    for (const foreign of [
      { trustedBinding: 'TEST-foreign-V2-binding' },
      { sessionRef: 'TEST-foreign-session' },
      { inputId: 'TEST-foreign-input' },
      { operationRef: 'TEST-foreign-operation' },
      { fingerprint: inputHash(original) },
      { reference: refs[1]! },
    ])
      assert.equal(await bridge.resolve({ ...stableRequest, ...foreign }, signal), undefined);
    const wrongRun = bindOpenCodeV2AttachmentPort(
      delivery.port,
      stableBinding,
      'TEST-backend/TEST-team/TEST-other-run/L',
      () => current
    );
    assert.equal(await wrongRun.resolve(stableRequest, signal), undefined);
    const getterReads = { model: 0, revision: 0, mimeTypes: 0, resolve: 0 };
    const capturedSource = {
      get model() {
        getterReads.model++;
        return delivery.port.model;
      },
      get revision() {
        getterReads.revision++;
        return delivery.port.revision;
      },
      get mimeTypes() {
        getterReads.mimeTypes++;
        return delivery.port.mimeTypes;
      },
      get resolve() {
        getterReads.resolve++;
        return async function (this: unknown, ...args: Parameters<typeof delivery.port.resolve>) {
          assert.equal(this, capturedSource);
          return delivery.port.resolve(...args);
        };
      },
    };
    const captured = bindOpenCodeV2AttachmentPort(
      capturedSource,
      stableBinding,
      request.trustedBinding,
      () => current
    );
    assert.deepEqual((await captured.resolve(stableRequest, signal))?.bytes, files[0]!.bytes);
    assert.deepEqual(getterReads, { model: 1, revision: 1, mimeTypes: 1, resolve: 1 });
    for (const field of [
      'trustedBinding',
      'sessionRef',
      'inputId',
      'operationRef',
      'fingerprint',
    ] as const) {
      const wrongReturn = bindOpenCodeV2AttachmentPort(
        {
          ...delivery.port,
          async resolve(binding, signal) {
            const value = await delivery.port.resolve(binding, signal);
            assert.ok(value);
            return { ...value, binding: { ...value.binding, [field]: 'TEST-swapped' } };
          },
        },
        stableBinding,
        request.trustedBinding,
        () => current
      );
      assert.equal(await wrongReturn.resolve(stableRequest, signal), undefined);
    }
    const revoked = bindOpenCodeV2AttachmentPort(
      {
        ...delivery.port,
        async resolve(binding, signal) {
          const value = await delivery.port.resolve(binding, signal);
          current = false;
          return value;
        },
      },
      stableBinding,
      request.trustedBinding,
      () => current
    );
    await assert.rejects(revoked.resolve(stableRequest, signal), /attachment authority revoked/);
    current = true;
    const aborted = AbortSignal.abort();
    await assert.rejects(bridge.resolve(stableRequest, aborted), { name: 'AbortError' });
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
    // This explicit TEST Codex capture has the same original base and effective profile.
    entry.baseProfile = structuredClone(entry.profile);
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
  const { claudeSessionCommands } = await import('../dist/adapters/providers/claudeSessionCommands.js');
  const nativeReview = { name: 'code-review', description: 'TEST native fork description', argumentHint: 'TEST native flags',
    builtin: true as const, aliases: ['review'], compatibility: { invocation: 'review' as const,
      execution: 'legacy-inline-review-v1' as const, description: 'Review a pull request in the current conversation.', argumentHint: '[pr number]' } };
  const review = claudeSessionCommands([nativeReview]);
  assert.deepEqual(review, [{ name: 'review', description: nativeReview.compatibility.description }]);
  assert.deepEqual(claudeSessionCommands([nativeReview, { name: 'review', description: 'TEST exact custom review', argumentHint: '<file>' }]),
    [{ name: 'review', description: 'TEST exact custom review' }], 'exact custom precedence does not inherit builtin compatibility');
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
    sessionCommands: () => [{ name: 'cost', description: 'TEST native cost', privatePath: '/TEST-private-command-path' }, ...review],
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
  assert.deepEqual(positive.sessionCommands, [{ name: 'cost', description: 'TEST native cost' }, ...review]);
  assert.equal(JSON.stringify(positive).includes('TEST-private-command-path'), false);
  assert.equal(JSON.stringify(positive).includes('legacy-inline-review-v1'), false, 'only existing public name/description leave the adapter');
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
    assert.equal(projection.sessionCommands, undefined);
  }
  ready = false;
  const stopped = projectRuntimeMember(options);
  assert.ok(stopped && typeof stopped === 'object' && !Array.isArray(stopped));
  assert.equal(stopped.attachmentCapabilities, undefined);
  assert.equal(stopped.sessionCommands, undefined);
});

test('native Host fixture admits only closed boolean and native media attachment capability projections', () => {
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
  const media = { revision: 'opencode-2.1.4-native-media-v1', videos: false,
    mimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'],
    maxBytes: 4 * 1024 * 1024, maxCount: 5, maxTotalBytes: 8 * 1024 * 1024 };
  for (const mimeTypes of [[], ['image/png'], ['application/pdf'], media.mimeTypes]) {
    assert.doesNotThrow(() => assertSafeRuntimeProjection({ ...safe, attachmentCapabilities: {
      images: mimeTypes.some(mime => mime.startsWith('image/')), documents: mimeTypes.includes('application/pdf'),
      textFiles: false, nativeMedia: { ...media, mimeTypes },
    } }));
  }
  for (const nativeMedia of [
    undefined, null, [], {},
    { ...media, revision: 'TEST-unknown' }, { ...media, videos: true },
    { ...media, privatePath: '/TEST-private' },
    { ...media, mimeTypes: ['image/png', 'application/pdf', 'video/mp4'] },
    { ...media, mimeTypes: ['image/png', 'application/pdf', 'image/png'] },
    { ...media, mimeTypes: ['image/png', 'application/pdf', null] },
    { ...media, mimeTypes: ['image/png'] }, { ...media, mimeTypes: ['application/pdf'] },
    ...(['maxBytes', 'maxCount', 'maxTotalBytes'] as const).flatMap(key =>
      [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, String(media[key]), media[key] + 1]
        .map(value => ({ ...media, [key]: value }))),
  ]) {
    assert.throws(() => assertSafeRuntimeProjection({ ...safe, attachmentCapabilities: {
      images: true, documents: true, textFiles: false, nativeMedia,
    } }));
  }
  assert.throws(() => assertSafeRuntimeProjection({ ...safe, privatePath: '/TEST-private' }));
  assert.throws(() => assertSafeRuntimeProjection({
    ...safe, inputs: [{ inputId: 'TEST-input', operationRef: 'TEST-private' }],
  }));
  assert.throws(() => assertSafeRuntimeProjection({ ...safe, diagnostic: 'Bearer TEST-private' }));
  assert.doesNotThrow(() => assertSafeRuntimeProjection({ ...safe, sessionCommands: [] }));
  assert.throws(() => assertSafeRuntimeProjection({ ...safe,
    sessionCommands: [{ name: 'cost', description: 'TEST cost', nativePath: '/TEST-private' }],
  }));
  assert.throws(() => assertSafeRuntimeProjection({ ...safe,
    sessionCommands: [{ name: 'cost', description: 'TEST cost' }, { name: 'cost', description: 'duplicate' }],
  }));
});

for (const removed of ['owner', 'team'] as const) {
  test('read-only attachment namespace does not recreate a missing ' + removed + ' directory', async t => {
    const f = await fixture(t), entry = f.lead;
    const artifacts = new AttachmentArtifactStore(f.root, f.team.definition.binding, f.store);
    const bytes = Buffer.from('TEST retained original file');
    const uploaded = artifacts.upload({
      uploadId: 'TEST-namespace-file', purpose: { kind: 'message', member: 'leader' },
      attachment: { id: 'TEST-namespace-file', filename: 'original.zip', mimeType: 'application/zip', size: bytes.length },
      digest: sha(bytes), offset: 0, base64: bytes.toString('base64'),
    });
    assert.ok(uploaded.reference);
    const reference = uploaded.reference;
    const nativePath = artifacts.resolve(reference).nativePath;
    const teamDirectory = join(f.root, 'teams', entry.delivery.teamName);
    const directory = removed === 'owner' ? join(teamDirectory, '.host-owner') : teamDirectory;
    rmSync(directory, { recursive: true });
    assert.throws(() => new TeamOwnerStore(f.root, entry.delivery.teamName, { createNamespace: false }), /hold/);
    assert.equal(existsSync(directory), false);
    const { projectMemberInput } = await import('../dist/composition/projectMemberInput.js');
    assert.throws(() => projectMemberInput({ entry, storageRoot: f.root,
      input: { content: 'TEST original', attachments: [reference] }, assertCurrent() {} }), /hold/);
    assert.equal(existsSync(directory), false);
    assert.deepEqual(readFileSync(nativePath), bytes);
    const ordinary = new TeamOwnerStore(f.root, entry.delivery.teamName);
    assert.equal(existsSync(ordinary.directory), true, 'ordinary namespace creation remains available');
  });
}

test('context budgets the exact attachment suffix and retains original prefix plus raw proof bytes', async t => {
  const f = await fixture(t), entry = f.lead;
  const { projectMemberInput } = await import('../dist/composition/projectMemberInput.js');
  const artifacts = new AttachmentArtifactStore(f.root, f.team.definition.binding, f.store);
  const refs = [
    { id: 'TEST-budget-image', filename: 'image.png', mimeType: 'image/png', bytes: NATIVE_MESSAGE_PNG },
    { id: 'TEST-budget-file', filename: 'план<漢>.zip', mimeType: 'application/zip', bytes: Buffer.from('TEST file') },
  ].map(file => {
    const uploaded = artifacts.upload({ uploadId: file.id,
      purpose: { kind: 'message', member: 'leader' },
      attachment: { id: file.id, filename: file.filename, mimeType: file.mimeType, size: file.bytes.length },
      digest: sha(file.bytes), offset: 0, base64: file.bytes.toString('base64'),
    });
    assert.ok(uploaded.reference);
    return uploaded.reference;
  });
  const intent = { binding: entry.binding, deliveryId: 'TEST-budget-delivery',
    inputId: 'TEST-budget-input', messageId: 'TEST-budget-message', content: 'TEST original content', attachments: refs };
  const projected = projectMemberInput({ entry, storageRoot: f.root, input: intent, assertCurrent() {} });
  assert.deepEqual(projected.attachments, [refs[0]]);
  assert.ok(Buffer.byteLength(projected.content) > Buffer.byteLength(intent.content));
  const callbacks = createTeamContextPreparation({ entries: f.entries, principalId: 'profile-admin',
    storageRoot: f.root, assertCurrent() {} });
  const request = { sessionRef: f.drivers.get('L:1')!.sessionRef, inputId: intent.inputId,
    operationRef: 'TEST-budget-operation', intentFingerprint: deliveryFingerprint(intent),
    originalContent: intent.content, originalContentBytes: Buffer.byteLength(intent.content),
    attachments: refs, epochs: [], priorProofs: [] };
  const prepare = f.owner.contextReminders.prepare.bind(f.owner.contextReminders);
  let offered: number | undefined;
  t.mock.method(f.owner.contextReminders, 'prepare',
    (...args: Parameters<typeof f.owner.contextReminders.prepare>) => {
      offered = args[1].maxPrefixBytes;
      return prepare(...args);
    });
  const statePath = join(f.root, 'teams', entry.delivery.teamName, '.host-owner', 'state.json');
  const before = readFileSync(statePath, 'utf8');
  const setBound = (bytes: number) => {
    entry.profile.limits.inputBytes = entry.baseProfile.limits.inputBytes = bytes;
  };
  const exactBytes = Buffer.byteLength(projected.content);
  setBound(exactBytes - 1);
  assert.throws(() => callbacks.prepareInput!(entry.binding, request), /hold/);
  assert.equal(offered, undefined, 'oversized original refuses before preparing any Team context');
  setBound(exactBytes);
  assert.equal(callbacks.prepareInput!(entry.binding, request), undefined);
  assert.equal(offered, 0);
  setBound(exactBytes + 17);
  assert.equal(callbacks.prepareInput!(entry.binding, request), undefined);
  assert.equal(offered, 17, 'native binary media does not consume the text prefix budget');
  const epoch = { sessionRef: request.sessionRef, sourceRef: 'TEST-prefix-epoch',
    epochId: runtimeDigest({ binding: entry.binding, sessionRef: request.sessionRef, sourceRef: 'TEST-prefix-epoch' }) };
  assert.throws(() => callbacks.prepareInput!(entry.binding, { ...request, epochs: [epoch] }), /hold/);
  assert.equal(readFileSync(statePath, 'utf8'), before, 'an unfit mandatory prefix has no preparation write');
  setBound(exactBytes + 64 * 1024);
  const prepared = callbacks.prepareInput!(entry.binding, { ...request, epochs: [epoch] });
  assert.ok(prepared);
  const native = projectMemberInput({ entry, storageRoot: f.root,
    input: { content: prepared.prefix + intent.content, attachments: refs }, assertCurrent() {} });
  assert.equal(native.content, prepared.prefix + projected.content);
  assert.ok(Buffer.byteLength(native.content) <= entry.profile.limits.inputBytes);
  assert.deepEqual(native.attachments, [refs[0]]);
  assert.equal(request.originalContent, intent.content);
  assert.equal(request.intentFingerprint, deliveryFingerprint(intent));
});

test('context holds changed original profiles without attachments and accepts the original selected profile', async t => {
  const f = await fixture(t), entry = f.lead;
  const callbacks = createTeamContextPreparation({ entries: f.entries, principalId: 'profile-admin',
    storageRoot: f.root, assertCurrent() {} });
  const request = { sessionRef: f.drivers.get('L:1')!.sessionRef, inputId: 'TEST-profile-input',
    operationRef: 'TEST-profile-operation', intentFingerprint: 'c'.repeat(64),
    originalContent: 'TEST profile', originalContentBytes: 12, epochs: [], priorProofs: [] };
  assert.equal(callbacks.prepareInput!(entry.binding, request), undefined);
  const before = readFileSync(join(f.root, 'teams', entry.delivery.teamName, '.host-owner', 'state.json'), 'utf8');
  entry.profile.limits.inputBytes++;
  assert.throws(() => callbacks.prepareInput!(entry.binding, request), /hold/);
  assert.equal(readFileSync(join(f.root, 'teams', entry.delivery.teamName, '.host-owner', 'state.json'), 'utf8'), before);
  entry.selection = { binding: entry.binding, generation: entry.profile.generation,
    baseConfigurationDigest: runtimeDigest(entry.baseProfile), configurationDigest: runtimeDigest(entry.profile) };
  assert.equal(callbacks.prepareInput!(entry.binding, request), undefined,
    'an actual selected profile can differ from its separately pinned original base');
  entry.selection.baseConfigurationDigest = 'd'.repeat(64);
  assert.throws(() => callbacks.prepareInput!(entry.binding, request), /hold/);
});
