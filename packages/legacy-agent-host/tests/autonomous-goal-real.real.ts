// Real-model qualification, deliberately outside the regular *.test.ts glob.
// Invoke the existing credential-cleanup runner with --scenario autonomous-goal.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { FileRuntimeStore } from '../dist/adapters/runtime/FileRuntimeStore.js';
import { TeamOwnerStore } from '../dist/adapters/team/TeamOwnerStore.js';
import { readEvidenceFileImage } from '../dist/evidence/WorkspaceSnapshot.js';
import { runtimeProfileSchema } from '../dist/composition/runtimeProfile.js';
import { sanitizeRuntimeDiagnosticText } from '../dist/diagnostics/runtimeDiagnosticText.js';
import { fileHash, startHost, tick, treeHash } from './fixtures/native-host.ts';
import { Inconclusive, assertFreeDisk, classifyVendorFailure, discoverTarget } from './fixtures/real-vendor/discovery.ts';
import { buildRealHostProfile, digest } from './fixtures/real-vendor/host-profile.ts';
import type { RealVendor } from './fixtures/real-vendor/discovery.ts';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import type { CommandReceipt } from '../dist/team/contracts.js';
import type { GoalRecord, GoalStatus } from '../dist/team/goalContracts.js';

const run = promisify(execFile);
const members = [{ name: 'lead', memberId: 'lead-id', role: 'lead' as const },
  { name: 'worker', memberId: 'worker-id', role: 'member' as const }];
const squares = Array.from({ length: 20 }, (_, index) => (index + 1) ** 2);
const expectedResult = { squares, sum: squares.reduce((a, b) => a + b, 0) };
// This reviewed follow-up keeps the combined new run within twelve automatic
// attempts; the earlier failed run conservatively retains its original twelve.
const automaticAttemptLimits = { success: 8, stop: 4 } as const;
type RuntimeView = { nativeReady?: boolean; phase?: string; custody?: string; diagnostic?: unknown;
  inputs: { inputId: string; phase: string; terminal?: string }[] };
const value = <T>(response: Record<string, unknown>, method: string): T => {
  assert.equal(response.ok, true, method + ' refused: ' + String(response.code ?? 'unknown'));
  return response.value as T;
};

const objective = (prefix: 'success' | 'stop') => [
  'TEST bounded autonomous goal in this disposable workspace only.',
  'Delegate exactly one task to worker. Include every instruction below in that task, then yield your current turn.',
  'Worker must use two separate native inputs: in the FIRST task input, task_start, create ' + prefix + '-draft.json',
  'with the squares of integers 1 through 20, leave the task in_progress, add a brief factual task comment,',
  'and finish that native turn. Do not finish both stages in one input and do not send a message to yourself.',
  'In the NEXT authorized input, reread the draft, independently verify the arithmetic, write ' + prefix + '-result.json',
  'as exactly ' + JSON.stringify(expectedResult) + ', post the result and task_complete, then finish your turn.',
  'The lead must wait for the worker, verify the exact final file and the original criteria, then call goal_propose',
  'with the final answer. Never claim completion from task status alone. Use the supplied Team MCP tools.',
  'For Codex, file reads may use exec_command with only cat success-draft.json, cat success-result.json,',
  'cat stop-draft.json or cat stop-result.json, with this workspace as workdir. Use apply_patch for every file change.',
  'For Claude, use Read/Write/Edit. Do not create extra tasks, run other shell commands, use the network,',
  'change account/config files, ask the user for a continue message, or perform review-policy changes.',
  'Use only these prescribed file operations inside this workspace.',
  'If a required capability or permission is absent, report that exact blocker and yield. This is a small real',
  'productive result; do not replace file changes with prose or simulated tool output.',
].join('\n');

