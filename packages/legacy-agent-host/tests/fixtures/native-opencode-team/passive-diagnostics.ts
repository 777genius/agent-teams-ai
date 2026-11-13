/** TEST-only passive diagnostics for the original source Host on the qualified Node/platform tuples. */
import { channel } from 'node:diagnostics_channel';
import { lstat, open, unlink } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';

const prefix = 'TEST_OPENCODE_V2_DIAGNOSTIC ';
const maximum = 256;
const maximumTraceBytes = 64 * 1024, maximumLineBytes = 512, reservedLineBytes = maximumLineBytes + 1;
const events = ['child-spawn', 'child-ready', 'child-failed', 'child-exit', 'child-output-limit',
  'child-input-ended', 'host-input-ended', 'request', 'request-send-headers', 'request-body-sent',
  'response', 'response-end', 'request-error', 'read-cut-failed', 'metadata-read-failed', 'trace-limit'] as const;
const routes = ['info', 'session-create', 'session-read', 'instructions', 'permissions', 'plugins',
  'mcp', 'log', 'prompt', 'provider-catalog', 'model-catalog', 'model-default', 'integration-read',
  'integration-connect', 'credential-remove', 'other-api'] as const;
const stages = ['input', 'executable', 'profile', 'graph', 'configuration', 'effect', 'runtime', 'scope', 'server', 'address', 'unknown'] as const;
const codes = ['ABORT_ERR', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT',
  'UND_ERR_ABORTED', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'unknown'] as const;
const signals = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGBUS', 'unknown'] as const;
const contentEncodings = ['none', 'gzip', 'deflate', 'br', 'other'] as const;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const choice = <T extends string>(value: unknown, allowed: readonly T[]): T | null =>
  typeof value === 'string' && allowed.includes(value as T) ? value as T : null;
const integer = (value: unknown, max = 3_600_000): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;

const readCutStages = ['before-session', 'before-log', 'messages', 'after-log', 'after-session', 'comparison'] as const;
const readCutReasons = ['deadline', 'cleanup_unknown', 'native_read_cleanup_unknown', 'invalid_native_read_response',
  'invalid_native_read_json', 'native_session_binding_mismatch', 'invalid_native_envelope', 'invalid_native_page',
  'invalid_native_model', 'invalid_native_position', 'invalid_native_identity', 'incomplete_native_log',
  'incomplete_native_transcript', 'native_cut_byte_budget', 'frame_limit', 'body_limit', 'transport_failure',
  'authority_mismatch', 'disposed', 'media_type', 'http_failure', 'unknown'] as const;

/** The private D channel carries only fixed data; never execute a diagnostic getter. */
function projectReadCutFailure(value: unknown) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const own = (key: string): unknown => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      return field && 'value' in field ? field.value : undefined;
    };
    const stage = choice(own('stage'), readCutStages), reason = choice(own('reason'), readCutReasons);
    const elapsedMs = integer(own('elapsedMs'), 60_000), deadlineExpired = own('deadlineExpired'), aborted = own('aborted');
    if (!stage || !reason || elapsedMs === null || typeof deadlineExpired !== 'boolean' || typeof aborted !== 'boolean')
      return undefined;
    return { stage, reason, elapsedMs, deadlineExpired, aborted };
  } catch { return undefined; }
}

const metadataReadStages = ['admission', 'native-client', 'identity', 'plugins', 'permissions', 'mcp',
  'credential', 'directory', 'activation-wait', 'current', 'projection', 'dispose', 'result-current'] as const;
const metadataReadReasons = ['held', 'conflict', 'invalid', 'busy', 'deadline', 'cleanup_unknown',
  'transport_failure', 'authority_mismatch', 'disposed', 'http_failure', 'media_type', 'body_limit',
  'frame_limit', 'invalid_response', 'invalid_native_catalog', 'native_catalog_binding_mismatch',
  'capabilities_pending', 'unqualified_version', 'ABORT_ERR', 'unknown'] as const;

