const path = require('path');
const controlApiAuth = require('./controlApiAuth.cts');

function mismatch(detail) {
  const error = new Error(`APP_CONTEXT_MISMATCH: ${detail}`);
  error.code = 'APP_CONTEXT_MISMATCH';
  return error;
}

function assertConnectionContext(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.appInstanceId !== 'string' ||
    !value.appInstanceId.trim() ||
    typeof value.dataRootFingerprint !== 'string' ||
    !value.dataRootFingerprint.trim() ||
    !Number.isSafeInteger(value.connectionGeneration) ||
    value.connectionGeneration < 1
  ) {
    throw mismatch(
      'expectedContext must contain appInstanceId, dataRootFingerprint and connectionGeneration'
    );
  }
  return Object.freeze({
    appInstanceId: value.appInstanceId,
    dataRootFingerprint: value.dataRootFingerprint,
    connectionGeneration: value.connectionGeneration,
  });
}

function readBinding() {
  const controlUrl = process.env.AGENT_TEAMS_BOUND_CONTROL_URL;
  const rawContext = process.env.AGENT_TEAMS_BOUND_CONTEXT_JSON;
  const authToken = process.env.AGENT_TEAMS_BOUND_CONTROL_AUTH_TOKEN;
  const authReference = process.env.CLAUDE_TEAM_CONTROL_AUTH_REF;
  if (controlUrl === undefined && rawContext === undefined && authToken === undefined) return null;
  try {
    const url = new URL(controlUrl);
    const claudeDir = process.env.AGENT_TEAMS_MCP_CLAUDE_DIR;
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      controlUrl !== url.origin ||
      (authReference === undefined &&
        (typeof authToken !== 'string' || !/^\S{32,512}$/.test(authToken))) ||
      !claudeDir ||
      !path.isAbsolute(claudeDir)
    ) {
      throw mismatch('invalid desktop control binding');
    }
    const context = assertConnectionContext(JSON.parse(rawContext));
    const resolvedRoot = path.resolve(claudeDir);
    let authoritySource;
    if (authReference !== undefined) {
      if (
        typeof authReference !== 'string' ||
        path.dirname(authReference) !== path.join(resolvedRoot, 'local-http-auth') ||
        !/^api-[a-f0-9-]{36}\.ref\.json$/.test(path.basename(authReference))
      )
        throw mismatch('invalid desktop credential reference');
      // The fixed stable instance ref owns every future generation. Do not read
      // mutable environment hints or retain a bearer fallback for this child.
      [authoritySource] = controlApiAuth.resolveControlAuthorities(
        { claudeDir: resolvedRoot },
        { controlUrl },
        authReference
      );
    }
    return Object.freeze({
      controlUrl,
      authToken: authoritySource ? undefined : authToken,
      authoritySource,
      claudeDir: resolvedRoot,
      context,
      headers: Object.freeze({
        ...(!authoritySource ? { authorization: `Bearer ${authToken}` } : {}),
        'x-agent-teams-app-context': JSON.stringify(context),
      }),
    });
  } catch (error) {
    if (error.code === 'APP_CONTEXT_MISMATCH') throw error;
    throw mismatch('invalid desktop control binding');
  }
}

// Capture once: later env changes cannot retarget an app-owned child.
const binding = readBinding();

function boundControllerOptions(options = {}) {
  if (!binding) return options;
  if (
    options.claudeDir !== undefined &&
    (typeof options.claudeDir !== 'string' || path.resolve(options.claudeDir) !== binding.claudeDir)
  ) {
    throw mismatch('claudeDir differs from desktop binding');
  }
  return { ...options, claudeDir: binding.claudeDir };
}

function boundControlBaseUrls(context, flags = {}) {
  if (!binding) return null;
  boundControllerOptions(context);
  for (const field of ['controlUrl', 'control-url']) {
    if (flags[field] !== undefined && flags[field] !== binding.controlUrl) {
      throw mismatch('controlUrl differs from desktop binding');
    }
  }
  return [{ baseUrl: binding.controlUrl, authToken: binding.authToken }];
}

function boundRequestOptions(baseUrl) {
  if (!binding) return { redirect: 'error', credentials: 'omit' };
  if (baseUrl !== binding.controlUrl) throw mismatch('request URL differs from desktop binding');
  const headers = binding.authoritySource
    ? { ...binding.headers, authorization: `Bearer ${binding.authoritySource.read().token}` }
    : binding.headers;
  return { headers, redirect: 'error', credentials: 'omit' };
}

function assertManagementExpectation(flags) {
  const expected = assertConnectionContext(flags.expectedContext);
  if (binding && Object.keys(expected).some((key) => expected[key] !== binding.context[key])) {
    throw mismatch('expectedContext differs from desktop binding');
  }
  if (typeof flags.expectedRevision !== 'string' || !flags.expectedRevision.trim()) {
    throw new Error('expectedRevision from a fresh team_get is required');
  }
}

function assertDraftExpectation(flags) {
  if (flags.runtimeSelectionVersion === undefined) return;
  if (flags.runtimeSelectionVersion !== 1) throw new Error('UNSUPPORTED_RUNTIME_SELECTION_VERSION');
  const expected = assertConnectionContext(flags.expectedContext);
  if (binding && Object.keys(expected).some((key) => expected[key] !== binding.context[key])) {
    throw mismatch('expectedContext differs from desktop binding');
  }
}

module.exports = {
  boundControllerOptions,
  boundControlBaseUrls,
  boundRequestOptions,
  assertDraftExpectation,
  assertManagementExpectation,
  isDesktopBound: () => binding !== null,
};
