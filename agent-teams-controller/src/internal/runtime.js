const desktopBinding = require('./desktopControlBinding.js');
const runtimeHelpers = require('./runtimeHelpers.js');
const { buildMemberRosterContext } = require('./briefingProtocols.js');
const {
  normalizeTimeoutMs,
  uniqueNonEmpty,
  resolveControlBaseUrls,
  isRetryableControlError,
  requestJson,
  requestJsonWithFallback,
} = require('./controlApiClient.js');

function getMemberRosterContext(context, memberName, launchMembers = []) {
  const resolved = runtimeHelpers.resolveTeamMembers(context.paths);
  const members = new Map(
    launchMembers.map((member) => [member.name.trim().toLowerCase(), member])
  );
  for (const member of resolved.members) {
    const key = member.name.toLowerCase();
    members.set(key, { ...members.get(key), ...member });
  }
  for (const removedName of resolved.removedNames) members.delete(removedName);
  return buildMemberRosterContext(
    [...members.values()].sort((a, b) => a.name.localeCompare(b.name)),
    memberName,
    runtimeHelpers.inferLeadName(context.paths),
    48
  );
}

const READY_STATES = new Set(['ready', 'failed', 'disconnected', 'cancelled']);
const POLL_INTERVAL_MS = 1000;
// The app escalates a stop that does not confirm for up to 120s per team, and stops the
// project copies of a per-project team one after another, so the default 10s request
// timeout would abort a stop that is still doing its work.
const STOP_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const BOOTSTRAP_CHECKIN_MAX_ATTEMPTS = 3;
const BOOTSTRAP_CHECKIN_ATTEMPT_TIMEOUT_MS = 4000;
const BOOTSTRAP_CHECKIN_RETRY_DELAYS_MS = [300, 900];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBootstrapCheckinRetryableControlError(error) {
  if (!isRetryableControlError(error)) {
    return false;
  }

  if (error.retryableKind === 'timeout' || error.retryableKind === 'network') {
    return true;
  }

  if (error.retryableKind === 'status') {
    return typeof error.statusCode === 'number' && error.statusCode >= 500;
  }

  return false;
}

async function requestJsonWithBoundedRetry(baseUrls, pathname, options = {}, retryOptions = {}) {
  const maxAttempts = Math.max(1, retryOptions.maxAttempts || 1);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await requestJsonWithFallback(baseUrls, pathname, options);
      if (attempt > 1 && result && typeof result === 'object' && !Array.isArray(result)) {
        return {
          ...result,
          diagnostics: uniqueNonEmpty([
            ...(Array.isArray(result.diagnostics) ? result.diagnostics : []),
            'opencode_bootstrap_checkin_retry',
          ]),
        };
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isBootstrapCheckinRetryableControlError(error)) {
        throw error;
      }
      const delayMs = retryOptions.delaysMs?.[attempt - 1] || 0;
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError || new Error('Team control API request failed');
}

function normalizeOptionalLaunchEffort(flags = {}, providerId) {
  const rawEffort =
    typeof flags.effort === 'string' && flags.effort.trim() ? flags.effort.trim() : '';
  if (!rawEffort) {
    return undefined;
  }
  if (rawEffort === 'minimal' && providerId !== 'codex') {
    return 'low';
  }
  return rawEffort;
}

