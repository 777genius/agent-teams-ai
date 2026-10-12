/** Short Darwin Electron integration. Full V2 tool/message/lifecycle proof is
 * reused separately by source impact, never inferred from this smoke.
 * pnpm exec tsx scripts/e2e/opencode-native-desktop-smoke.ts <app executable>
 *   <built SDK cli> <pinned OpenCode binary> <model> <explicit local auth file>
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { prepareNativeDesktop } from './opencode-native-desktop-host';
import { waitFor } from './release-updater/cdp.mts';

async function main() {
  assert.equal(process.platform, 'darwin', 'Windows requires its full native scenario');
  const [executable, sdk, binary, model, authFile] = process.argv.slice(2);
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
    teamName: desktop.teamName,
    projectPath: desktop.projectPath,
    model,
    runId: '',
    taskId: '',
    taskCompleted: false,
    independentFile: false,
    apiStopped: false,
  };
  const checkpoint = () =>
    writeFile(proofFile, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
  await checkpoint();
  const app = await desktop.launch(executable);
  let submitted = false;
  try {
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
    await app.call('stop');
    assert.equal(await app.call('processAlive'), false);
    const stopped = await app.call('getRuntime');
    assert(Object.values(stopped.members).every((member) => !member.alive));
    proof.apiStopped = true;
    proof.status = 'passed';
    await checkpoint();
    console.log(`Short Electron integration proof: ${proofFile}`);
  } catch {
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
      await app.close();
    }
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
