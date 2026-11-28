import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { CONTEXT_MARKER, record } from './fixtures/native-claude-team/model.ts';
import { startEvidenceModel } from './fixtures/native-claude-evidence/model.ts';
import { fileHash, startHost, tick, treeHash } from './fixtures/native-host.ts';
import { runtimeDigest } from '../dist/runtime/identity.js';
import type { TeamHostProfile } from '../dist/composition/TeamHost.js';

type Row = Record<string, unknown>;
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function rows(file: string): Promise<Row[]> {
  try { return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => record(JSON.parse(line))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
function absent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); return true; }
}
function descendants(parent: number) {
  const all = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    assert.ok(match); return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4]! };
  });
  const owned = new Set([parent]); let changed = true;
  while (changed) { changed = false; for (const child of all) if (owned.has(child.ppid) && !owned.has(child.pid)) { owned.add(child.pid); changed = true; } }
  return all.filter(child => child.pid !== parent && owned.has(child.pid));
}

test('actual standalone Host + MCP-created Task user-start cause + native foreground batch evidence (partial)', { timeout: 240_000 }, async (t) => {
  assert.equal(process.env.LEGACY_NATIVE_HOST_EVIDENCE_GO, '1');
  const repo = resolve(import.meta.dirname, '../../..'), pkg = join(repo, 'packages/legacy-agent-host');
  const node = await realpath(join(repo, 'resources/legacy-agent-host/node/v24.21.0/darwin-arm64/node'));
  assert.equal(await realpath(process.execPath), node);
  const artifact = join(repo, 'vendor/provider-migration/claude-capture-batch-v2/agent-teams-provider-implementations-0.0.0.tgz');
  assert.equal(await fileHash(artifact), '6c57a7bb69a5213b75b9d0393c4d2aec0b75096ae147fc65ccae0fc37d190d1a');
  const providerEntry = import.meta.resolve('@agent-teams/provider-implementations/claude');
  const providerRoot = resolve(dirname(new URL(providerEntry).pathname), '..');
  const members = execFileSync('/usr/bin/tar', ['-tf', artifact], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(members.length, 187); assert.equal(members.filter(path => path.startsWith('package/dist/')).length, 184);
  const installed = [];
  for (const path of members) {
    assert.ok(path.startsWith('package/') && !path.includes('..'));
    const bytes = await readFile(join(providerRoot, path.slice(8)));
    assert.deepEqual(bytes, execFileSync('/usr/bin/tar', ['-xOf', artifact, path]));
    installed.push({ path, sha256: hash(bytes) });
  }
  const providerRequire = createRequire(providerEntry), sdk = providerRequire.resolve('@anthropic-ai/claude-agent-sdk');
  const native = await realpath(createRequire(sdk).resolve('@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'));
  const entry = join(pkg, 'dist/cli.js');
  const pins = { node: { path: node, sha256: await fileHash(node), version: process.version },
    provider: { path: artifact, sha256: await fileHash(artifact), installed },
    sdk: { path: sdk, sha256: await fileHash(sdk), version: record(JSON.parse(await readFile(join(dirname(sdk), 'package.json'), 'utf8'))).version },
    native: { path: native, sha256: await fileHash(native) },
    host: { entry, entrySha256: await fileHash(entry), sourceSha256: await treeHash(join(pkg, 'src'), '.ts'), distSha256: await treeHash(join(pkg, 'dist'), '.js') } };
  assert.equal(pins.node.sha256, 'e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b');
  assert.equal(pins.sdk.version, '0.3.305');
  assert.equal(pins.sdk.sha256, 'c8d3e6cf794501c9b2dad3199762e4594e7b890e8ce76f957e9d748e02680bb1');
  assert.equal(pins.native.sha256, 'ea3ea3c08d2a9634a4651e687fcf900d410c489bce2b00f22bd7352b91ba704f');
  const expectedCapture = JSON.parse(await readFile(join(repo, '.artifacts/provider-migration/host-observe-batch-v1/final-generated-source.json'), 'utf8')) as Row[];
  for (const item of expectedCapture) assert.equal(await fileHash(join(repo, String(item.source).replace('/src/', '/dist/').replace(/\.ts$/, '.js'))), item.jsSha256);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-host-evidence-')));
  t.diagnostic(`TEST receipt: ${join(root, 'receipt.json')}`);
  for (const directory of ['home', 'config', 'tmp', 'workspace', 'store', 'xdg-config', 'xdg-data', 'xdg-cache']) await mkdir(join(root, directory), { mode: 0o700 });
  const workspace = join(root, 'workspace');
  await writeFile(join(workspace, 'dirty.txt'), 'INDEX_BASE\n');
  await writeFile(join(workspace, 'hook-side.txt'), 'HOOK_BEFORE\n');
  const gitEnv = { HOME: join(root, 'home'), PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  execFileSync('/usr/bin/git', ['-c', 'init.templateDir=', 'init', '-q', workspace], { env: gitEnv });
  execFileSync('/usr/bin/git', ['-C', workspace, 'add', '--', 'dirty.txt', 'hook-side.txt'], { env: gitEnv });
  await writeFile(join(workspace, 'dirty.txt'), 'DIRTY\n');
  await mkdir(join(workspace, '.claude'));
  const hookPath = resolve(import.meta.dirname, 'fixtures/native-claude-evidence/post-hook.ts');
  await writeFile(join(workspace, '.claude/settings.json'), JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: `${quote(node)} ${quote(hookPath)} ${quote(root)}`, timeout: 10 }] }] } }, null, 2));
  await cp(join(pkg, 'dist'), join(root, 'executed-host'), { recursive: true });
  await cp(join(pkg, 'src'), join(root, 'collected-host-source'), { recursive: true });
  assert.equal(await treeHash(join(root, 'executed-host'), '.js'), pins.host.distSha256);
  const sources = [];
  for (const file of ['native-claude-evidence.native.ts', 'fixtures/native-claude-evidence/model.ts', 'fixtures/native-claude-evidence/post-hook.ts', 'fixtures/native-host.ts', 'fixtures/native-claude-team/model.ts']) {
    const destination = join(root, 'executed-test-source', file);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(import.meta.dirname, file), destination);
    sources.push({ file, sha256: await fileHash(destination) });
  }
  const model = await startEvidenceModel(root);
  let host: ReturnType<typeof startHost> | undefined;
  let finalRuntime: Row = {}, privateRuntime: Row = {}, review: Row = {};
  const receipts: Row[] = [], runtimeReads: Row[] = [];
  let childFacts: ReturnType<typeof descendants> = [];
  const hookProof: Row[] = [];
  let passed = false, failure: string | undefined;
  const receipt: Row = { status: 'INCOMPLETE', root, pins, sources, receipts, runtimeReads, hookProof,
    scope: 'Actual standalone Host composition through selected public D and actual native SDK/MCP/tools; partial selected-path foreground ledger only',
    dirtyProof: { indexOnly: true, noHeadOrCommit: true, index: execFileSync('/usr/bin/git', ['-C', workspace, 'show', ':dirty.txt'], { env: gitEnv, encoding: 'utf8' }), dirty: await readFile(join(workspace, 'dirty.txt'), 'utf8') },
    modelRequests: model.observations, modelFailures: model.failures, m13: 'GAP', nativeProfile: 'TEST project PostToolUse command hook on Write, 600ms delay then secondary file; no SDK or provider modification' };
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ phase: 'prepared', root, receipt: join(root, 'receipt.json') }));
  try {
    const namespace = basename(root);
    const owner = { ownerId: `TEST-owner-${namespace}`, revision: 'TEST-revision', storageRoot: join(root, 'store'), profileId: `TEST-profile-${namespace}`,
      protocolVersion: 1 as const, buildId: 'TEST-host-evidence', nodeSha256: pins.node.sha256, hostEntrySha256: pins.host.entrySha256 };
    const scope = { projectId: `TEST-project-${namespace}`, workspaceId: `TEST-workspace-${namespace}`, teamId: 'TEST-team', runId: `TEST-run-${namespace}`, memberId: 'human', generation: '1' };
    const teamBinding = { backendId: owner.ownerId, teamId: scope.teamId, teamName: 'test-native-team' };
    const delivery = { ...teamBinding, runId: scope.runId, memberId: 'alice-id', generation: '1' };
    const profile: TeamHostProfile = { schemaVersion: 1, owner, principalId: 'human', teams: [{ scope, binding: teamBinding,
      members: [{ memberId: 'alice-id', name: 'alice', role: 'member', delivery }], grants: [
        { principalId: 'human', memberName: 'user', permissions: ['read', 'message.write', 'task.write', 'admin'] },
        { principalId: 'alice-session', memberName: 'alice', permissions: ['read', 'message.write', 'task.write'] },
      ] }], runtime: { members: [{ teamId: scope.teamId, memberId: 'alice-id', principalId: 'alice-session', provider: 'claude',
        sessionId: `TEST-session-${namespace}`, generation: 1, configRevision: 'TEST-config-1', cwd: workspace, model: 'claude-sonnet-4-6', accountBinding: 'TEST-dummy-account', executable: pins.native,
        environment: { HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'config'), TMPDIR: join(root, 'tmp'), XDG_CONFIG_HOME: join(root, 'xdg-config'), XDG_DATA_HOME: join(root, 'xdg-data'), XDG_CACHE_HOME: join(root, 'xdg-cache'),
          PATH: `${dirname(node)}:/usr/bin:/bin`, SHELL: '/bin/sh', ANTHROPIC_API_KEY: 'TEST-LOCALHOST-ONLY-NOT-A-REAL-KEY', ANTHROPIC_BASE_URL: model.url,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', NO_COLOR: '1', TERM: 'dumb' },
        nativeTools: ['Bash', 'Read', 'Write', 'Edit'], autoAllowedTools: ['Bash', 'Read', 'Write', 'Edit'],
        nativeOptions: { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, settingSources: ['project'], projectInstructions: { append: `${CONTEXT_MARKER}. You are alice in test-native-team. TEST only ${workspace}.` } },
        limits: { queuedInputs: 2, inputBytes: 8192, outputBytes: 4_000_000, outputEvents: 2000, pendingInteractions: 4, timeoutMs: 45000 },
      }] } };
    const profilePath = join(root, 'profile.json'), profileBytes = JSON.stringify(profile);
    await writeFile(profilePath, profileBytes, { mode: 0o600 });
    const binding = { schemaVersion: 1, handleId: `TEST-handle-${namespace}`, owner, scope };
    const envelope = (commandId: string, payload: unknown) => ({ commandId, binding, payload });
    host = startHost({ node, entry, root, profile: profilePath, profileHash: hash(profileBytes) });
    receipt.profileSha256 = hash(profileBytes); receipt.hostPid = host.child.pid;
    await host.rpc('host.handshake', { protocolVersion: 1 });
    const launch = await host.rpc('team.launch.read', envelope('TEST-launch-read', {})); assert.equal(launch.ok, true);
    const selected = record(launch.value);
    const started = await host.rpc('team.launch.start', envelope('TEST-launch', { launchId: selected.launchId, rosterRevision: selected.rosterRevision }));
    assert.equal(started.ok, true, JSON.stringify(started)); receipts.push(started);
    let ready = false; const readyDeadline = Date.now() + 45000;
    while (Date.now() < readyDeadline) {
      const state = await host.rpc('runtime.read', envelope('TEST-ready', { memberId: 'alice-id' })); assert.equal(state.ok, true);
      if (record(state.value).nativeReady === true) { ready = true; break; } await tick();
    }
    assert.ok(ready, 'actual selected native MCP discovery');
    childFacts = descendants(host.child.pid!);
    assert.ok(childFacts.some(child => child.command.startsWith(native)), 'actual pinned native child belongs to this Host');
    childFacts = childFacts.map(child => ({ ...child, command: child.command.replace(/--mcp-config [\s\S]*?(?= --(?:setting-sources|strict-mcp-config))/, '--mcp-config [private TEST capability redacted]') }));
    receipt.childrenAtReady = childFacts;
    const projectDir = join(root, 'store/teams/test-native-team/.host-evidence');
    const waitTerminal = async (inputId: string, watchHook = false) => {
      let sawHook = false; const deadline = Date.now() + 70000;
      while (Date.now() < deadline) {
        assert.deepEqual(model.failures, []);
        if (watchHook && !sawHook) {
          const log = await rows(join(root, 'post-hook.ndjson'));
          if (log.some(row => row.phase === 'started') && !log.some(row => row.phase === 'finished')) {
            const events = await rows(join(projectDir, '.board-task-changes/events', `${model.taskId()}.jsonl`));
            assert.equal(events.some(row => row.toolUseId === 'capture_write'), false, 'provisional after cannot publish before delayed hook completion');
            hookProof.push({ at: Date.now(), hookRunning: true, writeEvents: 0 }); sawHook = true;
          }
        }
        const read = await host!.rpc('runtime.read', envelope('TEST-read', { memberId: 'alice-id' })); assert.equal(read.ok, true);
        finalRuntime = record(read.value);
        const input = (finalRuntime.inputs as unknown[]).map(record).find(row => row.inputId === inputId);
        if (input?.phase === 'terminal') {
          runtimeReads.push(structuredClone(finalRuntime)); assert.equal(input.terminal, 'succeeded');
          if (watchHook) assert.ok(sawHook, 'delayed actual project hook interval was observed'); return;
        }
        await tick();
      }
      throw new Error('TEST native input did not settle; no retry');
    };
    const bootstrap = await host.rpc('team.execute', envelope('TEST-bootstrap', { operation: 'message.send', payload: { to: 'alice', text: 'NATIVE_CAPTURE_BOOTSTRAP' } }));
    assert.equal(bootstrap.ok, true); receipts.push(bootstrap);
    await waitTerminal(String(record(record(bootstrap.value).effects).deliveryId));
    const taskId = model.taskId(); assert.ok(taskId);
    const start = await host.rpc('team.execute', envelope('TEST-user-start', { operation: 'task.start', payload: { taskId, notification: 'user' } }));
    assert.equal(start.ok, true, JSON.stringify(start)); assert.equal(record(start.value).phase, 'completed'); receipts.push(start);
    // task.start's generic receipt effect is not its TaskRecovery notification delivery.
    // Read the actual persisted owner outbox rather than inventing an ID or selecting current input.
    const outboxDirectory = join(root, 'store/teams/test-native-team/.host-owner/outbox');
    const outboxes = await Promise.all((await readdir(outboxDirectory)).filter(file => file.endsWith('.json')).map(async file => record(JSON.parse(await readFile(join(outboxDirectory, file), 'utf8')))));
    const matching = outboxes.filter(row => row.commandId === 'TEST-user-start' && row.messageId === record(record(start.value).effects).messageId);
    assert.equal(matching.length, 1);
    const inputId = String(matching[0]!.inputId);
    assert.equal(inputId, matching[0]!.deliveryId);
    receipt.taskStartOutbox = matching[0];
    await waitTerminal(inputId, true);
    const events = await rows(join(projectDir, '.board-task-changes/events', `${taskId}.jsonl`));
    const notices = await rows(join(projectDir, '.board-task-changes/notices', `${taskId}.jsonl`));
    receipt.events = events; receipt.notices = notices;
    assert.equal(events.length, 4, 'failed Bash, Edit, Write target and delayed mapped hook side file only');
    const runtimeBinding = { backendId: owner.ownerId, teamId: scope.teamId, runId: scope.runId, memberId: 'alice-id', generation: '1' };
    const memberKey = runtimeDigest({ backendId: owner.ownerId, teamId: scope.teamId, memberId: 'alice-id' });
    const recordPath = join(root, 'store/runtime-sessions', memberKey, `${runtimeDigest(runtimeBinding)}.json`);
    privateRuntime = record(JSON.parse(await readFile(recordPath, 'utf8')));
    const originalInput = (privateRuntime.inputs as unknown[]).map(record).find(row => record(row.intent).inputId === inputId)!;
    assert.ok(originalInput);
    for (const event of events) {
      const cause = record(event.causalBinding);
      assert.equal(cause.taskId, taskId); assert.equal(cause.taskStartCommandId, 'TEST-user-start'); assert.equal(cause.inputId, inputId);
      assert.equal(cause.operationRef, originalInput.operationRef); assert.equal(cause.sessionRef, privateRuntime.sessionRef);
      assert.deepEqual(cause.binding, runtimeBinding); assert.equal(cause.hostIncarnation, privateRuntime.hostIncarnation);
      assert.equal(event.executionSeq, 0); assert.equal(record(cause.provenance).reviewableComplete, false);
      assert.equal(event.confidence, 'low');
    }
    const content = async (event: Row, side: 'before' | 'after') => {
      const ref = record(event[side]); return readFile(join(projectDir, '.board-task-changes/blobs', String(ref.blobRef)), 'utf8');
    };
    const failed = events.find(row => row.toolUseId === 'capture_failed_bash')!;
    assert.equal(failed.toolStatus, 'failed'); assert.equal(await content(failed, 'before'), 'DIRTY\n'); assert.equal(await content(failed, 'after'), 'DIRTY\nFAILED\n');
    const edit = events.find(row => row.toolUseId === 'capture_edit')!;
    assert.equal(edit.toolStatus, 'succeeded'); assert.equal(await content(edit, 'before'), 'DIRTY\nFAILED\n'); assert.equal(await content(edit, 'after'), 'DIRTY\nEDITED\n');
    const write = events.find(row => row.toolUseId === 'capture_write' && row.relativePath === 'write-target.txt')!;
    assert.equal(record(write.beforeState).exists, false); assert.equal(await content(write, 'after'), 'WRITE\n');
    const late = events.find(row => row.toolUseId === 'capture_write' && row.relativePath === 'hook-side.txt')!;
    assert.equal(await content(late, 'before'), 'HOOK_BEFORE\n'); assert.equal(await content(late, 'after'), 'HOOK_LATE\n');
    assert.ok(notices.some(row => String(row.message).includes('background')));
    assert.ok(notices.filter(row => String(row.message).includes('multi-tool-batch')).length >= 2);
    assert.equal(events.some(row => ['capture_background', 'capture_overlap_a', 'capture_overlap_b'].includes(String(row.toolUseId))), false);
    const listed = await host.rpc('team.tasks.list', envelope('TEST-list', null)); assert.equal(listed.ok, true);
    const tasks = listed.value as Row[]; assert.equal(tasks.length, 1); assert.equal(tasks[0]!.owner, 'alice'); assert.equal(tasks[0]!.status, 'in_progress');
    review = await host.rpc('team.review.getTaskChanges', envelope('TEST-review-read', { taskId, options: { includeDetails: true } }));
    assert.equal(review.ok, true, JSON.stringify(review));
    const reviewSet = record(record(review.value).value);
    assert.equal(record(reviewSet.provenance).sourceKind, 'ledger');
    assert.ok((reviewSet.files as Row[]).some(row => row.filePath === join(workspace, 'hook-side.txt')));
    receipt.task = tasks[0]; receipt.review = review; receipt.originalRuntimeInput = originalInput; receipt.privateRuntime = privateRuntime;
    const stopped = await host.rpc('runtime.stop', envelope('TEST-stop', { memberId: 'alice-id' })); assert.equal(stopped.ok, true);
    finalRuntime = record(stopped.value); assert.equal(finalRuntime.phase, 'closed'); assert.equal(finalRuntime.custody, 'released');
    passed = true;
  } catch (error) { failure = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error); throw error; }
  finally {
    let cleanupConfirmed = false;
    try {
      if (host) await host.close();
      cleanupConfirmed = true;
    } finally {
      if (host) receipt.host = host.facts();
      receipt.cleanupConfirmed = cleanupConfirmed;
      await model.close();
      receipt.childAbsence = childFacts.map(child => ({ ...child, absent: absent(child.pid) }));
      receipt.finalRuntime = finalRuntime; receipt.failure = failure;
      receipt.hostDistUnchanged = pins.host.distSha256 === await treeHash(join(pkg, 'dist'), '.js');
      receipt.nativePinUnchanged = pins.native.sha256 === await fileHash(native);
      receipt.sdkPinUnchanged = pins.sdk.sha256 === await fileHash(sdk);
      receipt.status = passed && cleanupConfirmed && (receipt.childAbsence as Row[]).every(child => child.absent) && receipt.hostDistUnchanged && receipt.nativePinUnchanged && receipt.sdkPinUnchanged ? 'SCOPED_PASS_WITH_GAPS' : 'INCOMPLETE';
      await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ status: receipt.status, receipt: join(root, 'receipt.json') }));
      assert.ok((receipt.childAbsence as Row[]).every(child => child.absent), 'captured native descendants physically absent');
      assert.equal(receipt.hostDistUnchanged, true); assert.equal(receipt.nativePinUnchanged, true); assert.equal(receipt.sdkPinUnchanged, true);
    }
  }
});