/** Original metadata read failure only; null abort observation is limited to pre-signal admission. */
function projectMetadataReadFailure(value: unknown) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const own = (key: string): unknown => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      return field && 'value' in field ? field.value as unknown : undefined;
    };
    const stage = choice(own('stage'), metadataReadStages), reason = choice(own('reason'), metadataReadReasons);
    const elapsedMs = integer(own('elapsedMs')), deadlineExpired = own('deadlineExpired'), aborted = own('aborted');
    if (!stage || !reason || elapsedMs === null || typeof deadlineExpired !== 'boolean' ||
        !(typeof aborted === 'boolean' || aborted === null && stage === 'admission')) return undefined;
    return { stage, reason, elapsedMs, deadlineExpired, aborted };
  } catch { return undefined; }
}

/** Project again at the receipt boundary; native text/IDs/credentials are never retained. */
export function createPassiveNativeDiagnosticCapture() {
  const entries: Record<string, unknown>[] = [];
  let pending = '', ordinary = 0, bytes = 0, metadataObserved = false, limitObserved = false, limited = false;
  // These counters belong to this one original capture, including all of its Host epochs.
  return {
    entries,
    get limited() { return limited; },
    accept(chunk: Buffer, epoch: number) {
      if (chunk.length + Buffer.byteLength(pending) > maximumTraceBytes) { pending = ''; limited = true; return; }
      pending += chunk.toString('utf8');
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line.startsWith(prefix) || Buffer.byteLength(line) > maximumLineBytes) continue;
        try {
          const value = record(JSON.parse(line.slice(prefix.length)) as unknown);
          const event = choice(value.event, events), atMs = integer(value.atMs);
          if (!event || atMs === null) continue;
          const failedCut = event === 'read-cut-failed' ? projectReadCutFailure(value) : undefined;
          const failedMetadata = event === 'metadata-read-failed' ? projectMetadataReadFailure(value) : undefined;
          if (event === 'read-cut-failed' && !failedCut || event === 'metadata-read-failed' && !failedMetadata) continue;
          const failure = failedMetadata ?? failedCut;
          const entry = { epoch, event, atMs, child: integer(value.child, 5), request: integer(value.request, 4096),
            route: choice(value.route, routes), method: choice(value.method, ['GET', 'POST', 'PUT', 'DELETE']),
            durationMs: failure?.elapsedMs ?? integer(value.durationMs), status: integer(value.status, 599),
            contentEncoding: choice(value.contentEncoding, contentEncodings),
            stage: failure?.stage ?? choice(value.stage, stages), code: failure?.reason ?? choice(value.code, codes),
            exitCode: integer(value.exitCode, 255), signal: choice(value.signal, signals),
            ...(failure ? { deadlineExpired: failure.deadlineExpired, aborted: failure.aborted } : {}) };
          const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
          if (size > reservedLineBytes) continue;
          if (failedMetadata) {
            if (metadataObserved || bytes + size > maximumTraceBytes - (limitObserved ? 0 : reservedLineBytes)) continue;
            metadataObserved = true;
          } else if (event === 'trace-limit') {
            if (limitObserved || bytes + size > maximumTraceBytes - (metadataObserved ? 0 : reservedLineBytes)) continue;
            limitObserved = true; limited = true;
          } else {
            const reserve = (metadataObserved ? 0 : reservedLineBytes) + (limitObserved ? 0 : reservedLineBytes);
            if (ordinary >= maximum - 1 || bytes + size > maximumTraceBytes - reserve) { limited = true; continue; }
            ordinary++;
          }
          bytes += size;
          entries.push(entry);
        } catch { /* Other Host diagnostics are deliberately not retained. */ }
      }
    },
  };
}

const cpuCategories = ['configuration-read', 'credential-read', 'team-writer-authority',
  'custody-image', 'provider-transport', 'other', 'idle'] as const;
type CpuCategory = typeof cpuCategories[number];
const cpuWriterFamilies = ['namespace-fence', 'team-state', 'team-state-validation',
  'launch-binding-read', 'launch-binding-current', 'launch-binding-clone', 'other-writer'] as const;
