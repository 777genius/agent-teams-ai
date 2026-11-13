import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { acquireProfileWriterLease } from '../dist/adapters/profile/ProfileWriterLease.js';
import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { RuntimeOwner } from '../dist/runtime/RuntimeOwner.js';
import { deliveryFingerprint } from '../dist/runtime/identity.js';
import { startTeamMcpEndpoint } from '../dist/mcp/index.js';
import { cleanupCapturedCodexChild, nativeCodexDriver, projectCodexMetadataObservation } from './fixtures/native-codex-team/driver.ts';
import { record, startCodexModel } from './fixtures/native-codex-team/model.ts';
import type { CommandReceipt, DeliveryBinding, TeamCommand } from '../dist/team/contracts.js';
import type { RuntimeBinding, RuntimeSessionRecord } from '../dist/runtime/contracts.js';
import type { Event, Input, Session } from '@agent-teams/provider-session-contracts';

const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const tick = () => new Promise<void>((done) => setTimeout(done, 20));

test(
  'native Codex + authoritative Team MCP + durable Runtime dispatch: two business messages',
  { timeout: 180_000 },
  async (t) => {
    const candidateDeadline = performance.now() + 180_000;
    const candidateVersion = process.env.LEGACY_CODEX_CANDIDATE_VERSION;
    assert.ok(candidateVersion === undefined || candidateVersion === '0.169.0', 'finite explicit candidate mode');
    assert.equal(
      process.env.LEGACY_CODEX_TEAM_GO,
      '1',
      'explicit root GO required; this native scenario is outside the regular test glob'
    );
    const repo = resolve(import.meta.dirname, '../../..');
    const selectedNode = await realpath(
      join(repo, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node')
    );
    assert.equal(
      await realpath(process.execPath),
      selectedNode,
      'native test itself runs with the captured standalone Node, not Electron or PATH'
    );
    const selectedArtifact = process.env.LEGACY_NATIVE_PROVIDER_ARTIFACT;
    const expectedProviderSha = process.env.LEGACY_NATIVE_PROVIDER_SHA256;
    assert.ok(selectedArtifact, 'root supplies the selected successor artifact path');
    assert.match(
      expectedProviderSha ?? '',
      /^[a-f0-9]{64}$/,
      'root supplies the expected exact provider artifact SHA256'
    );
    const providerArtifact = await realpath(resolve(repo, selectedArtifact));
    assert.equal(
      await hash(providerArtifact),
      expectedProviderSha,
      'selected provider artifact bytes match the root-authorized native run'
    );
    const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-codex-team-')));
    for (const directory of [
      'workspace',
      'codex-home',
      'home',
      'config',
      'tmp',
      'xdg-config',
      'xdg-data',
      'xdg-cache',
      'data',
      'cache',
      'store',
    ])
      await mkdir(join(root, directory), { mode: 0o700 });
    const storeRoot = join(root, 'store');
    const lease = acquireProfileWriterLease(storeRoot);
    let setupComplete = false;
    const setupCleanup: (() => void | Promise<void>)[] = [() => lease.release()];
    t.after(async () => {
      if (setupComplete) return;
      const failures: unknown[] = [];
      for (const cleanup of setupCleanup.toReversed()) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
      assert.deepEqual(failures, [], 'partially allocated TEST setup was disposed');
    });
    const namespace = basename(root);
    const teamBinding = {
      backendId: `TEST-backend-${namespace}`,
      teamId: 'TEST-team',
      teamName: 'test-codex-team',
    };
    const delivery: DeliveryBinding = {
      ...teamBinding,
      runId: `TEST-run-${namespace}`,
      memberId: 'bob-id',
      generation: '1',
    };
    const binding: RuntimeBinding = {
      backendId: delivery.backendId,
      teamId: delivery.teamId,
      runId: delivery.runId,
      memberId: delivery.memberId,
      generation: delivery.generation,
    };
    const owner = createFilesystemTeamOwner({
      root: storeRoot,
      binding: teamBinding,
      members: [{ memberId: 'bob-id', name: 'bob', role: 'member', delivery }],
      grants: [
        {
          principalId: 'human',
          memberName: 'user',
          permissions: ['read', 'message.write', 'task.write', 'admin'],
        },
        {
          principalId: 'bob-session',
          memberName: 'bob',
          permissions: ['read', 'message.write', 'task.write'],
        },
      ],
    });
    const current = (candidate: Readonly<DeliveryBinding>) => {
      lease.assertCurrent();
      return (
        JSON.stringify(candidate) === JSON.stringify(delivery) &&
        owner.authorizeMemberBinding(candidate, 'dispatch')
      );
    };
    const endpoint = await startTeamMcpEndpoint({
      connection: owner.connect('bob-session'),
      binding: delivery,
      expiresAtMs: Date.now() + 180_000,
      isCurrentBinding: current,
    });
    setupCleanup.push(() => endpoint.close());
    let candidateModel = '';
    const model = await startCodexModel(candidateVersion ? { candidate169: { selectedModel: () => candidateModel } } : {});
    setupCleanup.push(() => model.close());
    if (candidateVersion) {
      assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
      assert.equal(process.version, 'v24.21.0');
      assert.equal(expectedProviderSha, '07241cca756e69aa6001df41d6a7408aad5d8ab4c8277f9d70f35d0d66736c73');
      await runCodexCandidate({ root, selectedNode, providerArtifact, deadline: candidateDeadline,
        owner, delivery, endpoint, model, selectModel: value => { candidateModel = value; },
        current: () => current(delivery), cleanup: setupCleanup,
        onDisposed: () => { setupComplete = true; } });
      return;
    }
    const binary = '/Users/belief/.codex/packages/standalone/releases/0.162.0-aarch64-apple-darwin/bin/codex';
    const binarySha = await hash(binary);
    assert.equal(binarySha, '8238273076041e55beded03ba1d51e034f997b7d100b0642d36daf036620fe57');
    const binaryVersion = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000,
      env: { HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex-home'), TMPDIR: join(root, 'tmp'), PATH: '/usr/bin:/bin' } }).trim();
    assert.equal(binaryVersion, 'codex-cli 0.162.0');
    const native = await nativeCodexDriver({
      root,
      binary,
      modelUrl: model.url,
      endpoint,
      currentBinding: () => current(delivery),
      onCapturedChild: (child) => {
        setupCleanup.push(() => cleanupCapturedCodexChild(child));
      },
    });
    const runtime = new RuntimeOwner({
      store: new FileRuntimeStore(storeRoot),
      driverFactory: native.factory,
      profileId: 'TEST-native-codex-profile',
      hostIncarnation: 'TEST-native-host-1',
      authorize: (candidate, action, intent) => {
        lease.assertCurrent();
        return (
          owner.authorizeMemberBinding(candidate, action) &&
          (!intent || owner.authorizeDeliveryIntent(intent))
        );
      },
      canDispatch: (candidate) =>
        JSON.stringify(candidate) === JSON.stringify(binding) && native.canDispatch(),
    });
    const human = owner.connect('human');
    const bob = owner.connect('bob-session');
    const businessReceipts: CommandReceipt[] = [];
    let final: RuntimeSessionRecord | undefined;
    let passed = false;
    const artifacts = {
      node: { path: selectedNode, sha256: await hash(selectedNode), version: process.version },
      provider: { path: providerArtifact, sha256: await hash(providerArtifact) },
      providerEntry: import.meta.resolve('@agent-teams/provider-implementations/codex'),
    };
    setupComplete = true;
    try {
      const opened = await runtime.openSession({
        binding,
        config: {
          tenantId: 'TEST-tenant',
          projectId: 'TEST-project',
          sessionId: native.config.binding.sessionId,
          generation: 1,
          configRevision: native.config.configRevision,
          requiredCapabilities: ['text', 'tools'],
        },
      });
      assert.equal(opened.phase, 'allocated');
      assert.equal(opened.nativeReady, true, 'real D MCP discovery/readiness succeeded');
      assert.equal(
        native.canDispatch(),
        true,
        'same-binding native MCP discovery plus accepted thread context'
      );

      for (const label of ['ONE', 'TWO'] as const) {
        const command: TeamCommand = {
          commandId: `human-native-${label.toLowerCase()}`,
          operation: 'message.send',
          payload: { to: 'bob', text: `CODEX_TEAM_${label}` },
        };
        const receipt = human.execute(command);
        assert.equal(receipt.phase, 'completed');
        assert.equal(receipt.principalId, 'human');
        businessReceipts.push(receipt);
        const intent = human.pendingDeliveries()[0];
        assert.ok(intent);
        assert.equal(intent.messageId, receipt.effects.messageId);
        assert.equal(intent.inputId, receipt.effects.deliveryId);
        assert.equal(owner.authorizeDeliveryIntent(intent), true);
        const resumed = await owner.resumeDeliveries({
          fingerprintDelivery: deliveryFingerprint,
          admitDelivery: (intent) => runtime.admitDelivery(intent),
          lookupDelivery: (intent) => runtime.lookupDelivery(intent),
        });
        assert.deepEqual(
          resumed.map((item) => item.outcome),
          ['admitted']
        );
        assert.equal(
          native.submitted.length,
          label === 'ONE' ? 0 : 1,
          'business commit/admission do not submit directly'
        );
        await runtime.dispatchNext(binding);
        const deadline = Date.now() + 60_000;
        let input = runtime
          .readSession(binding)
          .record?.inputs.find((item) => item.intent.inputId === intent.inputId);
        while (Date.now() < deadline && input?.phase !== 'terminal') {
          assert.deepEqual(model.failures, []);
          await tick();
          input = runtime
            .readSession(binding)
            .record?.inputs.find((item) => item.intent.inputId === intent.inputId);
        }
        assert.equal(
          input?.phase,
          'terminal',
          'durable Runtime terminal from actual native result'
        );
        assert.equal(input.terminal, 'succeeded');
        const ownEvents = native.events.filter(
          (event) => event.operationRef === input.operationRef
        );
        assert.ok(ownEvents.length > 0);
        assert.ok(
          ownEvents.every(
            (event) =>
              event.sessionRef === native.config.binding.sessionId &&
              event.inputId === input.intent.inputId
          )
        );
        assert.equal(ownEvents.filter((event) => event.kind === 'result').length, 1);
        assert.ok(
          ownEvents.some(
            (event) =>
              event.kind === 'text' &&
              event.phase === 'complete' &&
              event.text === `DONE_CODEX_TEAM_${label}`
          )
        );
        const before = native.submitted.length;
        assert.deepEqual(
          human.execute(command),
          receipt,
          'replay returns original business receipt'
        );
        assert.deepEqual(
          await owner.resumeDeliveries({
            fingerprintDelivery: deliveryFingerprint,
            admitDelivery: (intent) => runtime.admitDelivery(intent),
            lookupDelivery: (intent) => runtime.lookupDelivery(intent),
          }),
          []
        );
        await runtime.dispatchNext(binding);
        assert.equal(
          native.submitted.length,
          before,
          'receipt replay/outbox recovery cannot resubmit'
        );
      }
      const task = human.listTasks()[0];
      assert.ok(task);
      assert.equal(human.listTasks().length, 1);
      assert.equal(task.status, 'completed');
      assert.equal(task.owner, 'bob');
      assert.equal(task.createdBy, 'bob');
      assert.ok((task.historyEvents as unknown[]).every(event => record(event).actor === 'bob'));
      assert.equal(record((task.comments as unknown[])[0]).author, 'bob');
      assert.equal((task.comments as unknown[]).length, 1);
      for (const id of [
        'codex-task-create',
        'codex-task-assign',
        'codex-task-start',
        'codex-task-comment',
        'codex-task-complete',
        'codex-reply-one',
        'codex-reply-two',
      ]) {
        const receipt = bob.lookup(id);
        assert.ok(receipt);
        assert.equal(receipt.phase, 'completed');
        assert.equal(receipt.principalId, 'bob-session');
        assert.deepEqual(receipt.binding, teamBinding);
      }
      const inbox = JSON.parse(
        await readFile(join(storeRoot, 'teams', teamBinding.teamName, 'inboxes/user.json'), 'utf8')
      ) as unknown[];
      assert.deepEqual(
        inbox.map((value) => ({ from: record(value).from, text: record(value).text })),
        [
          { from: 'bob', text: 'REPLY_CODEX_ONE' },
          { from: 'bob', text: 'REPLY_CODEX_TWO' },
        ]
      );
      assert.equal(new Set(inbox.map((value) => record(value).messageId)).size, 2);
      assert.equal(await readFile(join(root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\nTWO\n');
      assert.equal(native.submitted.length, 2);
      assert.equal(new Set(native.submitted.map((input) => input.inputId)).size, 2);
      assert.equal(
        native.events.filter((event) => event.kind === 'tool' && event.name === 'Bash').length,
        2
      );
      assert.ok(
        native.events.some((event) => event.kind === 'tool-result' && event.isError),
        'failed native command is observed independently of successful conversation completion'
      );
      assert.deepEqual(model.failures, []);
      assert.equal(model.observations.length, 11);
      assert.ok(model.observations.every((item) => item.contextEffective));
      assert.ok(
        model.observations
          .filter((item) => item.turn === 'CODEX_TEAM_TWO')
          .every((item) => item.priorTurn)
      );
      final = await runtime.stopSession(binding);
      assert.equal(final.phase, 'closed');
      assert.equal(final.custody, 'released');
      assert.ok(native.childFacts().length > 0);
      assert.ok(
        native.childFacts().every((child) => child.exitCode !== null || child.signalCode !== null)
      );
      passed = true;
    } finally {
      try {
        final ??= await runtime.stopSession(binding);
      } finally {
        try {
          await native.cleanup();
        } finally {
          try {
            await endpoint.close();
          } finally {
            await model.close();
            lease.release();
          }
        }
      }
      const receiptPath = join(root, 'receipt.json');
      await writeFile(
        receiptPath,
        JSON.stringify(
          {
            status: passed ? 'PASS' : 'INCOMPLETE',
            scope:
              'First single-member Team/filesystem + Runtime/durable input + authoritative MCP + actual Codex app-server slice',
            artifacts,
            binding,
            businessReceipts,
            runtime: final,
            events: native.events,
            nativeSubmits: native.submitted,
            nativeBinary: { path: binary, sha256: binarySha, version: binaryVersion },
            nativeConfigurationProofs: native.facts,
            nativeChildren: native.childFacts(),
            modelObservations: model.observations,
            modelFailures: model.failures,
            safeDiagnostic: native.safeDiagnostic(),
            excluded: [
              'Team aggregate bootstrap/partial launch',
              'Mixed providers/peer/group/cross-team',
              'UI/P5/P8',
              'Review/capture/attachments',
              'Real auth/model qualification',
              'Fault recovery and escaped descendant containment',
            ],
          },
          null,
          2
        ),
        { mode: 0o600 }
      );
      console.log(JSON.stringify({ status: passed ? 'PASS' : 'INCOMPLETE', receipt: receiptPath }));
    }
  }
);

const candidateArchive = {
  name: 'codex-npm-darwin-arm64-0.169.0.tgz', bytes: 153831622,
  sha256: 'd67d443253294438a21fde15753d7c1174e6a32147d842eb84428479d664c93d',
};
async function candidateDigest(path: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest('hex');
}
async function readCodexCandidateInputs() {
  const supplied = process.env.LEGACY_CODEX_CANDIDATE_INPUTS;
  assert.ok(supplied && supplied.endsWith('/codex-0.169.0/input-pins.json'));
  const receiptPath = await realpath(supplied);
  assert.equal(receiptPath, supplied, 'original canonical private TEST inputs');
  const stage = dirname(receiptPath);
  assert.match(stage, /^\/private\/tmp\/TEST-stage1-inputs-[^/]+\/codex-0\.169\.0$/);
  const stageStat = await lstat(stage);
  assert.ok(stageStat.isDirectory() && (stageStat.mode & 0o777) === 0o700 && stageStat.uid === process.getuid?.());
  const archive = join(stage, candidateArchive.name);
  const archiveStat = await lstat(archive);
  assert.ok(archiveStat.isFile() && archiveStat.nlink === 1);
  assert.equal(archiveStat.size, candidateArchive.bytes);
  assert.equal(await candidateDigest(archive), candidateArchive.sha256, 'official full package before parsing');
  const receiptStat = await lstat(receiptPath);
  assert.ok(receiptStat.isFile() && receiptStat.nlink === 1 && receiptStat.size <= 256 * 1024);
  const bytes = await readFile(receiptPath);
  const pins = record(JSON.parse(bytes.toString('utf8')) as unknown);
  assert.deepEqual(Object.keys(pins).sort(), ['archive', 'files', 'kind', 'target', 'version']);
  assert.equal(pins.kind, 'TEST_CODEX_CANDIDATE_INPUTS_V1');
  assert.equal(pins.version, '0.169.0');
  assert.equal(pins.target, 'aarch64-apple-darwin');
  assert.deepEqual(pins.archive, candidateArchive);
  assert.ok(Array.isArray(pins.files) && pins.files.length > 0 && pins.files.length <= 512);
  const rows = pins.files.map(record);
  const names = rows.map(row => {
    assert.deepEqual(Object.keys(row).sort(), ['bytes', 'mode', 'path', 'sha256']);
    assert.ok(typeof row.path === 'string' && row.path.startsWith('package/') &&
      row.path.length <= 4096 && !/[\\\0-\x1f\x7f]/.test(row.path) &&
      row.path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..'));
    assert.ok(Number.isSafeInteger(row.bytes) && Number(row.bytes) >= 0 && Number(row.bytes) <= 1024 ** 3);
    assert.ok(Number.isSafeInteger(row.mode) && Number(row.mode) >= 0 && Number(row.mode) <= 0o777);
    assert.match(String(row.sha256), /^[a-f0-9]{64}$/);
    return row.path;
  });
  assert.deepEqual(names, [...new Set(names)].sort(), 'complete canonical ordered package manifest');
  assert.ok(rows.reduce((total, row) => total + Number(row.bytes), 0) <= 2 * 1024 ** 3);
  const verify = async () => {
    assert.equal(await hash(receiptPath), createHash('sha256').update(bytes).digest('hex'));
    const actual: string[] = [];
    let visited = 0;
    const walk = async (path: string): Promise<void> => {
      assert.ok(++visited <= 1024 && path.split('/').length <= 16, 'bounded complete package inventory');
      const info = await lstat(join(stage, path));
      assert.equal(await realpath(join(stage, path)), join(stage, path), 'no redirected package member');
      if (info.isDirectory()) {
        for (const name of (await readdir(join(stage, path))).sort()) await walk(path + '/' + name);
      } else {
        assert.ok(info.isFile() && info.nlink === 1, 'regular original package member');
        assert.ok(actual.length < 512);
        actual.push(path);
      }
    };
    await walk('package');
    assert.deepEqual(actual.sort(), names);
    for (const row of rows) {
      const path = join(stage, String(row.path)), info = await lstat(path);
      assert.equal(info.mode & 0o7000, 0);
      assert.equal(info.size, row.bytes);
      assert.equal(info.mode & 0o777, row.mode);
      assert.equal(await candidateDigest(path), row.sha256);
    }
  };
  await verify();
  const target = 'package/vendor/aarch64-apple-darwin/';
  const npm = record(JSON.parse(await readFile(join(stage, 'package/package.json'), 'utf8')) as unknown);
  assert.equal(npm.name, '@openai/codex');
  assert.equal(npm.version, '0.169.0-darwin-arm64');
  assert.deepEqual(npm.os, ['darwin']); assert.deepEqual(npm.cpu, ['arm64']);
  const layout = record(JSON.parse(await readFile(join(stage, target, 'codex-package.json'), 'utf8')) as unknown);
  assert.equal(layout.layoutVersion, 1); assert.equal(layout.version, '0.169.0');
  assert.equal(layout.target, 'aarch64-apple-darwin'); assert.equal(layout.variant, 'codex');
  assert.equal(layout.entrypoint, 'bin/codex');
  assert.equal(layout.resourcesDir, 'codex-resources'); assert.equal(layout.pathDir, 'codex-path');
  for (const executable of ['bin/codex', 'bin/codex-code-mode-host', 'codex-path/rg'])
    assert.ok(names.includes(target + executable) && ((await lstat(join(stage, target, executable))).mode & 0o111) !== 0);
  return { binary: join(stage, target, 'bin/codex'), verify,
    evidence: { ...pins, manifestSha256: createHash('sha256').update(bytes).digest('hex') } };
}

async function runCodexCandidate(options: {
  root: string; selectedNode: string; providerArtifact: string; deadline: number;
  owner: ReturnType<typeof createFilesystemTeamOwner>; delivery: DeliveryBinding;
  endpoint: Awaited<ReturnType<typeof startTeamMcpEndpoint>>;
  model: Awaited<ReturnType<typeof startCodexModel>>; selectModel(model: string): void;
  current(): boolean; cleanup: (() => void | Promise<void>)[]; onDisposed(): void;
}) {
  const { root, owner, model } = options;
  const workspace = join(root, 'workspace'), effect = join(workspace, 'native-effect.txt');
  const remaining = (cap = 30_000) => {
    const value = Math.min(cap, Math.ceil(options.deadline - performance.now()));
    assert.ok(value > 0, 'original 180s candidate budget remains');
    return value;
  };
  const within = async <T>(work: () => Promise<T>, cap = 30_000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const until = performance.now() + remaining(cap);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('TEST original candidate deadline')), Math.max(1, until - performance.now()));
      });
      const result = await Promise.race([work(), timeout]);
      assert.ok(performance.now() < until, 'late completion cannot renew the original phase budget');
      remaining();
      return result;
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const children: ChildProcess[] = [];
  const drivers: Awaited<ReturnType<typeof nativeCodexDriver>>[] = [];
  const sessions: Session[] = [];
  const consumers: Promise<void>[] = [];
  const business: CommandReceipt[] = [];
  const closes: unknown[] = [];
  let pins: Awaited<ReturnType<typeof readCodexCandidateInputs>> | undefined;
  let catalog: unknown, chosen = '', nativeVersion = '', originalShell = '', checkpointEvidence: unknown, permission: unknown, interruption: unknown;
  let firstFailure: unknown, passed = false, approvalCount = 0, checkpointReads = 0;
  let observationFailure: unknown;
  const human = owner.connect('human'), bob = owner.connect('bob-session');
  const make = async (candidate: NonNullable<Parameters<typeof nativeCodexDriver>[0]['candidate']>) => {
    assert.ok(pins);
    remaining(); await pins.verify(); remaining();
    const driver = await nativeCodexDriver({ root, binary: pins.binary, modelUrl: model.url,
      endpoint: options.endpoint, currentBinding: options.current, candidate,
      onCapturedChild: child => { children.push(child); options.cleanup.push(() => cleanupCapturedCodexChild(child)); } });
    drivers.push(driver);
    remaining();
    return driver;
  };
  const originalInput = (label: 'ONE' | 'TWO'): Input => {
    remaining(); assert.equal(options.current(), true);
    const receipt = human.execute({ commandId: 'human-candidate-' + label.toLowerCase(),
      operation: 'message.send', payload: { to: 'bob', text: 'CODEX_TEAM_' + label } });
    assert.equal(receipt.phase, 'completed'); assert.equal(receipt.principalId, 'human');
    const intent = human.pendingDeliveries().find(item => item.messageId === receipt.effects.messageId);
    assert.ok(intent && owner.authorizeDeliveryIntent(intent));
    assert.equal(intent.inputId, receipt.effects.deliveryId);
    business.push(receipt);
    return { inputId: intent.inputId, operationRef: 'TEST-candidate-operation-' + label,
      content: 'CODEX_TEAM_' + label };
  };
  const observe = (session: Session, native: (typeof drivers)[number], input: Input, label: 'ONE' | 'TWO', deadline: number) => {
    let terminal: Extract<Event, { kind: 'result' }> | undefined;
    const consume = (async () => {
      for await (const event of session.observe()) {
        assert.equal(event.sessionRef, session.sessionRef);
        if (event.operationRef !== undefined) {
          assert.equal(event.operationRef, input.operationRef); assert.equal(event.inputId, input.inputId);
        }
        if (event.kind === 'interaction') {
          assert.equal(label, 'ONE'); assert.equal(approvalCount, 0);
          assert.equal(event.operationRef, input.operationRef); assert.equal(event.inputId, input.inputId);
          if (event.request.kind !== 'permission') throw new Error('TEST candidate requires original permission');
          assert.equal(event.request.tool, 'Bash');
          const actual = record(event.request.input), original = native.candidateWire.approvals[0];
          assert.ok(original && native.candidateWire.approvals.length === 1);
          assert.equal(original.kind, 'command');
          assert.equal(original.threadId, native.facts.threadId);
          assert.equal(original.turnId, native.candidateWire.turns[0]);
          assert.ok(original.itemId.length > 0);
          assert.equal(actual.provider, 'codex');
          assert.equal(actual.providerRequestId, original.providerRequestId);
          assert.equal(actual.command, original.command);
          assert.equal(actual.cwd, workspace); assert.equal(original.cwd, workspace);
          // 0.169 get_command + shlex1.3 preserve this exact three-argument login-shell invocation.
          assert.equal(userInfo().shell, originalShell);
          assert.equal(original.command, originalShell + ' -lc ' + JSON.stringify("printf 'ONE\\n' >> native-effect.txt; exit 7"));
          await assert.rejects(readFile(effect), { code: 'ENOENT' });
          assert.equal((await within(() => Promise.resolve(session.respondToInteraction(event.interactionRef,
            { kind: 'permission', decision: 'allow' })), deadline - performance.now())).ok, true);
          approvalCount += 1;
          permission = { sessionRef: event.sessionRef, inputId: event.inputId, operationRef: event.operationRef,
            interactionRef: event.interactionRef, native: original, effectBefore: 'absent', allowed: true };
        }
        if (event.kind === 'result') {
          assert.equal(event.operationRef, input.operationRef); assert.equal(event.inputId, input.inputId);
          assert.equal(terminal, undefined, 'one original terminal');
          terminal = event;
        }
      }
    })().catch((error: unknown) => { observationFailure ??= error; });
    consumers.push(consume);
    return () => terminal;
  };
  const wait = async (predicate: () => boolean, deadline: number) => {
    while (!predicate() && performance.now() < deadline) {
      if (observationFailure !== undefined) throw observationFailure;
      assert.deepEqual(model.failures, []); remaining(); await tick();
    }
    if (observationFailure !== undefined) throw observationFailure;
    assert.deepEqual(model.failures, []); remaining();
    assert.ok(performance.now() < deadline, 'original input deadline remains');
    assert.equal(predicate(), true, 'original bounded native phase completed');
  };
  const open = async (native: (typeof drivers)[number], checkpointRef?: string) => {
    const opened = await within(() => native.factory.open({ ...native.config.binding,
      configRevision: native.config.configRevision,
      requiredCapabilities: ['text', 'tools', 'permission', 'interrupt', 'checkpoint'],
      ...(checkpointRef === undefined ? {} : { checkpointRef }) }).then(value => {
        sessions.push(value.driver); return value;
      }));
    assert.equal((await within(() => opened.driver.checkReadiness())).ok, true);
    assert.equal(native.canDispatch(), true);
    return opened.driver;
  };
  const close = async (session: Session, native: (typeof drivers)[number]) => {
    const receipt = await within(() => session.close());
    closes.push(receipt);
    assert.deepEqual(receipt, { logicallyClosed: true, cleanup: 'confirmed' });
    assert.ok(native.childFacts().every(child => child.exitCode !== null || child.signalCode !== null));
  };
  try {
    assert.ok(process.getuid && process.geteuid);
    assert.equal(process.getuid(), process.geteuid(), 'Node and native passwd lookups identify the same account');
    const shell = userInfo().shell;
    assert.ok(typeof shell === 'string' && /^\/bin\/(?:sh|bash|zsh)$/.test(shell));
    originalShell = shell; // Read-only native default-shell fact; SHELL env is not its selector.
    pins = await readCodexCandidateInputs(); remaining();
    nativeVersion = execFileSync(pins.binary, ['--version'], { encoding: 'utf8', timeout: remaining(10_000),
      env: { HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex-home'),
        TMPDIR: join(root, 'tmp'), PATH: '/usr/bin:/bin' } }).trim();
    assert.equal(nativeVersion, 'codex-cli 0.169.0');
    const metadata = await make({ version: '0.169.0', phase: 'catalog', deadline: options.deadline });
    const discovered = await within(() => metadata.readCandidateCatalog());
    assert.ok(metadata.childFacts().every(child => child.exitCode !== null || child.signalCode !== null));
    assert.equal(model.observations.length, 0); assert.equal(business.length, 0);
    const visible = discovered.page.data.filter(row => !row.hidden && row.inputModalities.includes('text'));
    const selected = visible.find(row => row.isDefault) ?? visible[0];
    assert.ok(selected, 'actual bounded native catalog contains a visible text model');
    chosen = selected.model; options.selectModel(chosen); catalog = { ...discovered, originalChildExited: true };
    const first = await make({ version: '0.169.0', phase: 'start', model: chosen,
      previousConfigSha256: metadata.configSha256, deadline: options.deadline });
    const c1 = await open(first);
    const oneDeadline = Math.min(options.deadline, performance.now() + 60_000);
    const one = originalInput('ONE'), oneTerminal = observe(c1, first, one, 'ONE', oneDeadline);
    const handedOne = await within(() => c1.submit(one), oneDeadline - performance.now());
    assert.deepEqual(handedOne, { ok: true, value: { inputId: one.inputId, operationRef: one.operationRef,
      delivery: 'client-consumed', providerAcceptance: 'unknown' } });
    await wait(() => oneTerminal() !== undefined, oneDeadline);
    assert.equal(oneTerminal()?.outcome, 'succeeded'); assert.equal(approvalCount, 1);
    assert.equal(await readFile(effect, 'utf8'), 'ONE\n'); assert.equal(model.observations.length, 8);
    assert.ok(first.events.some(event => event.kind === 'tool-result' && event.isError));
    const checkpoint = c1.checkpoint();
    if (!checkpoint.ok) throw new Error('TEST original native checkpoint unavailable');
    const payload = JSON.stringify(checkpoint.value); assert.ok(payload && Buffer.byteLength(payload) <= 1_000_000);
    const checkpointRef = 'TEST-original-codex-checkpoint-' + basename(root);
    const checkpointSha = createHash('sha256').update(payload).digest('hex');
    const checkpointPath = join(root, 'candidate-checkpoint.json');
    await writeFile(checkpointPath, payload, { mode: 0o600, flag: 'wx' });
    checkpointEvidence = { checkpointRef, sha256: checkpointSha, nativeThreadId: first.facts.threadId };
    assert.equal(record(checkpoint.value).nativeThreadId, first.facts.threadId);
    await close(c1, first);
    const second = await make({ version: '0.169.0', phase: 'resume', model: chosen,
      previousConfigSha256: first.configSha256, deadline: options.deadline,
      async readCheckpoint(reference, request) {
        assert.equal(reference, checkpointRef); assert.equal(checkpointReads, 0);
        assert.deepEqual(request, { ...first.config.binding, generation: 2,
          configRevision: first.config.configRevision,
          requiredCapabilities: ['text', 'tools', 'permission', 'interrupt', 'checkpoint'], checkpointRef });
        const original = await readFile(checkpointPath, 'utf8');
        assert.equal(createHash('sha256').update(original).digest('hex'), checkpointSha);
        checkpointReads += 1;
        return JSON.parse(original) as unknown;
      } });
    const c2 = await open(second, checkpointRef);
    assert.equal(checkpointReads, 1); assert.equal(second.config.binding.generation, 2);
    assert.equal(first.facts.sentMethods.filter(method => method === 'thread/start').length, 1);
    assert.equal(first.facts.sentMethods.includes('thread/resume'), false);
    assert.equal(second.facts.sentMethods.includes('thread/start'), false);
    assert.equal(second.facts.sentMethods.filter(method => method === 'thread/resume').length, 1);
    assert.equal(second.facts.threadId, first.facts.threadId);
    assert.equal(second.submitted.length, 0); assert.equal(model.observations.length, 8);
    assert.equal(await readFile(effect, 'utf8'), 'ONE\n'); assert.equal(bob.lookup('codex-reply-two'), undefined);
    const twoDeadline = Math.min(options.deadline, performance.now() + 60_000);
    const two = originalInput('TWO'), twoTerminal = observe(c2, second, two, 'TWO', twoDeadline);
    const handedTwo = await within(() => c2.submit(two), twoDeadline - performance.now());
    assert.deepEqual(handedTwo, { ok: true, value: { inputId: two.inputId, operationRef: two.operationRef,
      delivery: 'client-consumed', providerAcceptance: 'unknown' } });
    await wait(model.candidateFinalHeld, twoDeadline);
    assert.equal(await readFile(effect, 'utf8'), 'ONE\nTWO\n');
    assert.equal(bob.lookup('codex-reply-two')?.phase, 'completed');
    assert.equal(twoTerminal(), undefined, 'held actual response precedes explicit original interrupt');
    interruption = await within(() => c2.interrupt(two.operationRef), twoDeadline - performance.now());
    assert.deepEqual(interruption, { ok: true, value: { requested: true, terminal: 'unconfirmed' } });
    await wait(() => twoTerminal() !== undefined, twoDeadline);
    assert.equal(twoTerminal()?.outcome, 'cancelled');
    assert.equal(first.submitted.length, 1); assert.equal(second.submitted.length, 1);
    assert.equal(first.candidateWire.turns.length, 1); assert.equal(second.candidateWire.turns.length, 1);
    assert.equal(new Set([one.inputId, two.inputId]).size, 2);
    assert.equal(new Set([one.operationRef, two.operationRef]).size, 2);
    assert.equal(second.candidateWire.approvals.length, 0);
    for (const id of ['codex-task-create', 'codex-task-assign', 'codex-task-start', 'codex-task-comment',
      'codex-task-complete', 'codex-reply-one', 'codex-reply-two']) {
      const receipt = bob.lookup(id); assert.ok(receipt);
      assert.equal(receipt.phase, 'completed'); assert.equal(receipt.principalId, 'bob-session');
      assert.deepEqual(receipt.binding, { backendId: options.delivery.backendId,
        teamId: options.delivery.teamId, teamName: options.delivery.teamName });
    }
    const tasks = human.listTasks(); assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, 'completed'); assert.equal(tasks[0]?.owner, 'bob');
    const inbox = JSON.parse(await readFile(join(root, 'store/teams/test-codex-team/inboxes/user.json'), 'utf8')) as unknown[];
    assert.deepEqual(inbox.map(item => [record(item).from, record(item).text]),
      [['bob', 'REPLY_CODEX_ONE'], ['bob', 'REPLY_CODEX_TWO']]);
    assert.equal(new Set(inbox.map(item => record(item).messageId)).size, 2);
    assert.equal(model.observations.length, 11); assert.deepEqual(model.failures, []);
    assert.equal(model.probes.length, 0);
    assert.ok(model.observations.every(row => row.contextEffective && row.requestedModel === chosen));
    assert.ok(model.observations.filter(row => row.turn === 'CODEX_TEAM_TWO')
      .every(row => row.priorTurn && row.priorNativeToolIds?.length === 7));
    assert.equal([...first.events, ...second.events].filter(event => event.kind === 'tool' && event.name === 'Bash').length, 2);
    await close(c2, second);
    await Promise.all(consumers);
    if (observationFailure !== undefined) throw observationFailure;
    assert.equal(children.length, 3);
    assert.equal(await hash(checkpointPath), checkpointSha);
    passed = true;
  } catch (error) { firstFailure = error; }
  const cleanupFailures: unknown[] = [];
  for (const session of sessions) {
    try { await session.close(); } catch (error) { cleanupFailures.push(error); }
  }
  for (const cleanup of options.cleanup.toReversed()) {
    try { await cleanup(); } catch (error) { cleanupFailures.push(error); }
  }
  options.onDisposed();
  try { if (pins) await pins.verify(); } catch (error) { cleanupFailures.push(error); }
  passed = passed && cleanupFailures.length === 0;
  const metadataObservation = projectCodexMetadataObservation(drivers[0]?.metadataObservation());
  const receiptPath = join(root, 'receipt.json');
  await writeFile(receiptPath, JSON.stringify({
    status: passed ? 'PASS' : 'INCOMPLETE', scope: 'public-D Codex 0.169.0 candidate Darwin ARM64',
    artifacts: { inputs: pins?.evidence, node: { version: process.version, sha256: await hash(options.selectedNode) },
      provider: { sha256: await hash(options.providerArtifact), entry: import.meta.resolve('@agent-teams/provider-implementations/codex') } },
    nativeVersion, originalShell, selectedModel: chosen, catalog, metadataObservation,
    permission, checkpoint: checkpointEvidence, checkpointReads,
    businessReceipts: business, interruption, closes, native: drivers.map((driver, index) => ({
      role: ['metadata', 'C1', 'C2'][index], facts: { ...driver.facts, errors: driver.facts.errors.map(row =>
        ({ method: row.method, code: typeof row.code === 'number' && Number.isFinite(row.code) ? row.code : 'unknown' })) }, wire: driver.candidateWire,
      inputs: driver.submitted, children: driver.childFacts(), configSha256: driver.configSha256,
      terminals: driver.events.filter(event => event.kind === 'result'),
    })), modelObservations: model.observations, modelFailures: model.failures,
    cleanup: cleanupFailures.length === 0 && children.every(child => child.exitCode !== null || child.signalCode !== null),
    firstFailure: firstFailure === undefined ? null : { kind: firstFailure instanceof Error && firstFailure.name === 'AssertionError' ? 'assertion' : 'error' },
    cleanupFailures: cleanupFailures.length,
    excluded: ['Host/source eligibility', 'Desktop/installer', 'cross-version restore', 'descendant custody', 'durable Runtime dispatch'],
  }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: passed ? 'PASS' : 'INCOMPLETE', scope: 'codex-0.169.0-candidate', receipt: receiptPath }));
  if (!passed) {
    try {
      const observation = projectCodexMetadataObservation(metadataObservation);
      if (observation) {
        const line = JSON.stringify({ kind: 'TEST_CODEX_METADATA_CALLBACKS', observation });
        if (Buffer.byteLength(line + '\n', 'utf8') <= 2048) console.log(line);
      }
    } catch { /* Passive diagnostics cannot replace the original failure or cleanup evidence. */ }
  }
  if (!passed)
    throw new AggregateError([...(firstFailure === undefined ? [] : [firstFailure]), ...cleanupFailures], 'TEST candidate original failure/cleanup');
}
