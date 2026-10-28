// Actual app team/admission proof. Only the model HTTP boundary is scripted.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { boundedDiagnosticString } from '../../src/shared/utils/diagnosticsRedaction';

import type {
  ExtensionContext,
  ManagementChange,
  ManagementEnvironment,
  ManagementOperation,
  ManagementPlan,
  SkillCandidates,
  SkillCopyCandidate,
} from '../../src/features/extension-management/contracts';
import type {
  TeamAgentRuntimeSnapshot,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamProvisioningProgress,
} from '../../src/shared/types/team';
import type { DesktopCdp, UiWait } from './uap-management-ui';

const refusal = 'Stop the active run using this agent profile before changing its extensions.';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const run = promisify(execFile);

// Fixed source and protocol argument values, including every request and identifier.
const RENDERER = `async function(operation, data) {
  const api = window.electronAPI;
  if (operation === 'management') {
    const allowed = ['capture','environment','discoverSkills','skillCopySources','prepare','apply','operation','discardPlan'];
    if (!allowed.includes(data[0])) throw new Error('Unknown management fixture method');
    try { return {ok:true, value:await api.extensionManagement[data[0]](data[1])}; }
    catch (error) { return {ok:false, error:String(error)}; }
  }
  if (operation === 'register-project') return api.config.addCustomProjectPath(data[0]);
  if (operation === 'launch') {
    if (window.__uapActiveRunLaunch) throw new Error('Do not repeat uncertain team creation');
    window.__uapActiveRunLaunch = {done:false};
    api.teams.createTeam(data[0]).then(value => {
      window.__uapActiveRunLaunch = {done:true,value};
    }, error => { window.__uapActiveRunLaunch = {done:true,error:String(error)}; });
    return true;
  }
  if (operation === 'launch-result') return window.__uapActiveRunLaunch;
  if (operation === 'runtime') return api.teams.getTeamAgentRuntime(data[0]);
  if (operation === 'progress') return api.teams.getProvisioningStatus(data[0]);
  if (operation === 'saved') return api.teams.getSavedRequest(data[0]);
  if (operation === 'alive') return api.teams.processAlive(data[0]);
  if (operation === 'stop') {
    if (window.__uapActiveRunStop) return true;
    window.__uapActiveRunStop = {done:false};
    api.teams.stop(data[0]).then(() => { window.__uapActiveRunStop = {done:true}; },
      error => { window.__uapActiveRunStop = {done:true,error:String(error)}; });
    return true;
  }
  if (operation === 'stop-result') return window.__uapActiveRunStop;
  throw new Error('Unknown active-run fixture operation');
}`;

interface CdpResult<T> {
  result?: { objectId?: string; value?: T };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}
async function invoke<T>(cdp: DesktopCdp, operation: string, ...data: unknown[]): Promise<T> {
  const global = (await cdp.send('Runtime.evaluate', {
    expression: 'globalThis',
    returnByValue: false,
  })) as CdpResult<never>;
  const objectId = global.result?.objectId;
  assert(objectId, 'Owned renderer required');
  let completed = false;
  try {
    const result = (await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: RENDERER,
      arguments: [{ value: operation }, { value: data }],
      awaitPromise: true,
      returnByValue: true,
    })) as CdpResult<T>;
    assert(
      !result.exceptionDetails,
      result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text
    );
    completed = true;
    return result.result?.value as T;
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId }).catch((error) => {
      if (completed) throw error;
    });
  }
}
async function managed<T>(cdp: DesktopCdp, method: string, input: unknown): Promise<T> {
  const result = await invoke<{ ok: boolean; value?: T; error?: string }>(
    cdp,
    'management',
    method,
    input
  );
  assert(result.ok, result.error);
  return result.value as T;
}
async function snapshot(file: string): Promise<unknown> {
  const stat = await lstat(file).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return { link: await readlink(file) };
  if (stat.isFile()) return sha(await readFile(file));
  assert(stat.isDirectory(), 'Fixture inventory refuses special files');
  return Object.fromEntries(
    await Promise.all(
      (await readdir(file))
        .sort()
        .map(async (name) => [name, await snapshot(path.join(file, name))])
    )
  );
}