type CpuUnavailable = 'not-started' | 'host-not-exited' | 'missing' | 'stat-failed' | 'file-shape' |
  'empty-profile' | 'profile-over-limit' | 'open-failed' | 'read-failed' | 'incomplete-read' |
  'changed-file' | 'invalid-profile' | 'discard-failed';
const maximumCpuBytes = 16 * 1024 * 1024;
type CpuFileSize = {
  /** Exact within the read limit; a capped lower bound when fileOverLimit is true. */
  fileBytes?: number;
  fileOverLimit?: boolean;
};
type CpuTotals = { category: CpuCategory; exclusiveSamples: number; exclusiveSampledUs: number;
  inclusiveSamples: number; inclusiveSampledUs: number };
type CpuWriterTotals = { family: typeof cpuWriterFamilies[number]; exclusiveSamples: number;
  exclusiveSampledUs: number };
export type OriginalHostCpuProfile = CpuFileSize & ({ status: 'unavailable'; reason: CpuUnavailable; rawDiscarded: boolean } | {
  status: 'available'; rawDiscarded: boolean; samplingIntervalUs: 1000 | 10000; profileDurationUs: number;
  sampledUs: number; unsampledUs: number; nodeCount: number; sampleCount: number;
  attribution: 'nearest-allowlisted-stack-frame'; categories: CpuTotals[];
  /** Partition of the unchanged exclusive team-writer-authority totals, not additional sampled time. */
  teamWriterDetails: CpuWriterTotals[];
});

/** Closed source families only. No frame name, source URL, path or stack leaves this projection. */
function cpuCategory(frame: Record<string, unknown>): number | undefined {
  if (typeof frame.url !== 'string' || frame.url.length > 16_384 ||
      typeof frame.functionName !== 'string' || frame.functionName.length > 16_384)
    throw new Error('Invalid TEST CPU frame');
  const path = frame.url.replaceAll('\\', '/');
  if (/\/(?:adapters\/providers\/(?:OpenCodeConfigurationSource|OpenCodeV2CapturedConfiguration)|composition\/openCodeSelectedProviderConfiguration)\.[jt]s$/.test(path)) return 0;
  if (/\/adapters\/providers\/OpenCodeV2(?:CredentialScope|SessionCredential|CredentialOperation)\.[jt]s$/.test(path)) return 1;
  if (/\/(?:composition\/(?:captureMemberProviderAuthority|teamRoster)|adapters\/profile\/ProfileWriterLease)\.[jt]s$/.test(path) ||
      /\/composition\/RuntimeTeamCoordinator\.[jt]s$/.test(path) && frame.functionName === 'assertCurrent') return 2;
  if (/\/(?:adapters\/providers\/(?:OpenCodeV2EmbeddedGraph|OpenCodeV2CustodyReadback|WindowsJobCustody)|process\/(?:readPackagedProcessArtifact|DarwinRegisteredProcess)|composition\/processCustody)\.[jt]s$/.test(path) ||
      /\/adapters\/providers\/OpenCodeV2EmbeddedMemberProvider\.[jt]s$/.test(path) && frame.functionName === 'attest') return 3;
  if (/\/features\/provider-session-implementation\/adapters\/opencode-protocol\/[^/]+\.js$/.test(path)) return 4;
  if (frame.functionName === '(idle)') return 6;
  return undefined;
}

/** Exact source/function families within the original writer category; no additional raw fields escape. */
function cpuWriterFamily(frame: Record<string, unknown>): number | undefined {
  if (typeof frame.url !== 'string' || typeof frame.functionName !== 'string') return undefined;
  const path = frame.url.replaceAll('\\', '/'), name = frame.functionName;
  if (/\/adapters\/team\/TeamOwnerStore\.[jt]s$/.test(path) &&
      (name === 'fenced' || name === 'validateNamespace')) return 0;
  // state also includes the existing roster recovery; its residual is not pure validation CPU.
  if (/\/team\/TeamOwner\.[jt]s$/.test(path) && name === 'state') return 1;
  if (/\/team\/(?:TeamRuntimeRegistration|TeamRosterTransitions)\.[jt]s$/.test(path) && name === 'validate') return 2;
  if (/\/adapters\/team\/FileTeamRuntimeBindings\.[jt]s$/.test(path)) {
    if (name === 'read') return 3;
    if (name === 'current') return 4;
  }
  // This candidate is accepted only below the exact binding-current context during tree traversal.
  if (path === 'node:internal/worker/js_transferable' && name === 'structuredClone') return 5;
  return undefined;
}

