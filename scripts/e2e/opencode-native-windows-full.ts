/** Real Windows packaged task qualification. Never enables the production gate.
 * Inputs: packaged.exe, SDK cli|bundled, pinned OpenCode.exe, provider/model,
 * explicit host-local TEST auth.json. No ambient credentials are imported.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { NativeDesktopIpcError, prepareNativeDesktop } from './opencode-native-desktop-host';
import { protectWindowsTestDirectory } from './opencode-native-test-auth';
import { waitFor } from './release-updater/cdp.mts';

const execute = promisify(execFile);
// The qualified Windows candidate retains over 82k files and about 15 MiB of digests.
const BUNDLED_MANIFEST_MAX_BYTES = 32 * 1024 * 1024;
const BUNDLED_MANIFEST_MAX_ENTRIES = 131_072;
let preproofStage = 'arguments';
const preproofFacts: { manifestBytes?: number; manifestEntries?: number } = {};
type App = Awaited<ReturnType<Awaited<ReturnType<typeof prepareNativeDesktop>>['launch']>>;
type Identity = { pid: number; birth: string; executable: string; command: string };
type ProofFailure = { stage: string; classification: string; operation?: string; errno?: string };
function proofFailure(error: unknown, stage: string): ProofFailure {
  if (error instanceof NativeDesktopIpcError)
    return { stage, operation: error.operation, classification: error.classification };
  const result: ProofFailure = { stage, classification: 'unclassified' };
  if (error instanceof assert.AssertionError) result.classification = 'assertion_failed';
  else if (error instanceof Error && error.message.startsWith('Native gate timed out:'))
    result.classification = 'timeout';
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^E[A-Z0-9_]{1,48}$/.test(error.code)
  )
    result.errno = error.code;
  return result;
}
const ps = async (script: string) =>
  execute(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      env: Object.fromEntries(
        ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'COMSPEC', 'TMP', 'TEMP']
          .filter((key) => process.env[key])
          .map((key) => [key, process.env[key]])
      ),
      timeout: 10_000,
      maxBuffer: 16_384,
    }
  );

async function identity(pid: number): Promise<Identity | null> {
  assert(Number.isSafeInteger(pid) && pid > 1);
  const { stdout } = await ps(
    `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($null -eq $p){'null';exit}; if(!$p.ExecutablePath -or !$p.CommandLine -or !$p.CreationDate){throw 'Process identity unavailable'}; @{pid=[int]$p.ProcessId;birth=$p.CreationDate.ToUniversalTime().ToString('o');executable=$p.ExecutablePath;command=$p.CommandLine}|ConvertTo-Json -Compress`
  );
  const value = JSON.parse(stdout) as Identity | null;
  if (value) assert(value.pid === pid && value.birth && value.executable && value.command);
  return value;
}
const same = (a: Identity | null, b: Identity) =>
  Boolean(
    a &&
    a.pid === b.pid &&
    a.birth === b.birth &&
    a.executable === b.executable &&
    a.command === b.command
  );

async function seedSelectedAuth(file: string, provider: string, directory: string) {
  // Read only the explicitly supplied local file; never emit its content/errors.
  preproofStage = 'auth_directory';
  await mkdir(directory, { recursive: true });
  await protectWindowsTestDirectory(directory);
  let selected: unknown;
  try {
    preproofStage = 'auth_read';
    assert(/(?:^|[\\/])TEST-[^\\/]+(?:[\\/]|$)/.test(file), 'Explicit TEST auth custody required');
    const stat = await lstat(file);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024);
    assert.equal(await realpath(file), file);
    const source = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    selected = source[provider];
    assert(selected && typeof selected === 'object' && !Array.isArray(selected));
    const record = selected as Record<string, unknown>;
    const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
    assert(
      (record.type === 'api' && text(record.key)) ||
        (record.type === 'oauth' && (text(record.access) || text(record.refresh)))
    );
  } catch {
    throw new Error('Selected local TEST auth is invalid');
  }
  preproofStage = 'auth_write';
  await writeFile(path.join(directory, 'auth.json'), JSON.stringify({ [provider]: selected }), {
    flag: 'wx',
  });
  // File is created inside the protected owner/SYSTEM-only directory.
}

async function ready(app: App) {
  await waitFor(
    async () => {
      const status = await app.call('getStartupStatus');
      assert(!status.error, 'Owned application initialization failed');
      return status.ready ? true : null;
    },
    'owned application ready',
    180_000
  );
}
async function provisioned(app: App, runId: string) {
  await waitFor(
    async () => {
      const status = await app.call('getProvisioningStatus');
      assert(status.state !== 'failed', 'Owned provisioning failed');
      return status.runId === runId && status.state === 'ready' ? true : null;
    },
    'owned team ready',
    420_000
  );
}
async function completed(app: App, id: string, owner: string, comment: string) {
  await waitFor(
    async () => {
      const task = await app.call('getTask', id);
      assert(task && task.owner === owner, 'Owned task missing or reassigned');
      if (task.status !== 'completed') return null;
      const durable = task.comments?.find((row) => row.author === owner && row.text === comment);
      const terminal = task.historyEvents?.find(
        (event) => event.type === 'status_changed' && event.to === 'completed'
      );
      assert(
        durable &&
          terminal &&
          Number.isFinite(Date.parse(durable.createdAt)) &&
          Number.isFinite(Date.parse(terminal.timestamp)) &&
          Date.parse(durable.createdAt) <= Date.parse(terminal.timestamp),
        'Actual agent durable comment must precede completed history event'
      );
      return true;
    },
    'real task completion with comment',
    420_000
  );
}
function resultHasMarker(content: unknown, marker: string): boolean {
  if (typeof content !== 'string') return false;
  if (content.split(/\r?\n/).includes(marker)) return true;
  // Existing projector serializes V2 native text-content arrays as JSON.
  try {
    const blocks: unknown = JSON.parse(content);
    return (
      Array.isArray(blocks) &&
      blocks.some(
        (block) =>
          block &&
          typeof block === 'object' &&
          'type' in block &&
          block.type === 'text' &&
          'text' in block &&
          typeof block.text === 'string' &&
          block.text.split(/\r?\n/).includes(marker)
      )
    );
  } catch {
    return false;
  }
}
async function commandEvidence(
  app: App,
  taskId: string,
  member: string,
  session: string,
  program: string,
  marker: string,
  version: string,
  expectedModel: string
) {
  return waitFor(
    async () => {
      const stream = await app.call('getTaskLogStream', taskId);
      for (const segment of stream.segments) {
        if (segment.actor.memberName !== member || segment.actor.sessionId !== session) continue;
        for (const chunk of segment.chunks) {
          if (chunk.chunkType !== 'ai') continue;
          const assistantModels = chunk.responses
            .filter((response) => response.type === 'assistant' || response.role === 'assistant')
            .map((response) => response.model)
            .filter((value): value is string => typeof value === 'string' && value.length > 0);
          assert(
            assistantModels.every((value) => value === expectedModel),
            'Actual assistant inference used a different model'
          );
          if (!assistantModels.includes(expectedModel)) continue;
          const native = chunk.toolExecutions.filter((execution) => {
            const command = execution.toolCall.input.command;
            return (
              ['bash', 'shell', 'exec'].includes(execution.toolCall.name) &&
              typeof command === 'string' &&
              command.includes(program) &&
              /\bnode(?:\.exe)?\b/i.test(command)
            );
          });
          const succeeded = (execution: (typeof chunk.toolExecutions)[number]) =>
            execution.result?.toolUseId === execution.toolCall.id &&
            execution.result.isError === false &&
            resultHasMarker(execution.result.content, marker);
          if (native.some(succeeded)) return 'paired-native-shell-result';
          // V2 canonical CodeMode metadata proves an actual native invocation but
          // deliberately provides no child result. Keep the successful composite
          // output separate; never manufacture a paired nested result/status.
          if (
            version.startsWith('2.') &&
            native.length &&
            chunk.toolExecutions.some(
              (execution) => execution.toolCall.name === 'execute' && succeeded(execution)
            )
          )
            return 'code-mode-outer-result-plus-native-invocation';
        }
      }
      return null;
    },
    'actor/session-scoped genuine command evidence',
    180_000
  );
}
async function bundledRuntime(executable: string, manifestFile: string) {
  preproofStage = 'manifest_path';
  assert(
    manifestFile && path.isAbsolute(manifestFile),
    'Qualified bundled runtime manifest required'
  );
  preproofStage = 'manifest_stat';
  const stat = await lstat(manifestFile);
  preproofFacts.manifestBytes = stat.size;
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= BUNDLED_MANIFEST_MAX_BYTES);
  preproofStage = 'manifest_read';
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as {
    sdkSha: string;
    files: Record<string, string>;
  };
  preproofStage = 'manifest_schema';
  assert(
    /^[a-f0-9]{40}$/.test(manifest.sdkSha) &&
      manifest.files &&
      typeof manifest.files === 'object' &&
      !Array.isArray(manifest.files)
  );
  preproofStage = 'runtime_path';
  const base = path.join(path.dirname(await realpath(executable)), 'resources', 'runtime');
  assert.equal((await realpath(base)).toLowerCase(), base.toLowerCase());
  const entries = Object.entries(manifest.files);
  preproofStage = 'manifest_entries';
  preproofFacts.manifestEntries = entries.length;
  assert(
    entries.length > 0 &&
      entries.length <= BUNDLED_MANIFEST_MAX_ENTRIES &&
      manifest.files['COMMIT_SHA'] &&
      manifest.files['claude-multimodel.exe'],
    'Complete bundled executable provenance required'
  );
  const digests: Record<string, string> = {};
  preproofStage = 'runtime_hashes';
  for (const [relative, expected] of entries) {
    assert(
      relative &&
        !relative.includes('\\') &&
        relative.split('/').every((part) => part && part !== '.' && part !== '..') &&
        !path.isAbsolute(relative) &&
        !relative.includes(':')
    );
    assert(/^[a-f0-9]{64}$/.test(expected));
    const file = path.join(base, relative);
    const fileStat = await lstat(file);
    assert(fileStat.isFile() && !fileStat.isSymbolicLink());
    assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase());
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    const observed = hash.digest('hex');
    assert.equal(observed, expected, 'Bundled runtime byte mismatch');
    digests[relative] = observed;
  }
  preproofStage = 'runtime_commit';
  assert.equal((await readFile(path.join(base, 'COMMIT_SHA'), 'utf8')).trim(), manifest.sdkSha);
  return { bundledSdkSha: manifest.sdkSha, runtimeDigests: digests };
}
async function exactFile(project: string, name: string, expected?: string) {
  const file = path.join(project, name);
  const stat = await lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
  const bytes = await readFile(file);
  if (expected !== undefined) assert.equal(bytes.toString(), expected);
  return createHash('sha256').update(bytes).digest('hex');
}
async function stopped(app: App) {
  await app.call('stop');
  assert.equal(await app.call('processAlive'), false);
  const runtime = await app.call('getRuntime');
  assert(Object.values(runtime.members).every((member) => !member.alive));
}

async function main() {
  assert.equal(process.platform, 'win32');
  const [executable, sdk, binary, model, authFile, mode] = process.argv.slice(2);
  assert(mode === undefined || mode === '--short', 'Unknown Windows proof mode');
  const short = mode === '--short';
  const members = short ? ['alice'] : ['alice', 'bob'];
  assert(
    executable && sdk && binary && model && authFile && process.argv.length === (short ? 8 : 7)
  );
  for (const file of [executable, binary, authFile]) assert(path.isAbsolute(file));
  assert(sdk === 'bundled' || path.isAbsolute(sdk));
  assert(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./:-]+$/.test(model));
  preproofStage = 'desktop_prepare';
  const desktop = await prepareNativeDesktop();
  preproofStage = 'desktop_private_acl';
  await protectWindowsTestDirectory(desktop.root);
  preproofStage = 'selected_paths';
  if (sdk !== 'bundled') desktop.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH = await realpath(sdk);
  desktop.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = await realpath(binary);
  await seedSelectedAuth(
    authFile,
    model.split('/')[0],
    path.join(desktop.env.XDG_DATA_HOME!, 'opencode')
  );
  preproofStage = 'version_read';
  const measured = await execute(desktop.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH!, ['--version'], {
    env: desktop.env,
    cwd: desktop.root,
    timeout: 20_000,
    maxBuffer: 4096,
  });
  preproofStage = 'version_validate';
  const version = /^(?:opencode v)?(\d+\.\d+\.\d+)$/.exec(measured.stdout.trim())?.[1];
  assert(
    version && (/^1\./.test(version) || ['2.0.0', '2.0.21'].includes(version)),
    'Approved OpenCode version required'
  );
  const bundled =
    sdk === 'bundled'
      ? await bundledRuntime(
          executable,
          process.env.OPENCODE_NATIVE_EXPECTED_RUNTIME_MANIFEST ?? ''
        )
      : { bundledSdkSha: '', runtimeDigests: {} };
  const proofFile = path.join(desktop.root, 'proof.json');
  const proof = {
    scope: short ? 'Windows real packaged short task only' : 'Windows real packaged full team',
    status: 'running',
    stage: 'startup',
    teamName: desktop.teamName,
    model,
    version,
    sdkSelection: sdk === 'bundled' ? 'bundled without override' : 'explicit SDK override',
    ...bundled,
    commandEvidenceConfirmed: [] as { member: string; kind: string }[],
    runIds: [] as string[],
    taskIds: [] as string[],
    fileHashes: {} as Record<string, string>,
    peersConfirmed: false,
    heldStopConfirmed: false,
    persistenceConfirmed: false,
    heldAssignmentReleasedAfterPersistence: false,
    relaunchConfirmed: false,
    finalStopConfirmed: false,
    failure: null as ProofFailure | null,
    cleanupFailures: [] as ProofFailure[],
  };
  const checkpoint = async (stage: string) => {
    proof.stage = stage;
    await writeFile(proofFile, JSON.stringify(proof, null, 2));
  };
  preproofStage = 'proof_write';
  await checkpoint('startup');
  preproofStage = 'scenario';
  let app = await desktop.launch(executable);
  let teamActive = false;
  const heldProcesses: Identity[] = [];
  const closeApp = async () => {
    try {
      await app.close();
    } catch (error) {
      proof.status = 'failed';
      proof.cleanupFailures.push(proofFailure(error, 'app_cleanup'));
      await checkpoint('app-cleanup');
    }
    if (!proof.failure && proof.cleanupFailures.length)
      throw new Error('Windows native cleanup failed; preserve its TEST proof');
  };
  try {
    await checkpoint('scripts');
    const nonce = { alice: randomUUID(), bob: randomUUID(), new: randomUUID() };
    const base = `Work only inside ${desktop.projectPath}. Never delegate, install packages, detach processes or change host verification scripts. Use team tools for peer messages and task comments. When a peer sends CHALLENGE:<token>, reply to that sender ACK:<token> exactly. Never reply to ACK.`;
    const command = (name: string) => {
      const program = path.join(desktop.projectPath, name);
      assert(
        [...program].every((char) => char.charCodeAt(0) >= 32) && !/["%!^&<>|`$]/.test(program),
        'Literal Windows TEST command path required'
      );
      // JSON string escaping doubles backslashes in cmd/PowerShell arguments.
      return `node "${program}"`;
    };
    const checkSum = `const a=require('node:assert/strict');a.equal(process.platform,'win32');const sum=require('./sum.cjs');a.equal(sum([]),0);a.equal(sum([2,-5,7]),4);a.equal(sum([1.5,2.5]),4);a.equal(sum([-2,-3]),-5);for(const v of [null,[NaN],[Infinity],['1']])a.throws(()=>sum(v),TypeError);`;
    await writeFile(
      path.join(desktop.projectPath, 'alice-verify.cjs'),
      `const fs=require('node:fs');${checkSum}fs.writeFileSync('alice-result.txt',${JSON.stringify(nonce.alice + '\n')});console.log(${JSON.stringify('COMMAND_EXEC:' + nonce.alice)});`
    );
    await writeFile(
      path.join(desktop.projectPath, 'bob-verify.cjs'),
      `require('./sum.test.cjs');require('node:fs').writeFileSync('bob-result.txt',${JSON.stringify(nonce.bob + '\n')});console.log(${JSON.stringify('COMMAND_EXEC:' + nonce.bob)});`
    );
    await writeFile(
      path.join(desktop.projectPath, 'host-verify.cjs'),
      checkSum + `require('./sum.test.cjs');`
    );
    const verificationHashes = Object.fromEntries(
      await Promise.all(
        ['alice-verify.cjs', 'bob-verify.cjs', 'host-verify.cjs'].map(async (name) => [
          name,
          await exactFile(desktop.projectPath, name),
        ])
      )
    );
    const verifyScripts = async () => {
      for (const [name, hash] of Object.entries(verificationHashes))
        assert.equal(
          await exactFile(desktop.projectPath, name),
          hash,
          'Host verification program changed'
        );
    };
    await checkpoint('ready');
    await ready(app);
    await checkpoint('create_team');
    teamActive = true; // An uncertain admission is still ours to stop, never resubmit.
    const launch = await app.call('createTeam', {
      teamName: desktop.teamName,
      cwd: desktop.projectPath,
      providerId: 'opencode',
      model,
      skipPermissions: true,
      prompt: base + ' Wait for a board task.',
      members: members.map((name) => ({
        name,
        role: 'Developer',
        providerId: 'opencode',
        model,
      })),
    });
    proof.runIds.push(launch.runId);
    await checkpoint('provision');
    await provisioned(app, launch.runId);
    await checkpoint('runtime');
    const initial = await app.call('getRuntime');
    assert.equal(initial.runId, launch.runId);
    const sessions = members.map((name) => {
      const member = initial.members[name];
      assert(member?.alive && member.runtimeModel === model && member.runtimeSessionId);
      return member.runtimeSessionId;
    });
    assert.equal(new Set(sessions).size, members.length);
    await checkpoint('tasks');
    const alice = await app.call('createTask', {
      subject: 'Implement and verify sum',
      owner: 'alice',
      startImmediately: true,
      prompt: `${base}\nOwn only sum.cjs and alice-result.txt. Export sum(array) as module.exports; accept only an array of finite numbers, throw TypeError otherwise. Read alice-verify.cjs, create sum.cjs, then run ${command('alice-verify.cjs')}. ${short ? '' : `Send bob CHALLENGE:${nonce.alice} with agent-teams_message_send.`} Before task_complete add task_add_comment from alice text TASK_COMMENT:${nonce.alice}. Complete only after successful command.`,
    });
    proof.taskIds.push(alice.id);
    await completed(app, alice.id, 'alice', `TASK_COMMENT:${nonce.alice}`);
    const aliceCommandEvidence = await commandEvidence(
      app,
      alice.id,
      'alice',
      sessions[0],
      path.join(desktop.projectPath, 'alice-verify.cjs'),
      'COMMAND_EXEC:' + nonce.alice,
      version,
      model
    );
    proof.commandEvidenceConfirmed.push({ member: 'alice', kind: aliceCommandEvidence });
    if (short) {
      proof.fileHashes['alice-result.txt'] = await exactFile(
        desktop.projectPath,
        'alice-result.txt',
        nonce.alice + '\n'
      );
      proof.fileHashes['sum.cjs'] = await exactFile(desktop.projectPath, 'sum.cjs');
      await verifyScripts();
      const verifier = path.join(desktop.projectPath, 'host-short-verify.cjs');
      await writeFile(verifier, checkSum);
      await execute(process.execPath, [verifier], {
        cwd: desktop.projectPath,
        env: desktop.env,
        timeout: 20_000,
        maxBuffer: 16_384,
      });
      await stopped(app);
      teamActive = false;
      await app.close();
      if (sdk === 'bundled')
        assert.deepEqual(
          await bundledRuntime(
            executable,
            process.env.OPENCODE_NATIVE_EXPECTED_RUNTIME_MANIFEST ?? ''
          ),
          bundled
        );
      proof.finalStopConfirmed = true;
      proof.status = 'passed';
      await checkpoint('short-complete');
      console.log(`Windows short proof: ${proofFile}`);
      return;
    }
    const bob = await app.call('createTask', {
      subject: 'Independently test sum',
      owner: 'bob',
      startImmediately: true,
      prompt: `${base}\nOwn only sum.test.cjs and bob-result.txt. Read sum.cjs, do not modify it. Write sum.test.cjs using node:assert/strict, covering []=>0,[2,-5,7]=>4,[1.5,2.5]=>4,[-2,-3]=>-5 and TypeError for null,[NaN],[Infinity],['1']. Run ${command('bob-verify.cjs')}. Send alice CHALLENGE:${nonce.bob} with agent-teams_message_send. Before task_complete add task_add_comment from bob text TASK_COMMENT:${nonce.bob}. Complete only after successful command.`,
    });
    proof.taskIds.push(bob.id);
    await completed(app, bob.id, 'bob', `TASK_COMMENT:${nonce.bob}`);
    const bobCommandEvidence = await commandEvidence(
      app,
      bob.id,
      'bob',
      sessions[1],
      path.join(desktop.projectPath, 'bob-verify.cjs'),
      'COMMAND_EXEC:' + nonce.bob,
      version,
      model
    );
    proof.commandEvidenceConfirmed.push({ member: 'bob', kind: bobCommandEvidence });
    for (const name of ['alice', 'bob'] as const)
      proof.fileHashes[`${name}-result.txt`] = await exactFile(
        desktop.projectPath,
        `${name}-result.txt`,
        nonce[name] + '\n'
      );
    for (const name of ['sum.cjs', 'sum.test.cjs'])
      proof.fileHashes[name] = await exactFile(desktop.projectPath, name);
    await verifyScripts();
    await execute(process.execPath, [path.join(desktop.projectPath, 'host-verify.cjs')], {
      cwd: desktop.projectPath,
      env: desktop.env,
      timeout: 20_000,
      maxBuffer: 16_384,
    });
    // Read the real paginated message API, never construct peer messages on behalf of agents.
    await waitFor(
      async () => {
        let cursor: string | undefined;
        const rows: { from: string; to?: string; text: string }[] = [];
        const seen = new Set<string>();
        for (let page = 0; page < 20; page++) {
          const result = await app.call('getMessagesPage', { cursor, limit: 100 });
          rows.push(...result.messages);
          if (!result.hasMore) break;
          assert(result.nextCursor && !seen.has(result.nextCursor), 'Invalid message pagination');
          seen.add(result.nextCursor);
          cursor = result.nextCursor;
          assert(page < 19, 'Message proof truncated');
        }
        return [
          ['alice', 'bob', `CHALLENGE:${nonce.alice}`],
          ['bob', 'alice', `ACK:${nonce.alice}`],
          ['bob', 'alice', `CHALLENGE:${nonce.bob}`],
          ['alice', 'bob', `ACK:${nonce.bob}`],
        ].every(([from, to, text]) =>
          rows.some((row) => row.from === from && row.to === to && row.text === text)
        )
          ? true
          : null;
      },
      'actual peer challenge and acknowledgements',
      240_000
    );
    proof.peersConfirmed = true;
    const hold = async (label: string) => {
      const token = randomUUID();
      const name = `held-${label}.cjs`;
      const marker = path.join(desktop.projectPath, `held-${label}.json`);
      const program = path.join(desktop.projectPath, name);
      const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker + '.tmp')},JSON.stringify({pid:process.pid,nonce:${JSON.stringify(token)}}));fs.renameSync(${JSON.stringify(marker + '.tmp')},${JSON.stringify(marker)});setInterval(()=>{},1000);`;
      await writeFile(program, script);
      const task = await app.call('createTask', {
        subject: 'Hold owned foreground command',
        owner: 'alice',
        startImmediately: true,
        prompt: `${base}\nRun ${command(name)} in foreground with timeout 660000ms. Do not edit the script, detach, delegate or complete this task. The host stops this team.`,
      });
      proof.taskIds.push(task.id);
      const started = await waitFor(
        async () => {
          try {
            return JSON.parse(await readFile(marker, 'utf8')) as { pid: number; nonce: string };
          } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
              return null;
            throw error;
          }
        },
        'held actual native command',
        300_000
      );
      assert.equal(started.nonce, token);
      const original = await identity(started.pid);
      assert(
        original &&
          path.basename(original.executable).toLowerCase() === 'node.exe' &&
          original.command.includes(program),
        'Held process must be our exact TEST Node program'
      );
      heldProcesses.push(original);
      assert.equal(await readFile(program, 'utf8'), script);
      assert.equal((await app.call('getTask', task.id))?.status, 'in_progress');
      assert(same(await identity(original.pid), original), 'Held process gone before stop');
      await stopped(app);
      teamActive = false;
      await waitFor(
        async () => {
          const observed = await identity(original.pid);
          return !observed || observed.birth !== original.birth ? true : null;
        },
        'physical owned process retirement',
        20_000
      );
      const retained = await app.call('getTask', task.id);
      assert(retained && ['pending', 'in_progress'].includes(retained.status));
      return { task, marker, markerBytes: await readFile(marker, 'utf8') };
    };
    await checkpoint('held-stop');
    const held = await hold('initial');
    proof.heldStopConfirmed = true;
    await app.close();
    assert(/^[a-zA-Z0-9_-]+$/.test(held.task.id));
    const retainedPath = path.join(
      desktop.env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT!,
      'tasks',
      desktop.teamName,
      held.task.id + '.json'
    );
    const retained = JSON.parse(await readFile(retainedPath, 'utf8')) as {
      id: string;
      owner: string | null;
      status: string;
    };
    assert.equal(retained.id, held.task.id);
    app = await desktop.launch(executable);
    await ready(app);
    assert.equal(await app.call('processAlive'), false);
    assert(Object.values((await app.call('getRuntime')).members).every((member) => !member.alive));
    const loaded = (await app.call('getData')).tasks.find((task) => task.id === held.task.id);
    assert(loaded && loaded.owner === retained.owner && loaded.status === retained.status);
    assert.deepEqual(JSON.parse(await readFile(retainedPath, 'utf8')), retained);
    assert.equal(await readFile(held.marker, 'utf8'), held.markerBytes);
    proof.persistenceConfirmed = true;
    await checkpoint('restart-persistence');
    // Only after unchanged-owner persistence is proved, deliberately release
    // this forever-held TEST assignment before asking for a fresh team run.
    await app.call('updateTaskOwner', held.task.id, null);
    proof.heldAssignmentReleasedAfterPersistence = true;
    await checkpoint('relaunch');
    teamActive = true;
    const relaunch = await app.call('launchTeam', {
      teamName: desktop.teamName,
      cwd: desktop.projectPath,
      providerId: 'opencode',
      model,
      skipPermissions: true,
    });
    assert.notEqual(relaunch.runId, launch.runId);
    proof.runIds.push(relaunch.runId);
    await provisioned(app, relaunch.runId);
    const fresh = await app.call('getRuntime');
    assert.equal(fresh.runId, relaunch.runId);
    const newSessions = ['alice', 'bob'].map((name) => {
      const member = fresh.members[name];
      assert(
        member?.alive &&
          member.runtimeModel === model &&
          member.runtimeSessionId &&
          !sessions.includes(member.runtimeSessionId)
      );
      return member.runtimeSessionId;
    });
    assert.equal(new Set(newSessions).size, 2);
    await writeFile(
      path.join(desktop.projectPath, 'new-verify.cjs'),
      `require('node:assert/strict').equal(process.platform,'win32');require('node:fs').writeFileSync('new-result.txt',${JSON.stringify(nonce.new + '\n')});console.log(${JSON.stringify('COMMAND_EXEC:' + nonce.new)});`
    );
    verificationHashes['new-verify.cjs'] = await exactFile(desktop.projectPath, 'new-verify.cjs');
    const task = await app.call('createTask', {
      subject: 'Verify fresh run after restart',
      owner: 'alice',
      startImmediately: true,
      prompt: `${base}\nRun ${command('new-verify.cjs')}. Add task_add_comment from alice text TASK_COMMENT:${nonce.new}, then task_complete after successful command.`,
    });
    proof.taskIds.push(task.id);
    await completed(app, task.id, 'alice', `TASK_COMMENT:${nonce.new}`);
    const freshCommandEvidence = await commandEvidence(
      app,
      task.id,
      'alice',
      newSessions[0],
      path.join(desktop.projectPath, 'new-verify.cjs'),
      'COMMAND_EXEC:' + nonce.new,
      version,
      model
    );
    proof.commandEvidenceConfirmed.push({ member: 'alice-fresh', kind: freshCommandEvidence });
    proof.fileHashes['new-result.txt'] = await exactFile(
      desktop.projectPath,
      'new-result.txt',
      nonce.new + '\n'
    );
    proof.relaunchConfirmed = true;
    await checkpoint('final-stop');
    await hold('final');
    proof.finalStopConfirmed = true;
    assert.equal(
      await readFile(held.marker, 'utf8'),
      held.markerBytes,
      'Old stopped input replayed'
    );
    for (const name of ['alice', 'bob'] as const)
      await exactFile(desktop.projectPath, `${name}-result.txt`, nonce[name] + '\n');
    await verifyScripts();
    if (sdk === 'bundled')
      assert.deepEqual(
        await bundledRuntime(
          executable,
          process.env.OPENCODE_NATIVE_EXPECTED_RUNTIME_MANIFEST ?? ''
        ),
        bundled
      );
  } catch (error: unknown) {
    proof.status = 'failed';
    proof.failure ??= proofFailure(error, proof.stage);
    await checkpoint(proof.stage);
    throw new Error(
      'Windows full task qualification failed; preserve its TEST proof and auth custody'
    );
  } finally {
    try {
      if (teamActive) {
        try {
          await stopped(app);
        } catch (error: unknown) {
          proof.status = 'failed';
          proof.cleanupFailures.push(proofFailure(error, 'team_stop'));
          await checkpoint(proof.stage);
        }
      }
    } finally {
      try {
        for (const original of heldProcesses) {
          const observed = await identity(original.pid);
          assert(
            !observed || observed.birth !== original.birth,
            'Owned held process survived normal stop; retain failed TEST state'
          );
        }
      } catch (error: unknown) {
        proof.status = 'failed';
        proof.cleanupFailures.push(proofFailure(error, 'held_process_cleanup'));
        await checkpoint(proof.stage);
      } finally {
        await closeApp();
      }
    }
  }
  proof.status = 'passed';
  await checkpoint('complete');
  console.log(`Windows full proof: ${proofFile}`);
}
void main().catch((error: unknown) => {
  let errno = 'none';
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^E[A-Z0-9_]{1,48}$/.test(error.code)
  )
    errno = error.code;
  console.error(
    'Windows full qualification failed; preserve TEST state',
    JSON.stringify({ stage: preproofStage, errno, ...preproofFacts })
  );
  process.exitCode = 1;
});