function buildLaunchRequest(flags = {}) {
  const cwd = typeof flags.cwd === 'string' ? flags.cwd.trim() : '';
  if (!cwd) {
    throw new Error('Missing cwd');
  }
  const providerId =
    (typeof flags.providerId === 'string' && flags.providerId.trim()) ||
    (typeof flags['provider-id'] === 'string' && flags['provider-id'].trim()) ||
    '';
  const providerBackendId =
    (typeof flags.providerBackendId === 'string' && flags.providerBackendId.trim()) ||
    (typeof flags['provider-backend-id'] === 'string' && flags['provider-backend-id'].trim()) ||
    '';
  const effort = normalizeOptionalLaunchEffort(flags, providerId);

  return {
    cwd,
    ...(providerId ? { providerId } : {}),
    ...(providerBackendId ? { providerBackendId } : {}),
    ...(typeof flags.prompt === 'string' && flags.prompt.trim()
      ? { prompt: flags.prompt.trim() }
      : {}),
    ...(typeof flags.model === 'string' && flags.model.trim() ? { model: flags.model.trim() } : {}),
    ...(effort ? { effort } : {}),
    ...(typeof flags.fastMode === 'string' && flags.fastMode.trim()
      ? { fastMode: flags.fastMode.trim() }
      : {}),
    ...(typeof flags['fast-mode'] === 'string' && flags['fast-mode'].trim()
      ? { fastMode: flags['fast-mode'].trim() }
      : {}),
    ...(typeof flags.limitContext === 'boolean' ? { limitContext: flags.limitContext } : {}),
    ...(typeof flags['limit-context'] === 'boolean'
      ? { limitContext: flags['limit-context'] }
      : {}),
    ...(typeof flags.clearContext === 'boolean' ? { clearContext: flags.clearContext } : {}),
    ...(typeof flags['clear-context'] === 'boolean'
      ? { clearContext: flags['clear-context'] }
      : {}),
    ...(typeof flags.skipPermissions === 'boolean'
      ? { skipPermissions: flags.skipPermissions }
      : {}),
    ...(typeof flags['skip-permissions'] === 'boolean'
      ? { skipPermissions: flags['skip-permissions'] }
      : {}),
    ...(typeof flags.worktree === 'string' && flags.worktree.trim()
      ? { worktree: flags.worktree.trim() }
      : {}),
    ...(typeof flags.extraCliArgs === 'string' && flags.extraCliArgs.trim()
      ? { extraCliArgs: flags.extraCliArgs.trim() }
      : {}),
    ...(typeof flags['extra-cli-args'] === 'string' && flags['extra-cli-args'].trim()
      ? { extraCliArgs: flags['extra-cli-args'].trim() }
      : {}),
    ...(typeof flags.allowExperimentalLocalModels === 'boolean'
      ? { allowExperimentalLocalModels: flags.allowExperimentalLocalModels }
      : {}),
    ...(typeof flags['allow-experimental-local-models'] === 'boolean'
      ? { allowExperimentalLocalModels: flags['allow-experimental-local-models'] }
      : {}),
  };
}

function isAlreadyLaunchingResponse(launch) {
  return Boolean(
    launch &&
    typeof launch === 'object' &&
    (launch.alreadyLaunching === true || launch.launchStatus === 'already_launching')
  );
}

function shouldWaitForReady(flags = {}) {
  if (typeof flags.waitForReady === 'boolean') {
    return flags.waitForReady;
  }
  if (typeof flags['wait-for-ready'] === 'boolean') {
    return flags['wait-for-ready'];
  }
  return true;
}

function shouldWaitForStop(flags = {}) {
  if (typeof flags.waitForStop === 'boolean') {
    return flags.waitForStop;
  }
  if (typeof flags['wait-for-stop'] === 'boolean') {
    return flags['wait-for-stop'];
  }
  return true;
}

function compactRuntimeToolBody(context, flags = {}, fields) {
  const body = { teamName: context.teamName };
  for (const field of fields) {
    if (flags[field] !== undefined) {
      body[field] = flags[field];
    }
  }
  return body;
}

function compactBody(flags = {}, fields) {
  const body = {};
  for (const field of fields) {
    if (flags[field] !== undefined) {
      body[field] = flags[field];
    }
  }
  return body;
}

async function postRuntimeTool(context, flags = {}, toolPath, body) {
  const baseUrls = resolveControlBaseUrls(context, flags);
  return requestJsonWithFallback(
    baseUrls,
    `/api/teams/${encodeURIComponent(context.teamName)}/opencode/runtime/${toolPath}`,
    {
      method: 'POST',
      body,
      timeoutMs: normalizeTimeoutMs(flags.waitTimeoutMs || flags['wait-timeout-ms'] || 10000),
    }
  );
}