function projectCpuProfile(raw: unknown, samplingIntervalUs: 1000 | 10000): OriginalHostCpuProfile {
  const invalid = (): never => { throw new Error('Invalid TEST CPU profile'); };
  const value = record(raw), start = integer(value.startTime, Number.MAX_SAFE_INTEGER),
    end = integer(value.endTime, Number.MAX_SAFE_INTEGER);
  if (start === null || end === null || end <= start || end - start > 3_600_000_000 ||
      !Array.isArray(value.nodes) || value.nodes.length < 1 || value.nodes.length > 100_000 ||
      !Array.isArray(value.samples) || !Array.isArray(value.timeDeltas) ||
      value.samples.length < 1 || value.samples.length > 1_000_000 ||
      value.samples.length !== value.timeDeltas.length) return invalid();
  const duration = end - start;
  const nodes = new Map<number, { category: number | undefined; writerFamily: number | undefined; children: number[] }>();
  for (const rawNode of value.nodes) {
    const node = record(rawNode), id = integer(node.id, 1_000_000);
    if (id === null || id < 1 || nodes.has(id) ||
        node.children !== undefined && !Array.isArray(node.children)) return invalid();
    const children: number[] = [];
    for (const child of (node.children ?? []) as unknown[]) {
      const selected = integer(child, 1_000_000);
      if (selected === null || selected < 1) return invalid();
      children.push(selected);
    }
    const callFrame = record(node.callFrame);
    nodes.set(id, { category: cpuCategory(callFrame), writerFamily: cpuWriterFamily(callFrame), children });
  }
  const first = integer(record(value.nodes[0]).id, 1_000_000)!;
  const frames = new Map<number, { exclusive: number; inclusive: number; writerFamily: number }>();
  const pending = [{ id: first, exclusive: 5, inclusive: 0, writerFamily: 6 }];
  while (pending.length) {
    const current = pending.pop()!, node = nodes.get(current.id);
    if (!node || frames.has(current.id)) return invalid(); // One connected, acyclic original stack tree.
    const exclusive = node.category ?? current.exclusive;
    const inclusive = current.inclusive | (node.category === undefined ? 0 : 1 << node.category);
    const writerFamily = node.writerFamily === 5
      ? (current.writerFamily === 4 ? 5 : current.writerFamily)
      : node.writerFamily ?? current.writerFamily;
    frames.set(current.id, { exclusive, inclusive, writerFamily });
    for (const id of node.children) pending.push({ id, exclusive, inclusive, writerFamily });
  }
  if (frames.size !== nodes.size) return invalid();
  const categories: CpuTotals[] = cpuCategories.map(category => ({ category,
    exclusiveSamples: 0, exclusiveSampledUs: 0, inclusiveSamples: 0, inclusiveSampledUs: 0 }));
  const teamWriterDetails: CpuWriterTotals[] = cpuWriterFamilies.map(family => ({ family,
    exclusiveSamples: 0, exclusiveSampledUs: 0 }));
  let sampledUs = 0;
  for (let index = 0; index < value.samples.length; index++) {
    const id = integer(value.samples[index], 1_000_000), delta = integer(value.timeDeltas[index], duration);
    const frame = id === null ? undefined : frames.get(id);
    if (!frame || delta === null || sampledUs + delta > duration) return invalid();
    sampledUs += delta;
    const exclusive = categories[frame.exclusive]!;
    exclusive.exclusiveSamples++; exclusive.exclusiveSampledUs += delta;
    if (frame.exclusive === 2) {
      const detail = teamWriterDetails[frame.writerFamily]!;
      detail.exclusiveSamples++; detail.exclusiveSampledUs += delta;
    }
    // A category is counted at most once per stack. Inclusive columns overlap; never sum them.
    const inclusive = frame.inclusive | 1 << frame.exclusive;
    for (let category = 0; category < categories.length; category++) if (inclusive & 1 << category) {
      categories[category]!.inclusiveSamples++; categories[category]!.inclusiveSampledUs += delta;
    }
  }
  return { status: 'available', rawDiscarded: false, samplingIntervalUs,
    profileDurationUs: duration, sampledUs, unsampledUs: duration - sampledUs,
    nodeCount: nodes.size, sampleCount: value.samples.length,
    attribution: 'nearest-allowlisted-stack-frame', categories, teamWriterDetails };
}

