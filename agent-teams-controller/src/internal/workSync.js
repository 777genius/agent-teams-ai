const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const runtimeHelpers = require('./runtimeHelpers.js');
const { writeJsonFileSync } = require('./atomicFile.js');
const { withFileLockSync } = require('./fileLock.js');

const DEFAULT_WAIT_TIMEOUT_MS = 10000;
const MIN_WAIT_TIMEOUT_MS = 1000;
const MAX_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const TEAM_CONTROL_API_STATE_FILE = 'team-control-api.json';

function normalizeTimeoutMs(rawValue) {
  const numeric =
    typeof rawValue === 'number' && Number.isFinite(rawValue)
      ? Math.floor(rawValue)
      : DEFAULT_WAIT_TIMEOUT_MS;
  return Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(MIN_WAIT_TIMEOUT_MS, numeric));
}

function readControlApiState(context) {
  const filePath = path.join(context.claudeDir, TEAM_CONTROL_API_STATE_FILE);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.baseUrl === 'string' && parsed.baseUrl.trim()
      ? parsed.baseUrl.trim()
      : '';
  } catch {
    return '';
  }
}

function describeControlApiLookup(context, flags, stateFileUrl, envUrl) {
  const explicit =
    (typeof flags.controlUrl === 'string' && flags.controlUrl.trim()) ||
    (typeof flags['control-url'] === 'string' && flags['control-url'].trim()) ||
    '';
  return [
    `explicit=${explicit ? 'set' : 'missing'}`,
    `stateFile=${
      stateFileUrl ? 'set' : `missing:${path.join(context.claudeDir, TEAM_CONTROL_API_STATE_FILE)}`
    }`,
    `env=${envUrl ? 'set' : 'missing:CLAUDE_TEAM_CONTROL_URL'}`,
  ].join(', ');
}

function resolveControlBaseUrls(context, flags = {}) {
  const explicit =
    (typeof flags.controlUrl === 'string' && flags.controlUrl.trim()) ||
    (typeof flags['control-url'] === 'string' && flags['control-url'].trim()) ||
    '';
  const stateFileUrl = readControlApiState(context);
  const envUrl =
    typeof process.env.CLAUDE_TEAM_CONTROL_URL === 'string'
      ? process.env.CLAUDE_TEAM_CONTROL_URL.trim()
      : '';
  const candidates = [...new Set([explicit, stateFileUrl, envUrl].filter(Boolean))];
  if (candidates.length === 0) {
    throw new Error(
      `Team control API is unavailable. Start the desktop app team runtime first so it can validate member work sync reports. Lookup: ${describeControlApiLookup(
        context,
        flags,
        stateFileUrl,
        envUrl
      )}.`
    );
  }
  return candidates;
}

async function requestJson(baseUrl, pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), normalizeTimeoutMs(options.timeoutMs));
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: options.method || 'GET',
      headers: {
        accept: 'application/json',
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
      if (error && error.controlApiStatus && !isRetryableControlApiStatus(error.controlApiStatus)) {
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

async function memberWorkSyncReport(context, flags = {}) {
  const memberName = runtimeHelpers.assertExplicitTeamMemberName(
    context.paths,
    flags.memberName || flags.member || flags.from,
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
  } catch {
    return appendPendingReportIntent(context, body, 'control_api_unavailable');
  }

  try {
    return await requestJsonWithFallback(baseUrls, pathname, options);
  } catch (error) {
    if (error && error.controlApiStatus) {
      throw error;
    }
    return appendPendingReportIntent(context, body, 'control_api_unavailable');
  }
}

module.exports = {
  memberWorkSyncStatus,
  memberWorkSyncReport,
};