interface Fixture {
  root: string;
  env: NodeJS.ProcessEnv;
  source: string;
  pluginSource: string;
  claude: string;
  cdp: DesktopCdp;
  wait: UiWait;
  captureProcessMetadata(): Promise<Record<string, unknown>>;
  captureCliControl(): Promise<Record<string, unknown>>;
  advancePublisher(): void;
  assertUiRefusal(): Promise<void>;
  evidence: Record<string, unknown>;
}

export async function startActiveRunProof(f: Fixture) {
  const { cdp, wait } = f;
  const project = path.join(f.root, 'TEST-uap-active-profile');
  await mkdir(project);
  await writeFile(path.join(project, 'README.md'), '# Disposable active-profile qualification\n');
  await invoke(cdp, 'register-project', project);
  const context = await managed<ExtensionContext>(cdp, 'capture', {
    client: 'claude',
    scope: 'user',
  });
  const contextId = context.contextId;
  const acceptedPath = (requestId: string) =>
    path.join(
      f.env.AGENTPLUGINS_HOME!,
      'management',
      sha(context.session.environmentId),
      sha(requestId) + '.json'
    );
  const prepare = (change: ManagementChange) =>
    managed<ManagementPlan>(cdp, 'prepare', { contextId, change });
  const environment = () => managed<ManagementEnvironment>(cdp, 'environment', { contextId });
  const captureApplyFailure = async (operation: ManagementOperation) => {
    const diagnostic: Record<string, unknown> = { operation };
    f.evidence.activeProfileFailureDiagnostics = diagnostic;
    let processTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      diagnostic.ownedEngineProcesses = await Promise.race([
        f.captureProcessMetadata(),
        new Promise<Record<string, unknown>>((resolve) => {
          processTimer = setTimeout(
            () => resolve({ status: 'unavailable', code: 'PROCESS_METADATA_TIMEOUT' }),
            15_000
          );
        }),
      ]);
    } catch {
      diagnostic.ownedEngineProcesses = {
        status: 'unavailable',
        code: 'PROCESS_METADATA_CAPTURE_FAILED',
      };
    } finally {
      if (processTimer) clearTimeout(processTimer);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      diagnostic.environment = await Promise.race([
        environment(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Public environment inspection timed out')),
            15_000
          );
        }),
      ]);
    } catch (error) {
      diagnostic.environmentError = boundedDiagnosticString(String(error), 2048);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const probeFlags = {
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
    const native: Record<string, unknown> = {
      identity: 'SUPPLIED_ARTIFACT_NOT_MANAGEMENT_SELECTED_EXECUTABLE',
      suppliedExecutable: f.claude,
      args: ['plugin', 'list', '--json'],
      cwd: f.env.HOME,
      home: f.env.HOME,
      claudeConfigDir: f.env.CLAUDE_CONFIG_DIR,
      envFlags: probeFlags,
      timeoutMs: 15_000,
      maxBufferBytes: 128 * 1024,
    };
    diagnostic.nativeListing = native;
    try {
      assert(
        f.env.HOME && path.resolve(f.env.HOME) === path.join(f.root, 'home'),
        'Native diagnostic cwd must be the owned fixture HOME'
      );
      const result = await run(f.claude, ['plugin', 'list', '--json'], {
        cwd: f.env.HOME,
        env: { ...f.env, ...probeFlags },
        timeout: 15_000,
        killSignal: 'SIGKILL',
        maxBuffer: 128 * 1024,
        encoding: 'utf8',
      });
      native.exitCode = 0;
      native.stdout = boundedDiagnosticString(result.stdout, 32_768);
      native.stderr = boundedDiagnosticString(result.stderr, 32_768);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        signal?: string;
        killed?: boolean;
      };
      native.error = boundedDiagnosticString(String(error), 2048);
      native.code = failure.code;
      native.signal = failure.signal;
      native.killed = failure.killed;
      native.stdout = boundedDiagnosticString(failure.stdout, 32_768);
      native.stderr = boundedDiagnosticString(failure.stderr, 32_768);
    }
    try {
      diagnostic.freshProfileCliControl = await f.captureCliControl();
    } catch {
      diagnostic.freshProfileCliControl = {
        status: 'unavailable',
        code: 'FRESH_PROFILE_CLI_CONTROL_FAILED',
      };
    }
  };
  const apply = async (plan: ManagementPlan) => {
    assert(plan.confirmable && plan.actions.length, JSON.stringify(plan));
    let operation = await managed<ManagementOperation>(cdp, 'apply', {
      contextId,
      planId: plan.planId,
      requestId: randomUUID(),
    });
    operation = await wait(
      async () => {
        operation = await managed<ManagementOperation>(cdp, 'operation', {
          contextId,
          operationId: operation.operationId,
        });
        return ['queued', 'running'].includes(operation.state) ? null : operation;
      },
      `active-profile fixture ${plan.action}`,
      120_000
    );
    if (operation.state !== 'succeeded') await captureApplyFailure(operation);
    assert.equal(operation.state, 'succeeded', JSON.stringify(operation));
    assert.equal(operation.result?.mutated, true, 'Positive control must have actual effects');
    return operation;
  };
  const catalog = await managed<SkillCandidates>(cdp, 'discoverSkills', {
    contextId,
    source: { source: f.source },
  });
  const candidate = catalog.candidates.find(
    (item) => item.name === 'uap-ui-demo' && item.available
  );
  assert(candidate, 'The real publisher must expose the fixture Skill');
  const installation = await apply(
    await prepare({
      action: 'install_skills',
      catalogId: catalog.catalogId,
      candidateIds: [candidate.id],
      targetIds: ['claude'],
    })
  );
  const acceptedInstallation = JSON.parse(
    await readFile(acceptedPath(installation.requestId), 'utf8')
  );
  assert.equal(
    acceptedInstallation.operation.requestId,
    installation.requestId,
    'Positive accepted-ledger path control'
  );
  const entry = (await environment()).entries.find(
    (item) =>
      item.kind === 'skill' && item.bindings.some((binding) => binding.targetId === 'claude')
  );
  assert(entry?.declared);
  const packageRoot = entry.bindings
    .find((binding) => binding.targetId === 'claude')
    ?.managedPaths.find(
      (file) => path.dirname(file) === path.join(f.env.CLAUDE_CONFIG_DIR!, 'skills')
    );
  assert(
    packageRoot && packageRoot.startsWith(f.env.CLAUDE_CONFIG_DIR! + path.sep),
    'Inventoried Claude package root required'
  );
  const projected = path.join(packageRoot, '.agentplugins-runtime', 'skills', 'uap-ui-demo');
  const original = await readFile(path.join(projected, 'SKILL.md'));
  const binary = await readFile(path.join(projected, 'assets', 'sample.bin'));
  const copySources = await managed<SkillCopyCandidate[]>(cdp, 'skillCopySources', {
    contextId,
    alias: entry.alias,
    targetId: 'claude',
  });
  assert.equal(copySources.length, 1, 'The installed single-Skill Claude package has one source');
  const copySource = copySources[0];
  assert(copySource?.id.trim(), 'The ordinary preload API must return a candidate identity');
  assert.equal(copySource.sourceDir, await realpath(projected));
  assert.equal(copySource.skillName, 'uap-ui-demo');
  f.advancePublisher();
  const changes: ManagementChange[] = [
    {
      action: 'install',
      source: f.pluginSource,
      alias: 'uap-active-plugin',
      targetIds: ['claude'],
    },
    { action: 'update', aliases: [entry.alias] },
    { action: 'repair', aliases: [entry.alias] },
    { action: 'sync' },
    { action: 'remove', aliases: [entry.alias] },
  ];
  const plans: ManagementPlan[] = [];
  for (const change of changes) {
    const plan = await prepare(change);
    assert(plan.confirmable && plan.actions.length, JSON.stringify(plan));
    assert(
      plan.actions.every((action) => action.targetId === 'claude'),
      'Every retained plan must affect only the active Claude profile'
    );
    plans.push(plan);
  }
  const teamName = `test-uap-active-${randomUUID()}`;
  const request: TeamCreateRequest = {
    teamName,
    cwd: project,
    providerId: 'anthropic',
    model: 'claude-sonnet-4-6',
    skipPermissions: false,
    syncModelsWithLead: false,
    prompt:
      'Owned E2E. Stay idle. Do not edit files or create tasks. No E2E_DIRECTIVE will be sent.',
    members: [
      {
        name: 'worker',
        model: 'claude-sonnet-4-6',
        role: 'Idle qualification worker',
      },
    ],
  };
  const receipt: Record<string, unknown> = {
    boundary: 'actual_app_team_and_native_runtime_scripted_model',
    request,
    plans,
    installedClaudeCopySource: {
      origin: copySource.sourceDir,
      candidates: copySources,
      skillSHA256: sha(original),
      binarySHA256: sha(binary),
    },
    syncBoundary: 'valid_locked_restore_request_admission; healthy_binding_is_unchanged',
  };
  f.evidence.activeProfile = receipt;
  let launch: TeamCreateResponse | undefined;
  let stopped = false;
  const ownedProcesses = new Map<number, string>();
  const processStart = async (pid: number) => {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      return stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/)[19];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const persist = () =>
    writeFile(
      path.join(f.root, 'active-profile-evidence.json'),
      JSON.stringify(receipt, null, 2) + '\n'
    );
  const stop = async () => {
    if (stopped) return;
    await invoke(cdp, 'stop', teamName);
    await wait(
      async () => {
        const value = await invoke<{ done: boolean; error?: string }>(cdp, 'stop-result');
        assert(!value.error, value.error);
        return value.done;
      },
      'ordinary team stop',
      120_000
    );
    await wait(
      async () => !(await invoke<boolean>(cdp, 'alive', teamName)),
      'stopped team liveness',
      60_000
    );
    await wait(
      async () => {
        const surviving = await Promise.all(
          [...ownedProcesses].map(async ([pid, identity]) => (await processStart(pid)) === identity)
        );
        return surviving.every((value) => !value);
      },
      'every observed owned member OS process exited',
      60_000
    );
    receipt.stoppedOwnedProcesses = [...ownedProcesses].map(([pid, start]) => ({ pid, start }));
    stopped = true;
  };
  const active = async () => {
    const saved = await invoke<TeamCreateRequest>(cdp, 'saved', teamName);
    assert.equal(saved.providerId, 'anthropic');
    assert(
      saved.members.every((member) => (member.providerId ?? saved.providerId) === 'anthropic'),
      'Unknown provider must not mask unaffected-profile assertion'
    );
    receipt.savedRequest = saved;
    const runtime = await invoke<TeamAgentRuntimeSnapshot>(cdp, 'runtime', teamName);
    assert.equal(runtime.runId, launch?.runId, 'Current runtime must match this app launch');
    const identities = [];
    for (const name of ['team-lead', 'worker']) {
      const member = runtime.members[name];
      assert(member?.alive, `Real active member required: ${name}`);
      // The existing lead DTO omits providerId; its provider is the saved launch request.
      if (name === 'team-lead') assert.equal(member.backendType, 'lead');
      else assert.equal(member.providerId, 'anthropic');
      const pid = member.runtimePid ?? member.pid;
      assert(pid && pid > 0);
      process.kill(pid, 0);
      const start = await processStart(pid);
      assert(start, 'Owned runtime process start identity required');
      ownedProcesses.set(pid, start);
      const cwd = await realpath(`/proc/${pid}/cwd`);
      assert(cwd.startsWith(f.root + path.sep), 'Only inspect fixture-owned runtime processes');
      const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
      const executable = await realpath(`/proc/${pid}/exe`);
      assert.equal(
        executable,
        await realpath(f.env.CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH!),
        'Real pinned runtime executable required'
      );
      identities.push({
        name,
        pid,
        start,
        cwd,
        executable,
        argv,
        runtimeSessionId: member.runtimeSessionId,
      });
    }
    assert(await invoke<boolean>(cdp, 'alive', teamName));
    return { runtime, identities };
  };
  try {
    await invoke(cdp, 'launch', request);
    launch = await wait(
      async () => {
        const result = await invoke<{ done: boolean; value?: TeamCreateResponse; error?: string }>(
          cdp,
          'launch-result'
        );
        assert(!result.error, result.error);
        return result.done ? result.value : null;
      },
      'single actual team creation',
      180_000
    );
    receipt.launch = launch;
    receipt.progress = await wait(
      async () => {
        const value = await invoke<TeamProvisioningProgress>(cdp, 'progress', launch!.runId);
        receipt.lastProgress = value;
        await persist();
        assert(!['failed', 'cancelled'].includes(value.state), JSON.stringify(value));
        return value.state === 'ready' ? value : null;
      },
      'real team readiness',
      180_000
    );
    receipt.activeBefore = await active();
    const watched = ['uap.toml', 'uap.lock'].map((name) =>
      path.join(f.env.AGENTPLUGINS_HOME!, name)
    );
    watched.push(
      path.join(f.env.AGENTPLUGINS_HOME!, 'state-v2.json'),
      path.join(f.env.CLAUDE_CONFIG_DIR!, 'skills'),
      path.join(f.env.CLAUDE_CONFIG_DIR!, 'plugins')
    );
    const before = await Promise.all(watched.map(snapshot));
    assert(
      before.slice(0, 4).every((value) => value !== null),
      'Installed manifest, lock, state and native Skill inventory must exist'
    );
    const refusals = [];
    for (const plan of plans) {
      assert(
        Date.parse(plan.expiresAt) > Date.now(),
        'Active refusal proof requires an unexpired review'
      );
      const requestId = randomUUID();
      const result = await invoke<{ ok: boolean; error?: string }>(cdp, 'management', 'apply', {
        contextId,
        planId: plan.planId,
        requestId,
      });
      assert.equal(result.ok, false, `Active ${plan.action} unexpectedly accepted`);
      assert(result.error?.includes(refusal), result.error);
      assert.equal(
        await snapshot(acceptedPath(requestId)),
        null,
        'Refused request must never enter the Go accepted ledger'
      );
      refusals.push({
        action: plan.action,
        planId: plan.planId,
        requestId,
        error: result.error,
        accepted: false,
      });
    }
    const fresh = await invoke<{ ok: boolean; error?: string }>(cdp, 'management', 'prepare', {
      contextId,
      change: changes[2],
    });
    assert.equal(fresh.ok, false);
    assert(fresh.error?.includes(refusal), fresh.error);
    await f.assertUiRefusal();
    assert.deepEqual(
      await Promise.all(watched.map(snapshot)),
      before,
      'Refusals must preserve manifest, lock and native extension state'
    );
    assert.equal((await environment()).pendingOperations?.length ?? 0, 0);
    receipt.refusals = refusals;
    receipt.freshPrepare = fresh;
    receipt.uiRefusal = true;
    receipt.noEffects = true;
    receipt.activeAfterRefusals = await active();
    await persist();
  } catch (error) {
    receipt.failure = String(error);
    await persist();
    await stop().catch((stopError) => {
      receipt.stopFailure = String(stopError);
    });
    throw error;
  }
  return {
    async finish() {
      try {
        receipt.activeAfterUnaffectedOpenCode = await active();
        receipt.unaffectedOpenCodeUiLifecycle = true;
        await stop();
        for (const plan of plans)
          await managed(cdp, 'discardPlan', { contextId, planId: plan.planId });
        const updated = await apply(await prepare({ action: 'update', aliases: [entry.alias] }));
        const current = await readFile(path.join(projected, 'SKILL.md'));
        assert.notDeepEqual(
          current,
          original,
          'Fresh stopped-profile update must have actual native effects'
        );
        assert.match(current.toString('utf8'), /revision 3/);
        assert.deepEqual(await readFile(path.join(projected, 'assets', 'sample.bin')), binary);
        receipt.updatedAfterStop = updated;
        receipt.completed = true;
      } finally {
        await persist();
      }
    },
    async close() {
      await stop();
      await persist();
    },
  };
}