/** Read after the original process exits. This measures sampled Host stacks, not Bun CPU or request latency. */
export async function readOriginalHostCpuProfile(
  path: string | undefined, originalExited: boolean, samplingIntervalUs: 1000 | 10000 = 1000
): Promise<OriginalHostCpuProfile> {
  if (!path) return { status: 'unavailable', reason: 'not-started', rawDiscarded: true };
  if (!originalExited) return { status: 'unavailable', reason: 'host-not-exited', rawDiscarded: false };
  let result: OriginalHostCpuProfile = { status: 'unavailable', reason: 'stat-failed', rawDiscarded: false };
  let reason: CpuUnavailable = 'stat-failed';
  const fileSize: CpuFileSize = {};
  try {
    const before = await lstat(path);
    reason = 'file-shape';
    if (!Number.isSafeInteger(before.size) || before.size < 0) throw new Error('Invalid TEST CPU size');
    fileSize.fileBytes = Math.min(before.size, maximumCpuBytes + 1);
    fileSize.fileOverLimit = before.size > maximumCpuBytes;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('Invalid TEST CPU file');
    reason = 'empty-profile';
    if (before.size === 0) throw new Error('Empty TEST CPU file');
    reason = 'profile-over-limit';
    if (fileSize.fileOverLimit) throw new Error('Oversized TEST CPU file');
    const same = (after: typeof before) => after.isFile() && after.nlink === 1 &&
      after.dev === before.dev && after.ino === before.ino && after.size === before.size &&
      after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs;
    reason = 'open-failed';
    const handle = await open(path, 'r');
    let bytes: Buffer;
    let closeFailure: { error: unknown } | undefined;
    try {
      reason = 'changed-file';
      if (!same(await handle.stat())) throw new Error('Changed TEST CPU file');
      reason = 'read-failed';
      bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        reason = 'read-failed';
        const read = await handle.read(bytes, offset, bytes.length - offset, offset);
        reason = 'incomplete-read';
        if (!read.bytesRead) throw new Error('Incomplete TEST CPU file');
        offset += read.bytesRead;
      }
      reason = 'changed-file';
      if (!same(await handle.stat()) || !same(await lstat(path))) throw new Error('Changed TEST CPU file');
    } finally { await handle.close().catch((error: unknown) => { closeFailure = { error }; }); }
    if (closeFailure) { reason = 'read-failed'; throw closeFailure.error; }
    reason = 'invalid-profile';
    result = projectCpuProfile(JSON.parse(bytes.toString('utf8')) as unknown, samplingIntervalUs);
  } catch (error) {
    result = { status: 'unavailable', reason: reason === 'stat-failed' && record(error).code === 'ENOENT'
      ? 'missing' : reason, rawDiscarded: false };
  }
  try { await unlink(path); result.rawDiscarded = true; }
  catch (error) {
    if (record(error).code === 'ENOENT') result.rawDiscarded = true;
    else result = { status: 'unavailable', reason: 'discard-failed', rawDiscarded: false };
  }
  return { ...result, ...fileSize };
}

