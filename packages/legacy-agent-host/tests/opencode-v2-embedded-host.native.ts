/** TEST-only complete native V2 turn through the original Host/Runtime/MCP composition. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';
import { record } from './fixtures/native-claude-team/model.ts';
import { fileHash, nativeHostEnvironment, startHost, tick, treeHash, writeNativeFailureReceipt } from './fixtures/native-host.ts';
import { CONTEXT_MARKER, startOpenCodeModel } from './fixtures/native-opencode-team/model.ts';
import { captureOpenCodeConfigurationSource } from '../dist/adapters/providers/OpenCodeConfigurationSource.js';
import { assertNativeV1Build, buildNativeV1Host } from './opencode-v1-version-source.ts';
import { readNativeMessageImage, uploadNativeMessageImage } from './fixtures/native-message-image.ts';

async function endpoint(): Promise<string> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  return `http://127.0.0.1:${address.port}`;
}

/** Failure evidence is finite public state only: no inputs, IDs, paths or native error text. */
function nativeInputProgress(value: Record<string, unknown>) {
  const choice = (entry: unknown, values: readonly string[]) =>
    typeof entry === 'string' && values.includes(entry) ? entry : null;
  const rows = (entries: unknown) => Array.isArray(entries) ? entries.slice(0, 8).map(entry =>
    entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : {}) : [];
  return {
    phase: choice(value.phase, ['unopened', 'opening', 'allocated', 'closing', 'closed', 'held']),
    custody: choice(value.custody, ['owned', 'released', 'unknown']),
    nativeReady: typeof value.nativeReady === 'boolean' ? value.nativeReady : null,
    attached: typeof value.attached === 'boolean' ? value.attached : null,
    sealed: typeof value.sealed === 'boolean' ? value.sealed : null,
    diagnostic: choice(value.diagnostic, ['open-unknown', 'observe-ended', 'observe-failed', 'readiness-unavailable', 'close-unknown']),
    inputs: rows(value.inputs).map(input => ({
      phase: choice(input.phase, ['admitted', 'claimed', 'consumed', 'terminal', 'cancelled', 'rejected', 'not-sent', 'unknown']),
      terminal: choice(input.terminal, ['succeeded', 'failed', 'cancelled']),
    })),
    interactions: rows(value.interactions).map(interaction => ({
      kind: choice(interaction.kind, ['permission', 'question']),
      phase: choice(interaction.phase, ['pending', 'responding', 'resolved', 'unknown']),
    })),
  };
}


/** Public launch projection only; absolute times, bindings and native identities stay private. */
function nativeLaunchProgress(reply: Record<string, unknown>) {
  const value = record(reply.value);
  const members = Array.isArray(value.members) ? value.members.slice(0, 8).map(record) : [];
  const attempt = record(members.find(member => member.memberId === 'carol-id')?.attempt);
  const choice = (entry: unknown, values: readonly string[]) =>
    typeof entry === 'string' && values.includes(entry) ? entry : null;
  const difference = (end: unknown, start: unknown) =>
    typeof end === 'number' && typeof start === 'number' && Number.isSafeInteger(end) &&
    Number.isSafeInteger(start) && start > 0 && end >= start && end - start <= 3_600_000 ? end - start : null;
  const flag = (entry: unknown) => typeof entry === 'boolean' ? entry : null;
  return {
    available: reply.ok === true && typeof attempt.status === 'string',
    status: choice(attempt.status, ['not-started', 'pending-bootstrap', 'pending-human', 'ready', 'failed', 'unknown', 'skipped']),
    reason: choice(attempt.reason, ['not-started', 'opening', 'runtime-unconfigured', 'observation-unavailable',
      'stopped', 'binding-mismatch', 'context-applied', 'bootstrap-timeout', 'dependency-unavailable',
      'context-unconfirmed', 'custody-unresolved', 'retained-interaction-unavailable', 'human-decision',
      'interaction-expired', 'launch-policy']),
    elapsedSinceAttemptMs: difference(value.observedAtMs, attempt.startedAtMs),
    capturedTimeoutMs: difference(attempt.deadlineMs, attempt.startedAtMs),
    claimed: flag(attempt.claimed), nativeReady: flag(attempt.nativeReady),
    contextApplied: flag(attempt.contextApplied), everReady: flag(attempt.everReady),
    usable: flag(attempt.usable), controlAvailable: flag(attempt.controlAvailable),
    noAllocation: flag(attempt.noAllocation),
  };
}

