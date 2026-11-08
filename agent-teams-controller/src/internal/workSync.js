const desktopBinding = require('./desktopControlBinding.js');
const controlApiAuth = require('./controlApiAuth.cts');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const runtimeHelpers = require('./runtimeHelpers.js');
const { writeJsonFileSync } = require('./atomicFile.js');
const { withFileLockSync } = require('./fileLock.js');

const DEFAULT_WAIT_TIMEOUT_MS = 10000;
const MIN_WAIT_TIMEOUT_MS = 1000;
const MAX_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

function normalizeTimeoutMs(rawValue) {
  const numeric =
    typeof rawValue === 'number' && Number.isFinite(rawValue)
      ? Math.floor(rawValue)
      : DEFAULT_WAIT_TIMEOUT_MS;
  return Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(MIN_WAIT_TIMEOUT_MS, numeric));
}

function resolveControlBaseUrls(context, flags = {}) {
  const boundUrls = desktopBinding.boundControlBaseUrls(context, flags);
  return boundUrls || controlApiAuth.resolveControlAuthorities(context, flags);
}

async function requestJson(target, pathname, options = {}) {
  const { baseUrl, authToken } = target;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), normalizeTimeoutMs(options.timeoutMs));
  try {
    const boundOptions = desktopBinding.boundRequestOptions(baseUrl);
    const response =
      typeof target.read === 'function'
        ? await controlApiAuth.authenticatedControlFetch(target, pathname, {
            method: options.method || 'GET',
            body: options.body,
            signal: controller.signal,
          })
        : await fetch(`${baseUrl}${pathname}`, {
            ...boundOptions,
            redirect: 'error',
            credentials: 'omit',
            method: options.method || 'GET',
            headers: {
              accept: 'application/json',
              ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
              ...boundOptions.headers,
              ...(options.body ? { 'content-type': 'application/json' } : {}),
            },
            ...(options.body ? { body: JSON.stringify(options.body) } : {}),
            signal: controller.signal,
          });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail =
        payload && typeof payload.error === 'string' && payload.error.trim()
          ? payload.error.trim()
          : `${response.status} ${response.statusText}`.trim();
      const error = new Error(detail || 'Team control API request failed');
      error.controlApiStatus = response.status;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function isRetryableControlApiStatus(statusCode) {
  return statusCode === 404 || statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

async function requestJsonWithFallback(baseUrls, pathname, options = {}) {
  let lastError = null;
  for (const baseUrl of baseUrls) {
    try {
      return await requestJson(baseUrl, pathname, options);
    } catch (error) {
      if (
        (options.method || 'GET').toUpperCase() !== 'GET' ||
        (error && error.controlApiStatus && !isRetryableControlApiStatus(error.controlApiStatus))
      ) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError || new Error('Team control API request failed');
}

function compactReportBody(context, memberName, flags = {}) {
  const taskIds = normalizeTaskIds(
    Array.isArray(flags['task-ids']) ? flags['task-ids'] : flags.taskIds
  );
  return {
    teamName: context.teamName,
    memberName,
    state: flags.state,
    agendaFingerprint: flags.agendaFingerprint || flags['agenda-fingerprint'],
    reportToken: flags.reportToken || flags['report-token'],
    ...(taskIds.length > 0 ? { taskIds } : {}),
    ...(typeof flags.note === 'string' && flags.note.trim() ? { note: flags.note.trim() } : {}),
    ...(typeof flags.reportedAt === 'string' && flags.reportedAt.trim()
      ? { reportedAt: flags.reportedAt.trim() }
      : {}),
    ...(typeof flags.leaseTtlMs === 'number' ? { leaseTtlMs: flags.leaseTtlMs } : {}),
  };
}

function normalizeTaskIds(value) {
  return Array.isArray(value)
    ? Array.from(new Set(value.map((taskId) => String(taskId).trim()).filter(Boolean)))
    : [];
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

function buildPendingIntentId(body) {
  const taskIds = Array.isArray(body.taskIds)
    ? Array.from(
        new Set(body.taskIds.map((taskId) => String(taskId).trim()).filter(Boolean))
      ).sort()
    : [];
  const payload = {
    teamName: body.teamName,
    memberName: String(body.memberName || '')
      .trim()
      .toLowerCase(),
    state: body.state,
    agendaFingerprint: body.agendaFingerprint,
    reportToken: body.reportToken || '',
    ...(taskIds.length > 0 ? { taskIds } : {}),
    ...(body.note ? { note: body.note } : {}),
    ...(body.leaseTtlMs ? { leaseTtlMs: body.leaseTtlMs } : {}),
    ...(body.source ? { source: body.source } : {}),
  };
  return `member-work-sync-intent:${crypto
    .createHash('sha256')
    .update(stableStringify(payload))
    .digest('hex')}`;
}

function readPendingReportFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.schemaVersion === 1 &&
      parsed.intents &&
      typeof parsed.intents === 'object' &&
      !Array.isArray(parsed.intents)
    ) {
      return parsed;
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw error;
    }
  }
  return { schemaVersion: 1, intents: {} };
}

function writePendingReportFile(filePath, data) {
  writeJsonFileSync(filePath, data, { trailingNewline: true });
}

function appendPendingReportIntent(context, body, reason) {
  const filePath = path.join(context.paths.teamDir, '.member-work-sync', 'pending-reports.json');
  const { id } = withFileLockSync(filePath, () => {
    const data = readPendingReportFile(filePath);
    const request = {
      ...body,
      source: 'mcp',
    };
    const intentId = buildPendingIntentId(request);
    const current = data.intents[intentId];
    if (!current || current.status === 'pending') {
      data.intents[intentId] = {
        id: intentId,
        teamName: body.teamName,
        memberName: body.memberName,
        request,
        reason,
        status: 'pending',
        recordedAt: current && current.recordedAt ? current.recordedAt : new Date().toISOString(),
      };
      writePendingReportFile(filePath, data);
    }
    return { id: intentId };
  });
  return {
    accepted: false,
    pendingValidation: true,
    code: 'pending_validation',
    message:
      'Member work sync report was recorded for app validation. Continue concrete task work; do not treat this as a confirmed lease yet.',
    intentId: id,
  };
}

function assertReportBody(body) {
  if (!body.state || !['still_working', 'blocked', 'caught_up'].includes(body.state)) {
    throw new Error('state must be still_working, blocked, or caught_up');
  }
  if (!body.agendaFingerprint) {
    throw new Error('agendaFingerprint is required');
  }
  if (!body.reportToken) {
    throw new Error('reportToken is required');
  }
}

async function memberWorkSyncStatus(context, flags = {}) {
  const memberName = runtimeHelpers.assertExplicitTeamMemberName(
    context.paths,
    flags.memberName || flags.member || flags.from,
    'member work sync status member'
  );
  const baseUrls = resolveControlBaseUrls(context, flags);
  return requestJsonWithFallback(
    baseUrls,
    `/api/teams/${encodeURIComponent(context.teamName)}/member-work-sync/${encodeURIComponent(
      memberName
    )}/refresh`,
    {
      method: 'POST',
      body: flags.forceNudge === true || flags['force-nudge'] === true ? { forceNudge: true } : {},
      timeoutMs: normalizeTimeoutMs(flags.waitTimeoutMs || flags['wait-timeout-ms']),
    }
  );
}

/**
 * The report token (issued by member_work_sync_status) carries the member it
 * was minted for: `wrs:v1.<base64url payload>.<signature>`. A caller that
 * copies the token but drops memberName made every report fail with "Unknown
 * member work sync report member: ." and sent the caller into a retry loop.
 * The payload is read only as a fallback identity hint; the app still verifies
 * the signature and the member/agenda binding.
 *
 * The shape test is exactly the one the app's verifier applies
 * (HmacMemberWorkSyncReportTokenAdapter.verify): three non-empty segments and
 * no fourth. Both segments are base64url, which cannot contain a '.', so a
 * token of any other arity was never minted here and yields no identity. A
 * looser test would let a truncated or padded token name a member and queue a
 * report the app can only reject later.
 */
function memberNameFromReportToken(token) {
  if (typeof token !== 'string') return '';
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== 'wrs:v1' || !parts[1] || !parts[2]) return '';
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload.memberName === 'string' ? payload.memberName.trim() : '';
  } catch {
    return '';
  }
}