/** Classify the pinned Undici Buffer-pair shape; no raw header value is retained. */
function responseContentEncoding(headers: unknown): typeof contentEncodings[number] {
  if (!Array.isArray(headers) || headers.length > 256 || headers.length % 2 !== 0) return 'other';
  let selected: typeof contentEncodings[number] = 'none';
  for (let index = 0; index < headers.length; index += 2) {
    const name = headers[index], value = headers[index + 1];
    if (!Buffer.isBuffer(name)) return 'other';
    if (name.length !== 16 || name.toString('ascii').toLowerCase() !== 'content-encoding') continue;
    if (selected !== 'none' || !Buffer.isBuffer(value) || value.length > 32) return 'other';
    selected = choice(value.toString('ascii').trim().toLowerCase(), ['gzip', 'deflate', 'br']) ?? 'other';
  }
  return selected;
}

function observeOriginalHost(): void {
  const started = performance.now();
  let ordinary = 0, emittedBytes = 0, children = 0, requests = 0, metadataObserved = false, limited = false;
  const elapsed = () => Math.max(0, Math.round(performance.now() - started));
  const line = (value: Record<string, unknown>) => prefix + JSON.stringify({ atMs: elapsed(), ...value }) + '\n';
  const write = (value: string) => { emittedBytes += Buffer.byteLength(value); process.stderr.write(value); };
  const emit = (value: Record<string, unknown>) => {
    const frame = line(value), size = Buffer.byteLength(frame);
    if (size > reservedLineBytes) return;
    if (value.event === 'metadata-read-failed') {
      if (metadataObserved || emittedBytes + size > maximumTraceBytes - (limited ? 0 : reservedLineBytes)) return;
      metadataObserved = true; write(frame); return;
    }
    if (limited) return;
    const reserve = (metadataObserved ? 0 : reservedLineBytes) + reservedLineBytes;
    if (ordinary >= maximum - 1 || emittedBytes + size > maximumTraceBytes - reserve) {
      limited = true; write(line({ event: 'trace-limit' })); return;
    }
    ordinary++; write(frame);
  };
  process.stdin.once('end', () => emit({ event: 'host-input-ended' }));
  channel('agent-teams:opencode-v2:read-cut-failed').subscribe(message => {
    try {
      const failure = projectReadCutFailure(message);
      if (failure) emit({ event: 'read-cut-failed', ...failure });
    } catch { /* A passive TEST subscriber cannot replace native failure/cleanup. */ }
  });
  channel('agent-teams:opencode-v2:metadata-read-failed').subscribe(message => {
    try {
      const failure = projectMetadataReadFailure(message);
      if (failure) emit({ event: 'metadata-read-failed', ...failure });
    } catch { /* A passive TEST subscriber cannot replace original metadata failure/cleanup. */ }
  });
  const childEntry = fileURLToPath(new URL('../../../dist/adapters/providers/OpenCodeV2EmbeddedChild.js', import.meta.url));
  channel('child_process').subscribe(message => {
    const child = record(message).process as ChildProcess | undefined;
    child?.once('spawn', () => {
      if (child.spawnargs.at(-1) !== childEntry || children >= 5) return;
      const selected = ++children;
      emit({ event: 'child-spawn', child: selected });
      child.stdin?.once('finish', () => emit({ event: 'child-input-ended', child: selected }));
      let output = '', bytes = 0;
      const observe = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) { child.stdout?.off('data', observe); emit({ event: 'child-output-limit', child: selected }); return; }
        output += chunk.toString('utf8');
        for (let end = output.indexOf('\n'); end >= 0; end = output.indexOf('\n')) {
          const line = output.slice(0, end); output = output.slice(end + 1);
          try {
            const value = record(JSON.parse(line) as unknown);
            if (value.type === 'ready' && value.pid === child.pid && value.version === '2.1.4')
              emit({ event: 'child-ready', child: selected });
            else if (value.type === 'failed') emit({ event: 'child-failed', child: selected, stage: choice(value.stage, stages) ?? 'unknown' });
          } catch { /* No raw engine output is retained. */ }
        }
      };
      child.stdout?.on('data', observe);
      child.once('exit', (exitCode, signal) => emit({ event: 'child-exit', child: selected,
        exitCode, signal: signal === null ? null : choice(signal, signals) ?? 'unknown' }));
      child.once('close', () => { child.stdout?.off('data', observe); output = ''; });
    });
  });
  const pending = new WeakMap<object, { request: number; route: string; method: string; started: number;
    sendHeadersObserved: boolean; bodySentObserved: boolean }>();
  channel('undici:request:create').subscribe(message => {
    const request = record(record(message).request);
    if (requests >= 4096 || typeof request.origin !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(request.origin) ||
        typeof request.path !== 'string' || !request.path.startsWith('/api/')) return;
    const path = request.path.split('?')[0]!;
    const route = path === '/api/info' ? 'info' : path === '/api/session' ? 'session-create'
      : path === '/api/permission/saved' ? 'permissions' : path === '/api/plugin' ? 'plugins'
      : path === '/api/mcp' ? 'mcp' : /\/instructions?(?:\/|$)/.test(path) ? 'instructions'
      : path === '/api/provider' ? 'provider-catalog' : path === '/api/model' ? 'model-catalog'
      : path === '/api/model/default' ? 'model-default'
      : /^\/api\/integration\/[^/]+\/connect\/key$/.test(path) ? 'integration-connect'
      : /^\/api\/integration\/[^/]+$/.test(path) ? 'integration-read'
      : /^\/api\/credential\/[^/]+$/.test(path) ? 'credential-remove'
      : /\/log$/.test(path) ? 'log' : /\/prompt$/.test(path) ? 'prompt'
      : /^\/api\/session\/[^/]+$/.test(path) ? 'session-read' : 'other-api';
    const method = choice(request.method, ['GET', 'POST', 'PUT', 'DELETE']);
    if (!method) return;
    const value = { request: ++requests, route, method, started: performance.now(),
      sendHeadersObserved: false, bodySentObserved: false };
    pending.set(request, value); emit({ event: 'request', request: value.request, route, method });
  });
  // Exact Node24.21 writer phases only; neither proves server ingress or native acceptance.
  // Restrict extra events to the two metadata seams, retaining the original total trace budget.
  for (const [name, event, marker] of [
    ['undici:client:sendHeaders', 'request-send-headers', 'sendHeadersObserved'],
    ['undici:request:bodySent', 'request-body-sent', 'bodySentObserved'],
  ] as const) channel(name).subscribe(message => {
    const value = pending.get(record(record(message).request));
    if (!value || value.route !== 'plugins' && value.route !== 'model-catalog' || value[marker]) return;
    value[marker] = true;
    emit({ event, request: value.request, route: value.route, method: value.method,
      durationMs: Math.max(0, Math.round(performance.now() - value.started)) });
  });
  // Headers alone do not show when a finite native log body finishes arriving.
  // Observe only log trailers: no native bytes, header values or new requests.
  channel('undici:request:trailers').subscribe(message => {
    const value = pending.get(record(record(message).request));
    if (value?.route !== 'log') return;
    emit({ event: 'response-end', request: value.request, route: value.route, method: value.method,
      durationMs: Math.max(0, Math.round(performance.now() - value.started)) });
  });
  for (const [name, event] of [['undici:request:headers', 'response'], ['undici:request:error', 'request-error']] as const)
    channel(name).subscribe(message => {
      const row = record(message), value = pending.get(record(row.request));
      if (!value) return;
      emit({ event, request: value.request, route: value.route, method: value.method,
        durationMs: Math.max(0, Math.round(performance.now() - value.started)),
        ...(event === 'response' ? { status: integer(record(row.response).statusCode, 599),
          contentEncoding: responseContentEncoding(record(row.response).headers) }
          : { code: choice(record(row.error).code, codes) ?? 'unknown' }) });
    });
}

// Importing the receipt projection in the parent does not activate an observer.
if ((process.platform === 'linux' && process.arch === 'x64' ||
      (process.platform === 'darwin' || process.platform === 'win32') &&
      (process.arch === 'arm64' || process.arch === 'x64')) && process.version === 'v24.21.0' &&
    process.execArgv.some((argument, index, args) => argument === '--import' &&
      (args[index + 1] === import.meta.url || args[index + 1] === fileURLToPath(import.meta.url))))
  observeOriginalHost();
