/** Short native Unix Electron integration. Full V2 tool/message/lifecycle proof is
 * reused separately by source impact, never inferred from this smoke.
 * pnpm exec tsx scripts/e2e/opencode-native-desktop-smoke.ts <app executable>
 *   <SDK cli or bundled> <pinned OpenCode binary> <model> <explicit local auth file>
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { prepareNativeDesktop } from './opencode-native-desktop-host';
import { waitFor } from './release-updater/cdp.mts';

async function main() {
  assert(
    ['darwin', 'linux'].includes(process.platform),
    'Windows requires its full native scenario'
  );
  const [executable, sdk, binary, model, authFile, stopProbe] = process.argv.slice(2);
  assert(stopProbe === undefined || stopProbe === '--held-stop', 'Unknown smoke option');
  assert(executable && sdk && binary && model && authFile, 'Explicit test inputs required');
  assert(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./:-]+$/.test(model), 'Explicit provider/model required');
  for (const file of [executable, binary, authFile]) assert(path.isAbsolute(file));
  assert(
    sdk === 'bundled' || path.isAbsolute(sdk),
    'Explicit SDK path or bundled selection required'
  );
  const desktop = await prepareNativeDesktop();
  const commandNode = await realpath(process.execPath);
  await access(commandNode, constants.X_OK);
  const quotedNode = "'" + commandNode.replaceAll("'", "'\\''") + "'";
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  if (sdk !== 'bundled') {
    desktop.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH = await realpath(sdk);
  }
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
    scope: `${process.platform} short integration only`,
    status: 'running',
    stage: 'launch',
    failure: '',
    teamName: desktop.teamName,
    projectPath: desktop.projectPath,
    model,
    sdkSelection: sdk === 'bundled' ? 'bundled without override' : 'explicit SDK override',
    runId: '',
    taskId: '',
    taskCompleted: false,
    independentFile: false,
    apiStopped: false,
    heldStopRequested: stopProbe === '--held-stop',
    heldStopConfirmed: false,
    restartPersistenceConfirmed: false,
  };
  const checkpoint = () =>
    writeFile(proofFile, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
  await checkpoint();
  let app: Awaited<ReturnType<typeof desktop.launch>>;
  try {
    app = await desktop.launch(executable);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const known = [
      'Owned Electron exited',
      'Owned Electron spawn failed',
      'Foreign inspector listener',
      'Inspector must bind IPv4 loopback',
      'normal preload API',
      'owned packaged Electron renderer',
    ];
    proof.status = 'failed';
    proof.failure =
      known.find((reason) => message.includes(reason)) ?? 'unclassified app launch failure';
    await checkpoint();
    throw new Error(
      `Short Electron integration failed before provider submission: ${proof.failure}`
    );
  }
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
    const code = `const a=require('node:assert/strict');a.equal(process.platform,${JSON.stringify(process.platform)});require('node:fs').writeFileSync('electron-result.txt',${JSON.stringify(nonce + '\n')});`;
    const taskCommand =
      process.platform === 'linux'
        ? `/bin/sh -c ${quote(`test "$(/usr/bin/uname -s)" = Linux && printf '%s\\n' ${quote(nonce)} > electron-result.txt`)}`
        : `${quotedNode} -e ${JSON.stringify(code)}`;
    proof.stage = 'task';
    await checkpoint();
    const task = await app.call('createTask', {
      subject: 'Verify a native command through Electron',
      owner: 'alice',
      startImmediately: true,
      prompt: `Run this command exactly: ${taskCommand}\nThen complete this board task with the team task_complete tool. Do not edit other files.`,
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
      const program = path.join(
        desktop.projectPath,
        process.platform === 'linux' ? 'held-command.sh' : 'held-command.cjs'
      );
      const marker = path.join(desktop.projectPath, 'held-started.json');
      const temporary = marker + '.tmp';
      const script =
        process.platform === 'linux'
          ? `printf '{"pid":%s,"nonce":"${nonce}"}' "$$" > ${quote(temporary)}\n/bin/mv ${quote(temporary)} ${quote(marker)}\nwhile :; do /bin/sleep 1; done\n`
          : `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(temporary)},JSON.stringify({pid:process.pid,nonce:${JSON.stringify(nonce)}}));fs.renameSync(${JSON.stringify(temporary)},${JSON.stringify(marker)});setInterval(()=>{},1000);\n`;
      await writeFile(program, script, { mode: 0o600 });
      const held = await app.call('createTask', {
        subject: 'Hold a native command until team stop',
        owner: 'alice',
        startImmediately: true,
        prompt: `Run ${process.platform === 'linux' ? '/bin/sh' : quotedNode} ${quote(program)} in the foreground. Do not edit it, delegate, detach or complete this task. The test host will stop the team.`,
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
      const hostPid =
        process.platform === 'linux' ? await linuxHeldHostPid(program, started.pid) : started.pid;
      const identity = await processIdentity(hostPid);
      assert(identity && identity.includes(program), 'Held PID is not the TEST command');
      heldProcess = { pid: hostPid, identity, taskId: held.id };
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
    if (heldProcess) {
      proof.stage = 'restart-persistence';
      await checkpoint();
      assert(/^[a-zA-Z0-9_-]+$/.test(heldProcess.taskId), 'Safe owned task ID required');
      const retainedPath = path.join(
        desktop.env.AGENT_TEAMS_ELECTRON_CLAUDE_ROOT!,
        'tasks',
        desktop.teamName,
        `${heldProcess.taskId}.json`
      );
      await app.close();
      // Capture after shutdown has settled activity intervals, not before it.
      const retainedStat = await lstat(retainedPath);
      assert(retainedStat.isFile() && !retainedStat.isSymbolicLink() && retainedStat.nlink === 1);
      const before = JSON.parse(await readFile(retainedPath, 'utf8')) as {
        id: string;
        owner?: string;
        status: string;
      };
      assert.equal(before.id, heldProcess.taskId);
      assert(['pending', 'in_progress'].includes(before.status));
      const markerPath = path.join(desktop.projectPath, 'held-started.json');
      const markerBefore = await readFile(markerPath, 'utf8');
      app = await desktop.launch(executable);
      await waitFor(
        async () => {
          const startup = await app.call('getStartupStatus');
          assert(!startup.error, 'Owned application restart failed');
          return startup.ready ? true : null;
        },
        'owned app restart ready',
        180_000
      );
      assert.equal(
        await app.call('processAlive'),
        false,
        'Restart must not auto-launch stopped team'
      );
      const restored = await app.call('getRuntime');
      assert(Object.values(restored.members).every((member) => !member.alive));
      const data = await app.call('getData');
      const restoredTask = data.tasks.find((task) => task.id === heldProcess!.taskId);
      assert(restoredTask, 'Restarted app must read the retained task');
      assert.equal(restoredTask.owner, before.owner);
      assert.equal(restoredTask.status, before.status);
      assert.deepEqual(JSON.parse(await readFile(retainedPath, 'utf8')), before);
      assert.equal(await readFile(markerPath, 'utf8'), markerBefore, 'Stopped input replayed');
      assert.equal(await readFile(result, 'utf8'), nonce + '\n');
      proof.restartPersistenceConfirmed = true;
    }
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

async function linuxHeldHostPid(program: string, namespacePid: number): Promise<number> {
  const matches: number[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const args = (await readFile(`/proc/${entry}/cmdline`, 'utf8')).split('\0');
      if (!args.includes(program)) continue;
      const status = await readFile(`/proc/${entry}/status`, 'utf8');
      const ids = /^NSpid:\s+(.+)$/m.exec(status)?.[1].trim().split(/\s+/).map(Number);
      if (ids?.at(-1) === namespacePid && ids[0] === Number(entry)) matches.push(Number(entry));
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error;
    }
  }
  assert.equal(matches.length, 1, 'Exactly one owned held command must match its namespace PID');
  return matches[0];
}

async function processIdentity(pid: number): Promise<string | null> {
  try {
    if (process.platform === 'linux') {
      const birth = async () => {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      };
      const before = await birth();
      assert(before && /^\d+$/.test(before), 'Held Linux process birth required');
      const command = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ');
      if ((await birth()) !== before) return null;
      return `${before} ${command}`;
    }
    const { stdout } = await promisify(execFile)(
      '/bin/ps',
      ['-p', String(pid), '-o', 'lstart=', '-o', 'command='],
      { timeout: 2000, maxBuffer: 4096 }
    );
    return stdout.trim() || null;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return null;
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