async function memberWorkSyncReport(context, flags = {}) {
  const explicitMemberName =
    (typeof flags.memberName === 'string' && flags.memberName.trim()) ||
    (typeof flags.member === 'string' && flags.member.trim()) ||
    (typeof flags.from === 'string' && flags.from.trim()) ||
    '';
  const memberName = runtimeHelpers.assertExplicitTeamMemberName(
    context.paths,
    explicitMemberName || memberNameFromReportToken(flags.reportToken || flags['report-token']),
    'member work sync report member'
  );
  const body = compactReportBody(context, memberName, flags);
  assertReportBody(body);

  const pathname = `/api/teams/${encodeURIComponent(context.teamName)}/member-work-sync/report`;
  const options = {
    method: 'POST',
    body,
    timeoutMs: normalizeTimeoutMs(flags.waitTimeoutMs || flags['wait-timeout-ms']),
  };

  let baseUrls;
  try {
    baseUrls = resolveControlBaseUrls(context, flags);
  } catch (error) {
    if (desktopBinding.isDesktopBound()) throw error;
    return appendPendingReportIntent(context, body, 'control_api_unavailable');
  }

  // Once HTTP delivery starts, a transport error can mean the validator already
  // committed. Do not queue a second mutation for later replay.
  return requestJsonWithFallback(baseUrls, pathname, options);
}

module.exports = {
  memberNameFromReportToken,
  memberWorkSyncStatus,
  memberWorkSyncReport,
};
