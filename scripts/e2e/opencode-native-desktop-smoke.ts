/** Short Darwin Electron integration. Full V2 tool/message/lifecycle proof is
 * reused separately by source impact, never inferred from this smoke.
 * pnpm exec tsx scripts/e2e/opencode-native-desktop-smoke.ts <app executable>
 *   <built SDK cli> <pinned OpenCode binary> <model> <explicit local auth file>
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { prepareNativeDesktop } from './opencode-native-desktop-host';
import { waitFor } from './release-updater/cdp.mts';

async function main() {
  assert.equal(process.platform, 'darwin', 'Windows requires its full native scenario');
  const [executable, sdk, binary, model, authFile, stopProbe] = process.argv.slice(2);
  assert(stopProbe === undefined || stopProbe === '--held-stop', 'Unknown smoke option');
  assert(executable && sdk && binary && model && authFile, 'Explicit test inputs required');
  assert(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./:-]+$/.test(model), 'Explicit provider/model required');
  for (const file of [executable, sdk, binary, authFile]) assert(path.isAbsolute(file));
  const desktop = await prepareNativeDesktop();
  desktop.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH = await realpath(sdk);
  desktop.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH = await realpath(binary);
  // Only the explicitly selected provider enters this fresh local TEST profile.
  // Preserve it after the run: OAuth may have refreshed during execution.
  const provider = model.slice(0, model.indexOf('/'));
  let selected: unknown;
  try {
    const store = JSON.parse(await readFile(authFile, 'utf8')) as Record<string, unknown>;
    selected = store[provider];
    assert(selected && typeof selected === 'object' && !Array.isArray(selected));
    const record = selected as Record<string, unknown>;
    const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
    assert(
      (record.type === 'api' && text(record.key)) ||
        (record.type === 'oauth' && (text(record.access) || text(record.refresh)))
    );
  } catch {
    throw new Error('Explicit local selected-provider auth is invalid');
  }
  const authDirectory = path.join(desktop.env.XDG_DATA_HOME!, 'opencode');
  await mkdir(authDirectory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(authDirectory, 'auth.json'), JSON.stringify({ [provider]: selected }), {
    mode: 0o600,
  });
  const proofFile = path.join(desktop.root, 'proof.json');
  const proof = {
    boundary: 'packaged Electron renderer -> normal preload -> real OpenCode task',
    scope: 'Darwin short integration only',
    status: 'running',
    stage: 'launch',
    failure: '',
    teamName: desktop.teamName,
    projectPath: desktop.projectPath,
    model,
    runId: '',
    taskId: '',
    taskCompleted: false,
    independentFile: false,
    apiStopped: false,
    heldStopRequested: stopProbe === '--held-stop',
    heldStopConfirmed: false,
  };
  const checkpoint = () =>
    writeFile(proofFile, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
  await checkpoint();
  const app = await desktop.launch(executable);
  let submitted = false;
  let heldProcess: { pid: number; identity: string; taskId: string } | undefined;
  try {
    proof.stage = 'app-ready';
    await checkpoint();
    await waitFor(
      async () => {
        const startup = await app.call('getStartupStatus');
        assert(!startup.error, 'Owned application startup failed');
        return startup.ready ? true : null;
      },
      'normal packaged application startup',
      180_000
    );
    proof.stage = 'createTeam';
    await checkpoint();
    submitted = true;
    const launch = await app.call('createTeam', {
      teamName: desktop.teamName,
      cwd: desktop.projectPath,
      providerId: 'opencode',
      model,
      skipPermissions: true,
      members: [{ name: 'alice', role: 'Developer', providerId: 'opencode', model }],
      prompt:
        'Work only in this disposable TEST project. Do not install packages or delegate. Wait for a board task.',
    });
    proof.runId = launch.runId;
    proof.stage = 'provisioning';
    await checkpoint();
    await waitFor(
      async () => {
        const progress = await app.progress();
        const latest = progress.at(-1);
        assert(latest?.state !== 'failed', 'Owned provisioning failed');
        return latest?.state === 'ready' ? true : null;
      },
      'owned OpenCode provisioning',
      180_000
    );
    const runtime = await app.call('getRuntime');
    assert.equal(runtime.runId, launch.runId);
    assert.equal(runtime.members.alice?.runtimeModel, model);
    assert.equal(runtime.members.alice?.alive, true);
    const nonce = randomUUID();
    const code = `const a=require('node:assert/strict');a.equal(process.platform,'darwin');require('node:fs').writeFileSync('electron-result.txt',${JSON.stringify(nonce + '\n')});`;
    proof.stage = 'task';
    await checkpoint();
    const task = await app.call('createTask', {
      subject: 'Verify a native command through Electron',
      owner: 'alice',
      startImmediately: true,
      prompt: `Run this command exactly: node -e ${JSON.stringify(code)}\nThen complete this board task with the team task_complete tool. Do not edit other files.`,
    });
    proof.taskId = task.id;
    await checkpoint();
    await waitFor(
      async () => ((await app.call('getTask', task.id))?.status === 'completed' ? true : null),
      'real Electron task completion',
      180_000
    );
    proof.taskCompleted = true;
    const result = path.join(desktop.projectPath, 'electron-result.txt');
    const stat = await lstat(result);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    assert.equal(await readFile(result, 'utf8'), nonce + '\n');
    proof.independentFile = true;
    if (stopProbe === '--held-stop') {
      const program = path.join(desktop.projectPath, 'held-command.cjs');
      const marker = path.join(desktop.projectPath, 'held-started.json');
      const temporary = marker + '.tmp';
      const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(temporary)},JSON.stringify({pid:process.pid,nonce:${JSON.stringify(nonce)}}));fs.renameSync(${JSON.stringify(temporary)},${JSON.stringify(marker)});setInterval(()=>{},1000);\n`;
      await writeFile(program, script, { mode: 0o600 });
      const held = await app.call('createTask', {
        subject: 'Hold a native command until team stop',
        owner: 'alice',
        startImmediately: true,
        prompt: `Run node ${JSON.stringify(program)} in the foreground. Do not edit it, delegate, detach or complete this task. The test host will stop the team.`,
      });
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
        'held native command started',
        180_000
      );
      assert.equal(started.nonce, nonce);
      assert(Number.isSafeInteger(started.pid) && started.pid > 1);
      const identity = await processIdentity(started.pid);
      assert(identity && identity.includes(program), 'Held PID is not the TEST command');
      heldProcess = { pid: started.pid, identity, taskId: held.id };
      const activeTask = await app.call('getTask', held.id);
      assert(activeTask && activeTask.status === 'in_progress');
      assert.equal(await readFile(program, 'utf8'), script);
    }
    if (heldProcess) {
      assert.equal(
        await processIdentity(heldProcess.pid),
        heldProcess.identity,
        'Held command must still be active immediately before stop'
      );
    }
    await app.call('stop');
    assert.equal(await app.call('processAlive'), false);
    const stopped = await app.call('getRuntime');
    assert(Object.values(stopped.members).every((member) => !member.alive));
    if (heldProcess) {
      await waitFor(
        async () =>
          (await processIdentity(heldProcess!.pid)) !== heldProcess!.identity ? true : null,
        'original held command physically retired',
        20_000
      );
      proof.heldStopConfirmed = true;
      const retainedTask = await app.call('getTask', heldProcess.taskId);
      assert(
        retainedTask && ['pending', 'in_progress'].includes(retainedTask.status),
        'Stopped task must remain unfinished and retained'
      );
    }
    assert.equal(await readFile(result, 'utf8'), nonce + '\n');
    proof.apiStopped = true;
    proof.status = 'passed';
    await checkpoint();
    console.log(`Short Electron integration proof: ${proofFile}`);
  } catch (error) {
    proof.failure =
      error instanceof Error &&
      /^Owned (createTeam|createTask|stop) IPC failed \([a-zA-Z0-9 _-]+\); preserve TEST state$/.test(
        error.message
      )
        ? error.message
        : 'scenario assertion or transport failure';
    proof.status = 'failed';
    await checkpoint();
    throw new Error(`Short Electron integration failed; retained TEST proof: ${proofFile}`);
  } finally {
    try {
      if (submitted && !proof.apiStopped) {
        await app.call('stop');
        assert.equal(await app.call('processAlive'), false);
      }
    } finally {
      try {
        // A failed stop stays failed. Retire only this independently identified
        // TEST command so failure cannot leave our foreground probe running.
        if (heldProcess && (await processIdentity(heldProcess.pid)) === heldProcess.identity) {
          process.kill(heldProcess.pid, 'SIGTERM');
        }
      } finally {
        await app.close();
      }
    }
  }
}

async function processIdentity(pid: number): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)(
      '/bin/ps',
      ['-p', String(pid), '-o', 'lstart=', '-o', 'command='],
      { timeout: 2000, maxBuffer: 4096 }
    );
    return stdout.trim() || null;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 1) return null;
    throw error;
  }
}

void main().catch((error) => {
  // Errors before the sanitized scenario boundary can contain credential paths.
  console.error(
    error instanceof Error && error.message.startsWith('Short Electron integration')
      ? error.message
      : 'Native Electron smoke failed; preserve its TEST state'
  );
  process.exitCode = 1;
});
