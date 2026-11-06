import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';

import { createFilesystemTeamOwner } from '../dist/adapters/team/createFilesystemTeamOwner.js';
import { acquireProfileWriterLease } from '../dist/adapters/profile/ProfileWriterLease.js';
import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { RuntimeOwner } from '../dist/runtime/RuntimeOwner.js';
import { deliveryFingerprint } from '../dist/runtime/identity.js';
import { startTeamMcpEndpoint } from '../dist/mcp/index.js';
import { cleanupCapturedCodexChild, nativeCodexDriver } from './fixtures/native-codex-team/driver.ts';
import { record, startCodexModel } from './fixtures/native-codex-team/model.ts';
import type { CommandReceipt, DeliveryBinding, TeamCommand } from '../dist/team/contracts.js';
import type { RuntimeBinding, RuntimeSessionRecord } from '../dist/runtime/contracts.js';

const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const tick = () => new Promise<void>((done) => setTimeout(done, 20));

test(
  'native Codex + authoritative Team MCP + durable Runtime dispatch: two business messages',
  { timeout: 180_000 },
  async (t) => {
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
    const model = await startCodexModel();
    setupCleanup.push(() => model.close());
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