test('REAL autonomous goal: productive lead/member completion and a separate original Stop boundary',
  { timeout: 960_000 }, async t => {
  assert.equal(process.env.REAL_GOAL_GO, '1', 'use the explicit autonomous-goal scenario in the existing real runner');
  const vendor = process.env.REAL_VENDOR as RealVendor | undefined;
  assert.ok(vendor === 'claude' || vendor === 'codex');
  const receiptPath = process.env.REAL_RECEIPT;
  assert.ok(receiptPath);
  const startedAt = Date.now();
  const receipt: Record<string, unknown> = { scenario: 'autonomous-goal', vendor, status: 'fail',
    startedAt: new Date(startedAt).toISOString(), scriptedInference: false, overnightQualification: false,
    roles: ['lead', 'member'], actionMode: 'do', automaticAttemptLimits,
    maxAutomaticAttempts: automaticAttemptLimits.success + automaticAttemptLimits.stop };
  let root: string | undefined;
  let host: ReturnType<typeof startHost> | undefined;
  let authSource: string | undefined;
  let authBefore: string | undefined;
  let capturedProfile: TeamHostProfile | undefined;
  let closing: Promise<void> | undefined;
  let shutdownSignal: string | undefined;
  const closeHost = () => {
    if (!host) return Promise.resolve();
    return closing ??= host.close();
  };
  const assertRunning = () => {
    assert.equal(shutdownSignal, undefined, 'Canary interrupted: ' + shutdownSignal);
  };
  const requestShutdown = (signal: string) => {
    shutdownSignal ??= signal;
    receipt.interruptedBy = shutdownSignal;
    // The runner signals this original test leader. No new Host is allocated,
    // and the same original close promise is awaited by finally below.
    void closeHost().catch(() => {});
  };
  const onTerm = () => requestShutdown('SIGTERM');
  const onInt = () => requestShutdown('SIGINT');
  const onAbort = () => requestShutdown('test-aborted');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  t.signal.addEventListener('abort', onAbort, { once: true });
  let phase = 'source-capture';
  const diagnostic: string[] = [];
  let diagnosticBytes = 0;
  const safeError = (error: unknown) => sanitizeRuntimeDiagnosticText(
    error instanceof Error ? error.message : String(error), 2048) ?? 'No safe error detail';
  const hostFacts = () => {
    const facts = host?.facts();
    if (!facts) return undefined;
    return { pid: facts.pid, exitCode: facts.exitCode, signalCode: facts.signalCode,
      stdoutValid: facts.stdoutValid, diagnosticBytes: facts.diagnosticBytes,
      frameCount: facts.frames.length, frames: facts.frames.slice(-32).map(frame => ({
        id: frame.id, method: sanitizeRuntimeDiagnosticText(frame.method, 128), ok: frame.ok })) };
  };
  try {
    assert.equal(process.version, 'v24.21.0', 'qualify with the pinned standalone Host Node');
    const repo = resolve(import.meta.dirname, '../../..');
    receipt.source = { head: (await run('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim(),
      sourceSha256: await treeHash(join(repo, 'packages/legacy-agent-host/src'), '.ts'),
      distSha256: await treeHash(join(repo, 'packages/legacy-agent-host/dist'), '.js'),
      testSha256: await fileHash(import.meta.filename), nodeSha256: await fileHash(process.execPath),
      dependencyLockSha256: await fileHash(join(repo, 'pnpm-lock.yaml')),
      nodeVersion: process.version, platform: process.platform + '-' + process.arch };
    await assertFreeDisk();
    assertRunning();
    phase = 'provider-discovery';
    const target = await discoverTarget(vendor, 'autonomous-goal');
    Object.assign(receipt, { binary: target.binary, binarySha256: target.sha256,
      version: target.version, model: target.model });
    if (process.env.REAL_GOAL_PREFLIGHT_ONLY === '1') {
      Object.assign(receipt, { status: 'inconclusive', reasonCode: 'preflight-only',
        reason: 'Binary, account and disk preflight only; no model inference or goal qualification ran.' });
      t.skip(String(receipt.reason));
      return;
    }
    authSource = target.authSource;
    if (authSource) authBefore = digest(await readFile(authSource, 'utf8'));
    root = await realpath(await mkdtemp(join(process.env.REAL_WORK_DIR ?? tmpdir(), 'TEST-real-autonomous-goal-')));
    for (const directory of ['store', 'tmp', 'home', 'workspace']) await mkdir(join(root, directory), { mode: 0o700 });
    const workspace = join(root, 'workspace');
    await run('git', ['-c', 'core.fsmonitor=false', '-c', 'init.templateDir=', 'init', '-q', workspace], {
      env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    assertRunning();
    phase = 'profile-build';
    const built = await buildRealHostProfile(target, root, members);
    const profile = JSON.parse(await readFile(built.profilePath, 'utf8')) as TeamHostProfile;
    profile.promptSuggestions = { enabled: false };
    for (const member of profile.runtime!.members) {
      member.cwd = workspace;
      member.limits = { ...member.limits, queuedInputs: 8, inputBytes: 65536, timeoutMs: 120_000 };
      const instructions = [
        'You are the ' + (member.memberId === 'lead-id' ? 'lead' : 'worker') + ' in a bounded real TEST team.',
        'Follow the exact accepted objective and your configured Team MCP role. Work only in ' + workspace + '.',
        'Use Read/Write/Edit for Claude and apply_patch for every Codex file change. Codex file reads may use',
        'exec_command only for cat success-draft.json, cat success-result.json, cat stop-draft.json or cat stop-result.json',
        'with this workspace as workdir. No other shell commands, network or account/config operations are allowed.',
        'Finish the current turn when instructed; the Host owns any next authorized continuation.',
      ].join('\n');
      if (member.provider === 'claude') {
        member.nativeTools = ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
        member.autoAllowedTools = [...member.nativeTools];
        member.nativeOptions = { ...member.nativeOptions, projectInstructions: { append: instructions } };
      } else if (member.provider === 'codex') {
        member.nativeOptions = { ...member.nativeOptions, developerInstructions: instructions };
      } else assert.fail('this canary qualifies only its selected real Claude/Codex provider');
    }
    runtimeProfileSchema.parse(profile.runtime);
    capturedProfile = profile;
    const serialized = JSON.stringify(profile);
    await writeFile(built.profilePath, serialized, { mode: 0o600 });
    receipt.profileSha256 = digest(serialized);
    assertRunning();
    host = startHost({ node: built.node, entry: built.entry, root, profile: built.profilePath,
      profileHash: digest(serialized), onDiagnostic: chunk => {
        const remaining = 65536 - diagnosticBytes;
        if (remaining > 0) diagnostic.push(chunk.subarray(0, remaining).toString('utf8'));
        diagnosticBytes += chunk.length;
      } });
    const { envelope } = built;
    const rpc = async <T>(method: string, payload: unknown, commandId?: string): Promise<T> => {
      assertRunning();
      receipt.lastRequest = { method, commandId };
      return value<T>(await host!.rpc(method, envelope(payload, commandId)), method);
    };
    phase = 'host-handshake';
    await host.rpc('host.handshake', { protocolVersion: 1 });
    const observations: { member: string; inputId: string; phase: string; terminal?: string; observedAt: string }[] = [];
    receipt.observations = observations;
    const seen = new Map<string, string>();
    const readRuntime = async () => {
      const views = new Map<string, RuntimeView>();
      for (const member of members) {
        const view = await rpc<RuntimeView>('runtime.read', { memberId: member.memberId });
        views.set(member.name, view);
        for (const input of view.inputs) {
          const key = member.name + ':' + input.inputId, state = input.phase + ':' + (input.terminal ?? '');
          if (seen.get(key) !== state) {
            seen.set(key, state);
            assert.ok(observations.length < 256, 'native observation receipt stays bounded');
            observations.push({ member: member.name, ...input, observedAt: new Date().toISOString() });
          }
          assert.notEqual(input.phase, 'unknown', 'unknown native effects are not a successful canary');
        }
      }
      return views;
    };
    const goal = async () => (await rpc<{ autonomousGoal?: GoalStatus }>('team.snapshot', {})).autonomousGoal;
    const waitFor = async (check: () => Promise<boolean>, timeoutMs: number, reason: string) => {
      const until = performance.now() + timeoutMs;
      while (performance.now() < until) { if (await check()) return; await tick(); }
      throw classifyVendorFailure(diagnostic.join('\n')) ?? new Error(reason);
    };
    const nativeOpens: Record<string, unknown>[] = [];
    receipt.nativeOpens = nativeOpens;
    for (const member of members) {
      phase = 'runtime.open:' + member.name;
      const opened = await rpc<RuntimeView>('runtime.open', { memberId: member.memberId });
      nativeOpens.push({ member: member.name, nativeReady: opened.nativeReady,
        phase: opened.phase, custody: opened.custody,
        diagnostic: sanitizeRuntimeDiagnosticText(JSON.stringify(opened.diagnostic), 2048) });
      assert.equal(opened.nativeReady, true, 'original native allocation must be ready; unknown open is never retried blindly');
    }
    phase = 'review-policy';
    await rpc('team.execute', { operation: 'task.board.review-flow', payload: {
      settings: { reviewFlow: 'agent_approval', reviewFlowPrompt: '' },
    } }, 'TEST-real-goal-review-policy');
    phase = 'goal-intake';
    const intake = await rpc<CommandReceipt>('team.execute', { operation: 'message.send', payload: {
      to: 'lead', text: objective('success'), actionMode: 'do',
      autonomousGoal: { durationHours: 1, maxAttempts: automaticAttemptLimits.success },
    } }, 'TEST-real-goal-success');
    assert.equal(intake.phase, 'completed');
    phase = 'productive-completion';
    await waitFor(async () => {
      await readRuntime();
      const current = await goal();
      receipt.latestGoal = current;
      assert.ok(current && current.attemptsUsed <= automaticAttemptLimits.success);
      return current.disposition === 'accepted' && current.published === true;
    }, 420_000, 'Real agents did not productively complete and publish the bounded goal within seven minutes.');
    phase = 'productive-oracle';
    const completed = await goal();
    assert.ok(completed?.resultMessageId && completed.disposition === 'accepted' && completed.published === true);
    const finalRuntime = await readRuntime();
    for (const member of members) {
      const inputs = finalRuntime.get(member.name)!.inputs;
      assert.ok(inputs.filter(input => input.phase === 'terminal' && input.terminal === 'succeeded').length >= 2,
        member.name + ' actually executes both its initial work and a later automatic input');
      assert.ok(inputs.every(input => input.phase === 'terminal' ? input.terminal === 'succeeded'
        : ['cancelled', 'not-sent', 'rejected'].includes(input.phase)),
      'all actual native turns settle successfully; never-claimed retired inputs cannot count as productive work');
    }
    const tasks = await rpc<{ id: string; owner: string; status: string }[]>('team.tasks.list', null);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.owner, 'worker');
    assert.equal(tasks[0]!.status, 'completed');
    const artifact = await readEvidenceFileImage(workspace, join(workspace, 'success-result.json'));
    assert.ok(artifact.exists && artifact.content && !artifact.reason && artifact.content.length < 16384);
    assert.deepEqual(JSON.parse(artifact.content.toString('utf8')), expectedResult);
    const page = await rpc<{ messages: { messageId?: string; text: string }[] }>('team.messages.page', {});
    assert.equal(page.messages.filter(message => message.messageId === completed.resultMessageId).length, 1);
    for (let index = 0; index < 3; index++) assert.equal((await goal())!.attemptsUsed, completed.attemptsUsed);
    receipt.success = { status: 'pass', goal: completed, taskId: tasks[0]!.id,
      artifactSha256: artifact.sha256, finalPublicationCount: 1, noHumanContinue: true };

    const previousWorkerIds = new Set(finalRuntime.get('worker')!.inputs.map(input => input.inputId));
    phase = 'stop-goal-intake';
    await rpc('team.execute', { operation: 'message.send', payload: { to: 'lead', text: objective('stop'),
      actionMode: 'do', autonomousGoal: { durationHours: 1, maxAttempts: automaticAttemptLimits.stop },
    } }, 'TEST-real-goal-stop');
    phase = 'stop-active-observation';
    let stopViews = finalRuntime;
    await waitFor(async () => {
      stopViews = await readRuntime();
      return stopViews.get('worker')!.inputs.some(input => !previousWorkerIds.has(input.inputId) &&
        ['claimed', 'consumed'].includes(input.phase));
    }, 120_000, 'No actual active worker input was observed for the separate Stop case.');
    const atStop = await goal();
    assert.ok(atStop && atStop.goalId !== completed.goalId);
    phase = 'stop-control';
    const stopped = await rpc<GoalStatus>('team.goal.control', { goalId: atStop.goalId,
      expectedRevision: atStop.revision, action: 'stop' }, 'TEST-real-goal-stop-control');
    assert.equal(stopped.disposition, 'stopped');
    const startedIds = new Map([...stopViews].map(([name, view]) => [name, new Set(view.inputs
      .filter(input => ['claimed', 'consumed', 'terminal'].includes(input.phase)).map(input => input.inputId))]));
    phase = 'stop-settlement';
    await waitFor(async () => {
      const views = await readRuntime(), current = await goal();
      assert.ok(current);
      assert.equal(current.disposition, 'stopped');
      assert.equal(current.attemptsUsed, stopped.attemptsUsed);
      assert.notEqual(current.published, true);
      for (const [name, view] of views) for (const input of view.inputs)
        assert.ok(startedIds.get(name)!.has(input.inputId) || ['admitted', 'cancelled', 'rejected', 'not-sent'].includes(input.phase),
          'Stop cannot claim either a new input or an originally admitted but unclaimed input');
      return [...views.values()].every(view => view.inputs.every(input => !['claimed', 'consumed'].includes(input.phase)));
    }, 120_000, 'Original native input did not settle after Stop; this is not a success receipt.');
    receipt.stop = { status: 'pass', goal: await goal(), automaticAttemptsUnchanged: true, noFinalPublication: true };
    for (const member of members) {
      phase = 'runtime.stop:' + member.name;
      await rpc('runtime.stop', { memberId: member.memberId, expectedGeneration: '1' });
    }
    phase = 'host-close';
    await closeHost(); host = undefined;
    phase = 'retained-receipt-check';
    const store = new FileRuntimeStore(built.owner.storageRoot);
    receipt.runtimeInputs = members.map(member => {
      const binding = { backendId: built.owner.ownerId, teamId: built.scope.teamId,
        runId: built.scope.runId, memberId: member.memberId, generation: '1' };
      const original = store.fenced(binding, tx => tx.get());
      assert.ok(original && original.custody === 'released');
      return { binding, inputs: original.inputs.map(input => ({ inputId: input.intent.inputId,
        operationRef: input.operationRef, fingerprint: input.fingerprint, phase: input.phase, terminal: input.terminal })) };
    });
    const teamStore = new TeamOwnerStore(built.owner.storageRoot, profile.teams[0]!.binding.teamName);
    const commands = teamStore.fenced(() => teamStore.list<CommandReceipt>('commands'));
    const continuation = commands.filter(command => command.goal?.goalId === completed.goalId && command.goal.continuation);
    assert.ok(continuation.some(command => command.deliveryBinding?.memberId === 'worker-id'));
    assert.ok(continuation.every(command => command.phase === 'completed'));
    receipt.continuations = continuation.map(command => ({ commandId: command.commandId,
      inputId: command.effects.deliveryId, source: command.goal!.source, target: command.deliveryBinding?.memberId }));
    receipt.observations = observations;
    assertRunning();
    receipt.status = 'pass';
  } catch (error) {
    receipt.failurePhase = phase;
    receipt.primaryReason = safeError(error);
    const unavailable = error instanceof Inconclusive ? error : classifyVendorFailure(diagnostic.join('\n'));
    Object.assign(receipt, unavailable ? { status: 'inconclusive', reasonCode: unavailable.code, reason: unavailable.message } :
      { status: 'fail', reason: receipt.primaryReason });
  } finally {
    receipt.hostBeforeCleanup = hostFacts();
    const cleanupErrors: { phase: string; message: string }[] = [];
    let cleanupConfirmed = !host;
    try { await closeHost(); cleanupConfirmed = true; }
    catch (error) {
      cleanupErrors.push({ phase: 'host-close', message: safeError(error) });
      receipt.status = 'fail';
      receipt.reason ??= 'Original Host did not confirm provider cleanup.';
    }
    if (shutdownSignal) {
      receipt.status = 'fail';
      receipt.reason ??= 'Canary interrupted: ' + shutdownSignal;
    }
    receipt.hostAfterCleanup = hostFacts();
    receipt.hostCleanupConfirmed = cleanupConfirmed;
    receipt.hostDiagnostic = sanitizeRuntimeDiagnosticText(diagnostic.join(''), 8192);
    receipt.hostDiagnosticTruncated = diagnosticBytes > 65536;
    // Observe only the original TEST stores. Missing/failed reads are explicit,
    // never proof of zero effects, released custody, or a passing model run.
    if (receipt.status !== 'pass' && capturedProfile) {
      try {
        const selected = capturedProfile;
        const present = await lstat(join(selected.owner.storageRoot, 'runtime-sessions'))
          .then(info => info.isDirectory() && !info.isSymbolicLink(), error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
            throw error;
          });
        if (!present) receipt.originalRuntimeRecords = { status: 'directory-absent' };
        else {
          const store = new FileRuntimeStore(selected.owner.storageRoot);
          receipt.originalRuntimeRecords = members.map(member => {
            const binding = { backendId: selected.owner.ownerId, teamId: selected.teams[0]!.scope.teamId,
              runId: selected.teams[0]!.scope.runId, memberId: member.memberId, generation: '1' };
            const original = store.fenced(binding, tx => tx.get());
            return { binding, present: !!original, ...(original ? { phase: original.phase,
              custody: original.custody, nativeReady: original.nativeReady, sealed: original.sealed,
              inputCount: original.inputs.length, inputsTruncated: original.inputs.length > 128,
              inputs: original.inputs.slice(0, 128).map(input => ({ inputId: input.intent.inputId,
                operationRef: input.operationRef, phase: input.phase, terminal: input.terminal })) } : {}) };
          });
        }
      } catch (error) { receipt.originalRuntimeRecords = { status: 'unavailable', reason: safeError(error) }; }
      try {
        const selected = capturedProfile;
        const directory = join(selected.owner.storageRoot, 'teams', selected.teams[0]!.binding.teamName, '.host-owner');
        const present = await lstat(directory).then(info => info.isDirectory() && !info.isSymbolicLink(), error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        });
        if (!present) receipt.originalGoalRecords = { status: 'directory-absent' };
        else {
          const store = new TeamOwnerStore(selected.owner.storageRoot, selected.teams[0]!.binding.teamName);
          receipt.originalGoalRecords = store.fenced(() => {
            const goal = store.read<{ autonomousGoal?: GoalRecord }>('state.json')?.autonomousGoal;
            const commands = store.list<CommandReceipt>('commands');
            return { goal: goal ? { goalId: goal.goalId, disposition: goal.disposition,
              rootCommandId: goal.rootCommandId, attemptsUsed: Object.keys(goal.debits).length,
              debits: Object.entries(goal.debits).map(([inputId, debit]) => ({ commandId: debit.commandId,
                binding: debit.binding, inputId })) } : null,
              commandCount: commands.length, commands: commands.slice(0, 128).map(command => ({
                commandId: command.commandId, operation: command.command.operation, phase: command.phase,
                inputId: command.effects.deliveryId, memberId: command.deliveryBinding?.memberId })),
              truncated: commands.length > 128 };
          });
        }
      } catch (error) { receipt.originalGoalRecords = { status: 'unavailable', reason: safeError(error) }; }
    }
    if (authSource && authBefore) {
      try {
        receipt.originalAuthUnchanged = digest(await readFile(authSource, 'utf8')) === authBefore;
        if (!receipt.originalAuthUnchanged) Object.assign(receipt, { status: 'fail', reason: 'Original account credential changed during the canary.' });
      } catch {
        cleanupErrors.push({ phase: 'original-auth-read', message: 'Original account credential could not be revalidated.' });
        receipt.status = 'fail'; receipt.reason ??= 'Original account credential could not be revalidated.';
      }
    }
    // The runner retains the original test process group for teardown. Detached
    // native scopes still require the Host's custody proof; a group exit alone
    // cannot turn unconfirmed native cleanup into success.
    if (root && cleanupConfirmed) {
      try { await rm(root, { recursive: true, force: true }); }
      catch (error) {
        cleanupErrors.push({ phase: 'owned-workspace-remove', message: safeError(error) });
        receipt.status = 'fail'; receipt.reason ??= 'Original canary workspace cleanup did not complete.';
      }
    }
    if (cleanupErrors.length) receipt.cleanupErrors = cleanupErrors;
    receipt.durationMs = Date.now() - startedAt;
    try {
      await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 });
      await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    } finally {
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
      t.signal.removeEventListener('abort', onAbort);
    }
  }
  t.diagnostic(JSON.stringify(receipt));
  if (receipt.status === 'inconclusive') t.skip(String(receipt.reason));
  else assert.equal(receipt.status, 'pass', String(receipt.reason ?? 'Real goal qualification failed'));
});
