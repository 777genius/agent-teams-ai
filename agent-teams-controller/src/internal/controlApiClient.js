const desktopBinding = require('./desktopControlBinding.js');
const fs = require('fs');
const path = require('path');

// The HTTP client of the app's control API: where the app publishes it and how a request is made.
const DEFAULT_WAIT_TIMEOUT_MS = 120000;
const MIN_WAIT_TIMEOUT_MS = 1000;
const MAX_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const TEAM_CONTROL_API_STATE_FILE = 'team-control-api.json';
const RETRYABLE_CONTROL_ERROR = 'retryableControlError';

function normalizeTimeoutMs(rawValue) {
  const numeric =
    typeof rawValue === 'number' && Number.isFinite(rawValue)
      ? Math.floor(rawValue)
      : DEFAULT_WAIT_TIMEOUT_MS;
  return Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(MIN_WAIT_TIMEOUT_MS, numeric));
}

function getControlApiStatePath(context) {
  return path.join(context.claudeDir, TEAM_CONTROL_API_STATE_FILE);
}

function readControlApiState(context) {
  const filePath = getControlApiStatePath(context);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim()) {
      return parsed.baseUrl.trim();
    }
    return null;
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function uniqueNonEmpty(items) {
  return [...new Set(items.filter((item) => typeof item === 'string' && item.trim()))];
}

function describeControlApiLookup(context, flags, stateFileUrl, envUrl) {
  const explicit =
    (typeof flags.controlUrl === 'string' && flags.controlUrl.trim()) ||
    (typeof flags['control-url'] === 'string' && flags['control-url'].trim()) ||
    '';
  return [
    `explicit=${explicit ? 'set' : 'missing'}`,
    `stateFile=${stateFileUrl ? 'set' : `missing:${getControlApiStatePath(context)}`}`,
    `env=${envUrl ? 'set' : 'missing:CLAUDE_TEAM_CONTROL_URL'}`,
  ].join(', ');
}

function resolveControlBaseUrls(context, flags = {}) {
  const boundUrls = desktopBinding.boundControlBaseUrls(context, flags);
  if (boundUrls) return boundUrls;
  const explicit =
    (typeof flags.controlUrl === 'string' && flags.controlUrl.trim()) ||
    (typeof flags['control-url'] === 'string' && flags['control-url'].trim()) ||
    '';
  const stateFileUrl = readControlApiState(context) || '';
  const envUrl =
    (typeof process.env.CLAUDE_TEAM_CONTROL_URL === 'string' &&
      process.env.CLAUDE_TEAM_CONTROL_URL.trim()) ||
    '';
  const candidates = uniqueNonEmpty([explicit, stateFileUrl, envUrl]);

  if (candidates.length === 0) {
    throw new Error(
      `Team control API is unavailable. Start the desktop app team runtime first so it can publish CLAUDE_TEAM_CONTROL_URL. Lookup: ${describeControlApiLookup(
        context,
        flags,
        stateFileUrl,
        envUrl
      )}.`
    );
  }

  return candidates;
}

function makeRetryableControlError(message, cause, metadata = {}) {
  const error = new Error(message);
  error[RETRYABLE_CONTROL_ERROR] = true;
  if (metadata.kind) {
    error.retryableKind = metadata.kind;
  }
  if (metadata.statusCode) {
    error.statusCode = metadata.statusCode;
  }
  if (cause) {
    error.cause = cause;
  }
  return error;
}

function isRetryableControlError(error) {
  return Boolean(error && error[RETRYABLE_CONTROL_ERROR] === true);
}

function isRetryableStatusCode(statusCode) {
  return statusCode === 404 || statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

async function requestJson(baseUrl, pathname, options = {}) {
  const controller = new AbortController();
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs || 10000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const boundOptions = desktopBinding.boundRequestOptions(baseUrl);
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...boundOptions,
      method: options.method || 'GET',
      headers: {
        accept: 'application/json',
        ...boundOptions.headers,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      controller.signal.throwIfAborted();
      payload = null;
    }

    if (!response.ok) {
      const detail =
        payload && typeof payload.error === 'string' && payload.error.trim()
          ? payload.error.trim()
          : `${response.status} ${response.statusText}`.trim();
      if (isRetryableStatusCode(response.status)) {
        throw makeRetryableControlError(
          `Team control API ${response.status} at ${baseUrl}${pathname}: ${detail || 'request failed'}`,
          undefined,
          { kind: 'status', statusCode: response.status }
        );
      }
      const failure = new Error(detail || 'Team control API request failed');
      // A structured refusal (for example an incomplete stop) keeps its machine-readable
      // parts for programmatic callers; the message already names what went wrong.
      // `appRefusal` tells it from any other error with a code (an MCP server shows it to the client).
      if (payload && typeof payload.code === 'string') {
        failure.code = payload.code;
        Object.defineProperty(failure, 'appRefusal', { value: true });
      }
      if (payload && payload.outcome && typeof payload.outcome === 'object') {
        failure.outcome = payload.outcome;
      }
      throw failure;
    }

    if (payload == null) {
      throw makeRetryableControlError(
        `Team control API returned empty or non-JSON response at ${baseUrl}${pathname}`,
        undefined,
        { kind: 'empty' }
      );
    }

    return payload;
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw makeRetryableControlError(`Timed out calling team control API: ${pathname}`, error, {
        kind: 'timeout',
      });
    }
    if (error && error.name === 'TypeError') {
      throw makeRetryableControlError(
        `Failed to reach team control API at ${baseUrl}: ${error.message || 'fetch failed'}`,
        error,
        { kind: 'network' }
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestJsonWithFallback(baseUrls, pathname, options = {}) {
  let lastError = null;
  let statusError = null;

  for (let index = 0; index < baseUrls.length; index += 1) {
    const baseUrl = baseUrls[index];
    try {
      return await requestJson(baseUrl, pathname, options);
    } catch (error) {
      lastError = error;
      if (error?.retryableKind === 'status') statusError = error;
      // A request that timed out may still be running on that server (a stop that
      // outlasted its budget): asking another address would start a second one.
      if (options.fallbackOnTimeout === false && error?.retryableKind === 'timeout') {
        throw error;
      }
      if (
        !isRetryableControlError(error) ||
        (options.shouldFallback && !options.shouldFallback(error)) ||
        index === baseUrls.length - 1
      ) {
        if (options.preferStatusError && statusError &&
            (error?.retryableKind === 'network' || error?.retryableKind === 'timeout')) {
          throw statusError;
        }
        throw error;
      }
    }
  }

  throw lastError || new Error('Team control API request failed');
}

module.exports = {
  normalizeTimeoutMs,
  uniqueNonEmpty,
  resolveControlBaseUrls,
  isRetryableControlError,
  requestJson,
  requestJsonWithFallback,
};