export interface PackagedNativeHostInputs {
  sourceHead: string;
  node: string;
  entry: string;
  hostPackage: string;
  bun: string;
  engine: string;
  manifestSha256: string;
  hostSourceDigest: string;
  providerDigest: string;
  processCustody?: { directory: string; manifestSha256: string };
  evidence: Readonly<Record<string, unknown>>;
  /** Original packaged reader rechecks every selected file, source absence and actual Node. */
  verify(): Promise<void>;
}

/** Same native scenario for source qualification and the separately captured packaged candidate. */
export async function runOpenCodeV2EmbeddedHostNative(packaged?: PackagedNativeHostInputs, signal?: AbortSignal) {
  const startedAt = performance.now();
  const elapsedMs = () => Math.round(performance.now() - startedAt);
  signal?.throwIfAborted();
  assert.ok(process.platform === 'linux' && process.arch === 'x64' ||
    (process.platform === 'darwin' || process.platform === 'win32') &&
      (process.arch === 'arm64' || process.arch === 'x64'));
  assert.equal(process.version, 'v24.21.0');
  await packaged?.verify();
  const bun = packaged ? packaged.bun : await realpath(process.env.OPENCODE_V2_EMBEDDED_BUN!);
  const engine = packaged ? packaged.engine : await realpath(process.env.OPENCODE_V2_EMBEDDED_GRAPH!);
  const manifestSha256 = packaged ? packaged.manifestSha256 : process.env.OPENCODE_V2_EMBEDDED_MANIFEST_SHA256!;
  const receiptPath = process.env.OPENCODE_V2_EMBEDDED_HOST_RECEIPT!;
  const approvalMode = process.env.OPENCODE_V2_EMBEDDED_APPROVAL_MODE ?? 'manual';
  assert.ok(approvalMode === 'manual' || approvalMode === 'auto');
  assert.match(manifestSha256, /^[a-f0-9]{64}$/);
  assert.ok(receiptPath && isAbsolute(receiptPath));
  const repo = resolve(import.meta.dirname, '../../..');
  const pkg = packaged ? packaged.hostPackage : join(repo, 'packages/legacy-agent-host');
  const sourceHead = process.env.OPENCODE_V2_TEST_SOURCE_HEAD!;
  if (packaged) assert.equal(packaged.sourceHead, sourceHead);
  const sourceBuild = packaged ? undefined : await buildNativeV1Host(repo, sourceHead);
  if (packaged && process.platform === 'darwin') assert.ok(packaged.processCustody);
  const { applyLaunchConfiguration } = await import(pathToFileURL(join(pkg, 'dist/composition/launchConfiguration.js')).href) as
    typeof import('../dist/composition/launchConfiguration.js');
  const { applyOpenCodeRuntimeSource } = await import(pathToFileURL(join(pkg, 'dist/composition/applyOpenCodeRuntimeSource.js')).href) as
    typeof import('../dist/composition/applyOpenCodeRuntimeSource.js');
  const node = packaged ? packaged.node : await realpath(process.execPath);
  const entry = packaged ? packaged.entry : join(pkg, 'dist/cli.js');
  assert.equal(await realpath(process.execPath), node, 'scenario and Host must use the selected original Node');
  const steps: string[] = [], hosts: ReturnType<ReturnType<typeof startHost>['facts']>[] = [];
  const phaseElapsedMs: Record<string, number> = {};
  const completeStep = (step: string) => { steps.push(step); phaseElapsedMs[step] = elapsedMs(); };
  let host: ReturnType<typeof startHost> | undefined;
  // TEST cancellation retains the original Host's existing cleanup owner.
  const cancelOriginalHost = () => { host?.child.stdin.end(); };
  signal?.addEventListener('abort', cancelOriginalHost, { once: true });
  let model: Awaited<ReturnType<typeof startOpenCodeModel>> | undefined;
  let passed = false, cleanup = false;
  let originalFailure: unknown;
  let lastInputProgress: ReturnType<typeof nativeInputProgress> | undefined;
  let inputReadCount = 0;
  // Observation times from the existing read loop, not exact native request timestamps.
  const modelProgress: { elapsedMs: number; requests: number }[] = [];
  let originalOpenElapsedMs: number | undefined;
  let originalLaunchProgress: ReturnType<typeof nativeLaunchProgress> | undefined;
  const passive = !packaged
    ? (await import('./fixtures/native-opencode-team/passive-diagnostics.ts')).createPassiveNativeDiagnosticCapture()
    : undefined;
  let hostEpoch = 0;
  let windowsShellSha256: string | undefined;
  const cleanupErrors: unknown[] = [];
  const digests = {
    bun: await fileHash(bun), manifest: await fileHash(join(engine, 'opencode-v2-engine-manifest.json')),
    node: await fileHash(node), hostSource: packaged ? packaged.hostSourceDigest : await treeHash(join(pkg, 'src'), '.ts'),
    hostDist: await treeHash(join(pkg, 'dist'), '.js'),
    provider: packaged ? packaged.providerDigest : await fileHash(resolve(pkg, JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'))
      .dependencies['@agent-teams/provider-implementations'].slice(5))),
  };
  assert.equal(digests.manifest, manifestSha256);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-opencode-v2-host-')));
  try {
    for (const name of ['home', 'tmp', 'workspace', 'store', 'config', 'data', 'cache'])
      await mkdir(join(root, name), { mode: 0o700 });
    const environment = nativeHostEnvironment(node, root);
    if (process.platform === 'win32') {
      // Native 2.1.4 selects this shell from the isolated PATH. The inference
      // oracle additionally requires its actual advertised tool description.
      const shell = await realpath(join(environment.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'));
      assert.ok((await stat(shell)).isFile(), 'actual Windows PowerShell is required for the native shell turn');
      windowsShellSha256 = await fileHash(shell);
    }
    model = await startOpenCodeModel({ nativeGeneration: 'v2', nativeMessageImage: true,
      selectedModel: { id: 'TEST-model-B', effort: 'high' },
      selectedConfiguration: { scope: 'project-A' } });
    const namespace = basename(root);
    const owner = {
      ownerId: `TEST-owner-${namespace}`, revision: 'TEST-revision', storageRoot: join(root, 'store'),
      profileId: `TEST-profile-${namespace}`, protocolVersion: 1 as const, buildId: 'TEST-v2-embedded-host',
      nodeSha256: digests.node, hostEntrySha256: await fileHash(entry),
    };
    const scope = { projectId: `TEST-project-${namespace}`, workspaceId: `TEST-workspace-${namespace}`,
      teamId: 'TEST-team', runId: `TEST-run-${namespace}`, memberId: 'human', generation: '1' };
    const teamBinding = { backendId: owner.ownerId, teamId: scope.teamId, teamName: 'test-native-team' };
    const profile: TeamHostProfile = {
      schemaVersion: 1, owner, principalId: 'human',
      ...(process.platform === 'darwin' ? { processCustody: packaged ? packaged.processCustody! : {
        directory: process.env.OPENCODE_V2_EMBEDDED_PROCESS_CUSTODY_DIRECTORY!,
        manifestSha256: process.env.OPENCODE_V2_EMBEDDED_PROCESS_CUSTODY_MANIFEST_SHA256!,
      } } : {}),
      teams: [{ scope, binding: teamBinding,
        members: [{ memberId: 'carol-id', name: 'carol', role: 'member',
          delivery: { ...teamBinding, runId: scope.runId, memberId: 'carol-id', generation: '1' } }],
        grants: [
          { principalId: 'human', memberName: 'user', permissions: ['read', 'message.write', 'task.write', 'admin'] },
          { principalId: 'carol-session', memberName: 'carol', permissions: ['read', 'message.write', 'task.write'] },
        ],
      }],
      runtime: { members: [{
        teamId: scope.teamId, memberId: 'carol-id', principalId: 'carol-session', provider: 'opencode',
        nativeGeneration: 'v2', protocolRevision: '2.1.4', sessionId: `TEST-session-${namespace}`,
        generation: 1, configRevision: 'TEST-config-1', cwd: join(root, 'workspace'), model: 'TEST-model',
        endpoint: await endpoint(), accountBinding: 'TEST-localhost-account',
        executable: { path: bun, sha256: digests.bun },
        environment: {
          ...environment,
          XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
          XDG_CACHE_HOME: join(root, 'cache'), NO_COLOR: '1',
        },
        embedded: { directory: engine, manifestSha256, version: '2.1.4',
          platform: process.platform, arch: process.arch as 'arm64' | 'x64',
          externalDirectory: 'deny' },
        nativeOptions: { providerId: 'TEST-local', agent: 'TEST-member', toolApprovalMode: 'manual',
          instructions: `${CONTEXT_MARKER}. You are carol of test-native-team working only in ${join(root, 'workspace')}.` },
        // TEST readiness includes cold startup and custody/policy readback; the
        // original Darwin x64 trace reached the initial context PUT at 60.7s.
        limits: { queuedInputs: 2, inputBytes: 8192, outputBytes: 1_000_000,
          outputEvents: 1500, pendingInteractions: 4, timeoutMs: 120_000 },
      }] },
    };
    const globalDirectory = join(root, 'home/.config/opencode');
    await mkdir(globalDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(globalDirectory, 'opencode.json'), JSON.stringify({
      model: 'TEST-local/TEST-model', provider: { 'TEST-local': {
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: `${model.url}/v1`, apiKey: 'TEST-LOCALHOST-ONLY' },
        models: Object.fromEntries(['TEST-model', 'TEST-model-B'].map(id => [id, {
          name: id, limit: { context: 200000, output: 2000 },
          capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
          body: { test_config_scope: 'global' }, headers: { 'x-test-config-scope': 'global' },
          ...(id.endsWith('-B') ? { variants: [{ id: 'high', body: { reasoning_effort: 'high' } }] } : {}),
        }])),
      } },
    }), { mode: 0o600 });
    const projectPath = join(root, 'workspace/opencode.jsonc');
    const projectConfig = (scope: string) => JSON.stringify({
      model: 'TEST-local/TEST-model', provider: { 'TEST-local': { models: {
        'TEST-model-B': { body: { test_config_scope: scope }, headers: { 'x-test-config-scope': scope } },
      } } },
    });
    const originalProjectConfig = projectConfig('project-A');
    await writeFile(projectPath, originalProjectConfig, { mode: 0o600 });
    await mkdir(join(root, 'data/opencode'), { mode: 0o700 });
    await writeFile(join(root, 'data/opencode/auth.json'), JSON.stringify({
      'TEST-local': { type: 'api', key: 'TEST-LOCALHOST-ONLY' },
    }), { mode: 0o600 });
    const member = profile.runtime!.members[0]!;
    assert(member.provider === 'opencode' && member.embedded);
    member.embedded.configurationSource = captureOpenCodeConfigurationSource(member).reference;
    profile.runtime!.members[0] = applyLaunchConfiguration(applyOpenCodeRuntimeSource(member, {
      sourceKind: 'captured', executable: member.executable,
      openCodeDefault: { providerId: 'TEST-local', modelId: 'TEST-model' },
      openCodePreferences: { defaultModelId: 'TEST-local/TEST-model-B', modelLimitOverrides: {} },
    }), { effort: 'high', permissions: approvalMode === 'auto' ? 'bypass' : 'manual' });
    const profilePath = join(root, 'profile.json');
    const bytes = JSON.stringify(profile);
    await writeFile(profilePath, bytes, { mode: 0o600 });
    const start = () => {
      signal?.throwIfAborted();
      const epoch = ++hostEpoch;
      return startHost({ node, entry, root, profile: profilePath,
        profileHash: createHash('sha256').update(bytes).digest('hex'),
        ...(passive ? { testImports: [new URL('./fixtures/native-opencode-team/passive-diagnostics.ts', import.meta.url).href],
          onDiagnostic: (chunk: Buffer) => passive.accept(chunk, epoch) } : {}) });
    };
    const binding = { schemaVersion: 1, handleId: `TEST-handle-${namespace}`, owner, scope };
    const envelope = (commandId: string, payload: unknown) => ({ commandId, binding, payload });
    host = start();
    await host.rpc('host.handshake', { protocolVersion: 1 });
    // Observe the existing 120-second embedded startup plus MCP readiness; never retry the intent.
    const originalOpenStartedAt = performance.now();
    const opened = await host.rpc('runtime.open', envelope('TEST-open', { memberId: 'carol-id' }), 180_000)
      .finally(() => { originalOpenElapsedMs = Math.round(performance.now() - originalOpenStartedAt); });
    // This read cannot open/retry a member. Keep its original attempt even when nativeReady is false.
    try {
      originalLaunchProgress = nativeLaunchProgress(await host.rpc('team.launch.read',
        envelope('TEST-observe-original-launch', { launchId: scope.runId })));
    } catch { /* A failed diagnostic read cannot replace the original outcome. */ }
    assert.equal(opened.ok, true, JSON.stringify(opened));
    await writeFile(projectPath, projectConfig('project-B'), { mode: 0o600 });
    lastInputProgress = nativeInputProgress(record(opened.value));
    assert.equal(record(opened.value).nativeReady, true, JSON.stringify(opened));
    completeStep('original_host_embedded_native_and_mcp_ready');
    const imageReference = await uploadNativeMessageImage(host, envelope, 'carol');
    const commands = ['ONE', 'TWO'].map(label => envelope(`TEST-original-message-${label}`, {
      operation: 'message.send', payload: { to: 'carol', text: `OPENCODE_TEAM_${label}`,
        ...(label === 'TWO' ? { attachments: [imageReference] } : {}) },
    }));
    const originals: Record<string, unknown>[] = [], inputIds: string[] = [];
    const replies = new Set<string>();
    for (const command of commands) {
    const original = await host.rpc('team.execute', command); originals.push(original);
    assert.equal(original.ok, true); assert.equal(record(original.value).phase, 'completed');
    const inputId = record(record(original.value).effects).deliveryId;
    assert.equal(typeof inputId, 'string'); inputIds.push(inputId as string);
    let terminal = false;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      assert.deepEqual(model.failures, []);
      if (modelProgress.length < 16 && modelProgress.at(-1)?.requests !== model.observations.length)
        modelProgress.push({ elapsedMs: elapsedMs(), requests: model.observations.length });
      const result: Record<string, unknown> = await host.rpc('runtime.read', envelope('TEST-read', { memberId: 'carol-id' }));
      assert.equal(result.ok, true);
      const state = record(result.value);
      inputReadCount++;
      lastInputProgress = nativeInputProgress(state);
      for (const interaction of (state.interactions as unknown[]).map(record).filter(row => row.phase === 'pending')) {
        assert.equal(interaction.kind, 'permission'); assert.equal(interaction.inputId, inputId);
        assert.equal(typeof interaction.interactionRef, 'string');
        const ref = interaction.interactionRef as string;
        assert.ok(!replies.has(ref), 'one native grant, never retry an uncertain POST'); replies.add(ref);
        const granted: Record<string, unknown> = await host.rpc('runtime.interaction', envelope('TEST-once', {
          memberId: 'carol-id', expectedGeneration: '1', inputId, interactionRef: ref,
          reply: { kind: 'permission', decision: 'allow' },
        }));
        assert.equal(granted.ok, true, JSON.stringify(granted));
      }
      const input = (state.inputs as unknown[]).map(record).find(row => row.inputId === inputId);
      if (input?.phase === 'terminal') {
        assert.equal(input.terminal, 'succeeded', JSON.stringify(state)); terminal = true; break;
      }
      await tick();
    }
    assert.equal(terminal, true);
    assert.deepEqual(await host.rpc('team.execute', command), original);
    }
    assert.equal(replies.size, approvalMode === 'manual' ? 2 : 0);
    assert.deepEqual(model.failures, []); assert.equal(model.observations.length, 11);
    assert.ok(model.observations.every(row => row.requestedModel === 'TEST-model-B' &&
      row.requestedEffort === 'high'), 'every native tool turn keeps the explicitly selected model/variant');
    assert.ok(model.observations.every(row => row.contextEffective));
    const imageObservations = model.observations.filter(row => row.turn === 'OPENCODE_TEAM_TWO');
    assert.equal(imageObservations.length, 3);
    assert.ok(imageObservations.every(row => row.priorTurn && row.nativeImage?.exactCanonicalBytes));
    const imageRead = await readNativeMessageImage(host, envelope, originals[1]!);
    assert.equal(await readFile(join(root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\nTWO\n');
    const listed = await host.rpc('team.tasks.list', envelope('TEST-tasks', null));
    assert.equal(listed.ok, true); const tasks = listed.value as unknown[];
    assert.equal(tasks.length, 1); assert.equal(record(tasks[0]).status, 'completed');
    assert.equal(record(tasks[0]).owner, 'carol');
    assert.equal((record(tasks[0]).comments as unknown[]).length, 1);
    const inbox = JSON.parse(await readFile(join(root, 'store/teams/test-native-team/inboxes/user.json'), 'utf8')) as unknown[];
    assert.deepEqual(inbox.map(record).map(row => [row.from, row.text]),
      [['carol', 'REPLY_OPENCODE_ONE'], ['carol', 'REPLY_OPENCODE_TWO']]);
    const activity = await host.rpc('runtime.activity.snapshot', envelope('TEST-activity', { memberId: 'carol-id' }));
    assert.equal(activity.ok, true);
    const failedShellObserved = (record(record(activity.value).latest).tools as unknown[]).map(record).some(row =>
      record(row.data).kind === 'tool-result' && record(row.data).isError === true);
    completeStep('native_model_tool_effect_permission_mcp_task_and_reply_completed_once');
    completeStep('changed_project_config_did_not_retarget_running_native_session');
    completeStep('original_uploaded_PNG_native_image_inference_and_public_readback');
    const checkpoint = await host.rpc('runtime.checkpoint', envelope('TEST-checkpoint', {
      memberId: 'carol-id', checkpointId: 'TEST-before-cold',
    }));
    assert.equal(checkpoint.ok, true); assert.equal(record(checkpoint.value).status, 'published');
    const stopped = await host.rpc('runtime.stop', envelope('TEST-stop', { memberId: 'carol-id' }));
    assert.equal(stopped.ok, true); assert.equal(record(stopped.value).phase, 'closed');
    assert.equal(record(stopped.value).custody, 'released');
    await host.close(); hosts.push(host.facts()); host = undefined;
    completeStep('checkpoint_and_original_host_native_cleanup_confirmed');
    await writeFile(projectPath, originalProjectConfig, { mode: 0o600 });
    const callsBefore = model.observations.length;
    host = start(); await host.rpc('host.handshake', { protocolVersion: 1 });
    for (const [index, command] of commands.entries()) {
      assert.deepEqual(await host.rpc('team.lookup', command), originals[index]);
      assert.deepEqual(await host.rpc('team.execute', command), originals[index]);
    }
    assert.deepEqual(await readNativeMessageImage(host, envelope, originals[1]!), imageRead);
    const recovered = await host.rpc('runtime.read', envelope('TEST-recovered', { memberId: 'carol-id' }));
    assert.equal(recovered.ok, true); assert.equal(record(recovered.value).attached, false);
    const inputs = (record(recovered.value).inputs as unknown[]).map(record);
    assert.equal(inputs.length, 2);
    assert.deepEqual(inputs.map(input => input.inputId), inputIds);
    assert.ok(inputs.every(input => input.phase === 'terminal' && input.terminal === 'succeeded'));
    const restored = await host.rpc('runtime.restore', envelope('TEST-restore', {
      memberId: 'carol-id', reference: record(checkpoint.value).reference,
      expectedGeneration: record(opened.value).generation,
    }), 180_000);
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(record(restored.value).nativeReady, true);
    assert.notEqual(record(restored.value).generation, record(opened.value).generation);
    await new Promise<void>(done => setTimeout(done, 250));
    assert.deepEqual(model.failures, []); assert.equal(model.observations.length, callsBefore);
    assert.equal(await readFile(join(root, 'workspace/native-effect.txt'), 'utf8'), 'ONE\nTWO\n');
    const resumedStop = await host.rpc('runtime.stop', envelope('TEST-resumed-stop', {
      memberId: 'carol-id', expectedGeneration: record(restored.value).generation,
    }));
    assert.equal(resumedStop.ok, true); assert.equal(record(resumedStop.value).custody, 'released');
    await host.close(); hosts.push(host.facts()); host = undefined;
    completeStep('cold_host_restored_native_history_without_model_or_tool_replay');
    assert.equal(failedShellObserved, true, 'native shell exit 7 is reported as a failed tool');
    if (packaged) await packaged.verify();
    else await assertNativeV1Build(repo, sourceHead, sourceBuild!);
    assert.equal(await treeHash(join(pkg, 'dist'), '.js'), digests.hostDist);
    signal?.throwIfAborted();
    passed = true;
  } catch (error) { originalFailure = error; }
  finally {
    try {
      if (host) { try { await host.close(); } finally { hosts.push(host.facts()); } }
    } catch (error) { cleanupErrors.push(error); }
    try { await model?.close(); } catch (error) { cleanupErrors.push(error); }
    signal?.removeEventListener('abort', cancelOriginalHost);
    cleanup = cleanupErrors.length === 0;
    let serialized: string | undefined;
    let receiptWritten = false;
    try {
      const receipt = {
        kind: packaged ? 'TEST_PACKAGED_NATIVE_V2_HOST' : 'TEST_NATIVE_V2_EMBEDDED_HOST',
        status: passed && cleanup && !signal?.aborted ? 'PASS' : 'INCOMPLETE',
        ...(packaged ? { packaged: packaged.evidence } : {}),
        sourceHead, platform: `${process.platform}-${process.arch}`,
        version: '2.1.4', approvalMode, nodeVersion: process.version,
        modelSelection: { providerId: 'TEST-local', modelId: 'TEST-model-B', variant: 'high' },
        configurationSelection: { scope: 'project', original: 'project-A', later: 'project-B' },
        preferencesSelection: { nativeDefault: 'TEST-local/TEST-model', appDefault: 'TEST-local/TEST-model-B' },
        digests: { ...digests, ...(windowsShellSha256 ? { windowsShell: windowsShellSha256 } : {}) },
        steps, cleanup, phaseElapsedMs, elapsedMs: elapsedMs(), cancelled: signal?.aborted === true,
        inputObservation: { reads: inputReadCount, last: lastInputProgress ?? null },
        launchObservation: { openElapsedMs: originalOpenElapsedMs ?? null, afterOpen: originalLaunchProgress ?? null },
        ...(passive ? { passiveNativeDiagnostics: passive.entries } : {}),
        failureCode: originalFailure instanceof Error && 'code' in originalFailure &&
          typeof originalFailure.code === 'string' &&
          ['ERR_ASSERTION', 'ABORT_ERR', 'EPIPE', 'ECONNRESET', 'ETIMEDOUT'].includes(originalFailure.code)
            ? originalFailure.code : null,
        hosts: hosts.map(({ exitCode, signalCode, stdoutValid }) => ({ exitCode, signalCode, stdoutValid })),
        modelOrigin: 'localhost-scripted', modelRequests: model?.observations.length ?? 0, modelProgress,
        modelFailures: model?.failures ?? [], vendorAuthQualified: false,
        desktopQualified: false, releaseQualified: false,
      };
      serialized = JSON.stringify(receipt, null, 2) + '\n';
      await writeFile(receiptPath, serialized, { mode: 0o600 });
      if (signal?.aborted && receipt.status === 'PASS') {
        receipt.status = 'INCOMPLETE'; receipt.cancelled = true;
        serialized = JSON.stringify(receipt, null, 2) + '\n';
        await writeFile(receiptPath, serialized, { mode: 0o600 });
      }
      receiptWritten = true;
    } catch (error) { cleanupErrors.push(error); }
    if (serialized !== undefined && (originalFailure !== undefined || cleanupErrors.length > 0 || !passed || signal?.aborted)) {
      await writeNativeFailureReceipt({
        kind: 'TEST_NATIVE_V2_FAILURE_RECEIPT', sourceHead, platform: `${process.platform}-${process.arch}`, serialized,
        details: { receiptWritten, hosts: hosts.map(({ diagnosticBytes, frames }) => ({ diagnosticBytes, frames: frames.slice(-16) })) },
      });
    }
  }
  if (originalFailure !== undefined) throw originalFailure;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'TEST native Host cleanup or receipt failed');
  signal?.throwIfAborted();
  assert.equal(passed, true);
}

if (process.env.OPENCODE_V2_PACKAGED_GO !== '1')
  test('embedded 2.1.4 performs native tools, MCP, once approval and cold Host Resume without replay', {
    // Exact c57 Darwin x64 receipt completed both turns and cold restore in 323s.
    // Only this outer TEST budget grows; native startup/turn/cleanup limits stay fixed.
    timeout: process.platform === 'darwin' && process.arch === 'x64' ? 420_000 : 300_000,
    skip: process.env.OPENCODE_V2_EMBEDDED_HOST_GO !== '1',
  }, context => runOpenCodeV2EmbeddedHostNative(undefined, context.signal));