async function waitForProvisioningState(baseUrls, teamName, runId, timeoutMs) {
  const startedAt = Date.now();
  let lastProgress = null;

  while (Date.now() - startedAt <= timeoutMs) {
    const progress = await requestJsonWithFallback(
      baseUrls,
      `/api/teams/provisioning/${encodeURIComponent(runId)}`,
      {
        timeoutMs: Math.min(timeoutMs, 10000),
      }
    );
    lastProgress = progress;

    if (progress && READY_STATES.has(progress.state)) {
      if (progress.state !== 'ready') {
        const suffix =
          progress && typeof progress.error === 'string' && progress.error.trim()
            ? `: ${progress.error.trim()}`
            : '';
        throw new Error(`Team ${teamName} did not become ready (${progress.state})${suffix}`);
      }

      return {
        teamName,
        runId,
        isAlive: true,
        progress,
      };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  const stateLabel =
    lastProgress && typeof lastProgress.state === 'string'
      ? ` while in state ${lastProgress.state}`
      : '';
  throw new Error(`Timed out waiting for team ${teamName} to become ready${stateLabel}`);
}

async function waitForStopped(baseUrls, teamName, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const runtime = await requestJsonWithFallback(
      baseUrls,
      `/api/teams/${encodeURIComponent(teamName)}/runtime`,
      { timeoutMs: Math.min(timeoutMs, 10000) }
    );

    if (!runtime || runtime.isAlive !== true) {
      return runtime;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for team ${teamName} to stop`);
}

async function launchTeam(context, flags = {}) {
  const baseUrls = resolveControlBaseUrls(context, flags);
  const request = buildLaunchRequest(flags);
  const launch = await requestJsonWithFallback(
    baseUrls,
    `/api/teams/${encodeURIComponent(context.teamName)}/launch`,
    {
      method: 'POST',
      body: request,
      timeoutMs: normalizeTimeoutMs(flags.waitTimeoutMs ?? flags['wait-timeout-ms']),
    }
  );

  if (!shouldWaitForReady(flags)) {
    return {
      teamName: context.teamName,
      waitForReady: false,
      ...launch,
    };
  }

  if (isAlreadyLaunchingResponse(launch)) {
    return {
      teamName: context.teamName,
      waitForReady: false,
      ...launch,
    };
  }

  return waitForProvisioningState(
    baseUrls,
    context.teamName,
    launch.runId,
    normalizeTimeoutMs(flags.waitTimeoutMs ?? flags['wait-timeout-ms'])
  );
}

async function listTeams(context, flags = {}) {
  const baseUrls = resolveControlBaseUrls(context, flags);
  return requestJsonWithFallback(baseUrls, '/api/teams', {
    timeoutMs: normalizeTimeoutMs(flags.waitTimeoutMs || flags['wait-timeout-ms'] || 10000),
  });
}

async function getConnectionInfo(context) {
  return requestJsonWithFallback(resolveControlBaseUrls(context), '/api/app/connection');
}

async function showConnectionConfirmation(context, flags = {}) {
  desktopBinding.assertConnectionExpectation(flags);
  if (
    typeof flags.agentName !== 'string' ||
    !flags.agentName.trim() ||
    flags.agentName.length > 80 ||
    /[\u0000-\u001f\u007f]/.test(flags.agentName)
  ) {
    throw new Error('Invalid agent name');
  }
  if (flags.cdpVerified !== undefined && typeof flags.cdpVerified !== 'boolean') {
    throw new Error('Invalid CDP verification flag');
  }
  return requestJson(resolveControlBaseUrls(context)[0], '/api/app/connection/confirmation', {
    method: 'POST',
    body: {
      agentName: flags.agentName.trim(),
      expectedContext: flags.expectedContext,
      ...(flags.cdpVerified !== undefined ? { cdpVerified: flags.cdpVerified } : {}),
    },
  });
}

async function getTeam(context, flags = {}) {
  const baseUrls = resolveControlBaseUrls(context, flags);
  return requestJsonWithFallback(
    baseUrls,
    `/api/teams/${encodeURIComponent(context.teamName)}${flags.configuration === true ? '?configuration=1' : ''}`,
    {
      timeoutMs: normalizeTimeoutMs(flags.waitTimeoutMs || flags['wait-timeout-ms'] || 10000),
    }
  );
}

async function updateTeam(context, flags = {}) {
  desktopBinding.assertManagementExpectation(flags);
  return requestJson(
    resolveControlBaseUrls(context, flags)[0],
    `/api/teams/${encodeURIComponent(context.teamName)}/update`,
    {
      method: 'POST',
      body: compactBody(flags, [
        'expectedContext',
        'expectedRevision',
        'metadata',
        'leadInstructions',
        'members',
      ]),
      timeoutMs: normalizeTimeoutMs(flags.waitTimeoutMs || flags['wait-timeout-ms'] || 10000),
    }
  );
}

async function trashTeam(context, flags = {}) {
  desktopBinding.assertManagementExpectation(flags);
  return requestJson(
    resolveControlBaseUrls(context, flags)[0],
    `/api/teams/${encodeURIComponent(context.teamName)}/trash`,
    {
      method: 'POST',
      body: compactBody(flags, ['expectedContext', 'expectedRevision']),
      timeoutMs: normalizeTimeoutMs(flags.waitTimeoutMs || flags['wait-timeout-ms'] || 10000),
    }
  );
}

async function createTeam(context, flags = {}) {
  desktopBinding.assertDraftExpectation(flags);
  const baseUrls = resolveControlBaseUrls(context, flags);
  return requestJsonWithFallback(baseUrls, '/api/teams', {
    method: 'POST',
    body: {
      teamName: context.teamName,
      ...compactBody(flags, [
        'runtimeSelectionVersion',
        'projectContextMode',
        'expectedContext',
        'syncModelsWithLead',
        'displayName',
        'description',
        'color',
        'members',
        'cwd',
        'prompt',
        'providerId',
        'providerBackendId',
        'model',
        'effort',
        'fastMode',
        'limitContext',
        'skipPermissions',
        'worktree',
        'extraCliArgs',
      ]),
    },
    timeoutMs: normalizeTimeoutMs(flags.waitTimeoutMs || flags['wait-timeout-ms'] || 10000),
  });
}

async function stopTeam(context, flags = {}) {
  const baseUrls = resolveControlBaseUrls(context, flags);
  const stopped = await requestJsonWithFallback(
    baseUrls,
    `/api/teams/${encodeURIComponent(context.teamName)}/stop`,
    {
      method: 'POST',
      timeoutMs: normalizeTimeoutMs(flags.stopRequestTimeoutMs || STOP_REQUEST_TIMEOUT_MS),
      fallbackOnTimeout: false,
    }
  );

  if (!shouldWaitForStop(flags)) {
    return stopped;
  }

  return waitForStopped(
    baseUrls,
    context.teamName,
    normalizeTimeoutMs(flags.waitTimeoutMs || flags['wait-timeout-ms'])
  );
}

async function getRuntimeState(context, flags = {}) {
  const baseUrls = resolveControlBaseUrls(context, flags);
  return requestJsonWithFallback(
    baseUrls,
    `/api/teams/${encodeURIComponent(context.teamName)}/runtime`
  );
}

async function runtimeBootstrapCheckin(context, flags = {}) {
  const baseUrls = resolveControlBaseUrls(context, flags);
  const explicitTimeoutMs = flags.waitTimeoutMs || flags['wait-timeout-ms'];
  const timeoutMs = Math.min(
    normalizeTimeoutMs(explicitTimeoutMs || BOOTSTRAP_CHECKIN_ATTEMPT_TIMEOUT_MS),
    BOOTSTRAP_CHECKIN_ATTEMPT_TIMEOUT_MS
  );
  return requestJsonWithBoundedRetry(
    baseUrls,
    `/api/teams/${encodeURIComponent(context.teamName)}/opencode/runtime/bootstrap-checkin`,
    {
      method: 'POST',
      body: compactRuntimeToolBody(context, flags, [
        'runId',
        'memberName',
        'runtimeSessionId',
        'observedAt',
        'diagnostics',
        'metadata',
      ]),
      timeoutMs,
    },
    {
      maxAttempts: BOOTSTRAP_CHECKIN_MAX_ATTEMPTS,
      delaysMs: BOOTSTRAP_CHECKIN_RETRY_DELAYS_MS,
    }
  );
}

async function runtimeDeliverMessage(context, flags = {}) {
  return postRuntimeTool(
    context,
    flags,
    'deliver-message',
    compactRuntimeToolBody(context, flags, [
      'idempotencyKey',
      'runId',
      'fromMemberName',
      'runtimeSessionId',
      'to',
      'text',
      'createdAt',
      'summary',
      'taskRefs',
    ])
  );
}

async function runtimeTaskEvent(context, flags = {}) {
  return postRuntimeTool(
    context,
    flags,
    'task-event',
    compactRuntimeToolBody(context, flags, [
      'idempotencyKey',
      'runId',
      'memberName',
      'runtimeSessionId',
      'taskId',
      'event',
      'createdAt',
      'summary',
      'metadata',
    ])
  );
}

async function runtimeHeartbeat(context, flags = {}) {
  return postRuntimeTool(
    context,
    flags,
    'heartbeat',
    compactRuntimeToolBody(context, flags, [
      'runId',
      'memberName',
      'runtimeSessionId',
      'observedAt',
      'status',
      'metadata',
    ])
  );
}

module.exports = {
  getMemberRosterContext,
  listTeams,
  getConnectionInfo,
  showConnectionConfirmation,
  getTeam,
  createTeam,
  updateTeam,
  trashTeam,
  launchTeam,
  stopTeam,
  getRuntimeState,
  runtimeBootstrapCheckin,
  runtimeDeliverMessage,
  runtimeTaskEvent,
  runtimeHeartbeat,
};
