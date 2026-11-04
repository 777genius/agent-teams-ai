import { type ChildProcessWithoutNullStreams,spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

import {
  type PublicationHelperConfiguration,
  resolvePublicationHelper,
} from './publicationHelperPaths';
import {
  encodeFrame,
  HELPER_MARKER,
  HelperFrames,
  type HelperResult,
  parsePublicationRequest,
  parseReady,
  parseResult,
  type PublicationRequest,
} from './publicationHelperProtocol';

let configuration: PublicationHelperConfiguration | undefined;
let tail: Promise<void> = Promise.resolve();
let closed = false;
let disposal: Promise<void> | undefined;
let physicalRetirement: Promise<void> | undefined;
const knownOwned = new Map<string, PublicationRequest>();
const admissionMarkers = new Map<string, object>();
function authorityKey(request: PublicationRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        request.root,
        request.authority.schemaVersion,
        request.authority.service,
        request.authority.profileScope,
        request.authority.instanceId,
        request.authority.generation,
        request.authority.baseUrl,
        request.authority.token,
      ]),
    )
    .digest('hex');
}
let retiring = false;
let active:
  | { child: ChildProcessWithoutNullStreams; close: Promise<void> }
  | undefined;
const failure = (): Error =>
  new Error(
    'API authority publication helper failed; admission closed until owned exit',
  );

export function configurePublicationHelper(
  value: PublicationHelperConfiguration,
): void {
  if (configuration || active || closed)
    throw new Error('Publication helper already configured');
  configuration = { ...value };
}
export function publicationRootMode(): PublicationRequest['rootMode'] {
  if (!configuration || closed || retiring) throw failure();
  return configuration.prepareStandaloneRoot
    ? 'prepare-standalone-private'
    : 'existing';
}
function environment(
  mode: PublicationHelperConfiguration['mode'],
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  // No inherited Node options, loaders, inspect flags, auth/provider data, or execArgv.
  for (const key of [
    'HOME',
    'USERPROFILE',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
  ]) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  if (mode === 'electron-node') result.ELECTRON_RUN_AS_NODE = '1';
  return result;
}
async function run(
  request: PublicationRequest,
  retirement = false,
): Promise<HelperResult> {
  if (!configuration || (closed && !retirement) || retiring) throw failure();
  const configured = configuration;
  const artifact = await resolvePublicationHelper(configured);
  if ((closed && !retirement) || retiring) throw failure();
  // The executable and entry are exact app-owned paths, never shell/PATH resolved.
  const child = spawn(
    artifact.executable,
    [artifact.entry, HELPER_MARKER, configured.mode],
    {
      shell: false,
      windowsHide: true,
      env: environment(configured.mode),
      cwd: configured.directory,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  // Ignore diagnostic bytes rather than allowing raw child errors into a logger/DTO.
  child.stderr.resume();
  let observeClose!: () => void;
  const physicalClose = new Promise<void>((resolve) => {
    observeClose = resolve;
  });
  const owned = { child, close: physicalClose };
  active = owned;
  return new Promise<HelperResult>((resolve, reject) => {
    const frames = new HelperFrames(2);
    let result: HelperResult | undefined;
    let ready = false;
    let stdoutEnded = false;
    let settled = false;
    const finishFailure = (): void => {
      if (settled) return;
      settled = true;
      retiring = true;
      clearTimeout(timer);
      reject(failure());
      // This exact handle stays owned until close; no PID lookup/fallback or replay.
      child.stdin.destroy();
      // No termination at an unknown mutation point. Retain exact ownership until natural close.
    };
    const timer = setTimeout(finishFailure, 20_000);
    child.once('error', finishFailure);
    child.stdin.on('error', finishFailure);
    child.stdout.on('error', finishFailure);
    child.stderr.on('error', finishFailure);
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      try {
        for (const value of frames.push(chunk)) {
          if (!ready) {
            const announcement = parseReady(value);
            if (
              announcement.buildId !== artifact.buildId ||
              announcement.mode !== configured.mode
            )
              throw failure();
            ready = true;
            // Credentials enter only the private pipe after the actual-mode/build handshake.
            child.stdin.end(encodeFrame(request));
          } else {
            result = parseResult(value, request);
          }
        }
      } catch {
        finishFailure();
      }
    });
    child.stdout.once('end', () => {
      try {
        frames.end(2);
        stdoutEnded = true;
      } catch {
        finishFailure();
      }
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (active === owned) {
        active = undefined;
        retiring = false;
      }
      observeClose();
      if (settled) return;
      settled = true;
      if (code !== 0 || signal !== null || !stdoutEnded || !ready || !result)
        reject(failure());
      else resolve(result);
    });
  });
}
export function requestPublication(
  input: PublicationRequest,
): Promise<HelperResult> {
  // A retirement never queues new startup behind an unknown physical writer.
  if (closed || retiring || !configuration) return Promise.reject(failure());
  const request = parsePublicationRequest(input);
  const key = authorityKey(request);
  const admission = {};
  admissionMarkers.set(key, admission);
  // Consume at admission, even if queued/failed: retirement must never replay an
  // already attempted normal remove with an unknown outcome.
  if (request.op === 'remove') knownOwned.delete(key);
  const result = tail
    .then(() => run(request))
    .then(
      (result) => {
        if (
          admissionMarkers.get(key) === admission &&
          request.op === 'publish' &&
          ['published', 'retained'].includes(result.outcome)
        )
          knownOwned.set(key, request);
        if (admissionMarkers.get(key) === admission)
          admissionMarkers.delete(key);
        return result;
      },
      (error) => {
        if (admissionMarkers.get(key) === admission)
          admissionMarkers.delete(key);
        throw error;
      },
    );
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
/** Synchronous fence; active operations keep exact ownership and may finish naturally. */
export function closePublicationAdmission(): void {
  closed = true;
}
/** Only known settled publications can mint the private one-use retirement cleanup. */
export function disposePublicationHelper(): Promise<void> {
  closePublicationAdmission();
  if (!disposal) {
    disposal = (async () => {
      // Include bookkeeping from any already-active, proven close0 publication.
      await tail;
      if (active) await active.close;
      let failed = false;
      for (const [key, owned] of [...knownOwned]) {
        knownOwned.delete(key);
        const removal = parsePublicationRequest({
          ...owned,
          id: randomUUID(),
          op: 'remove',
          rootMode: 'existing',
        });
        try {
          const result = await run(removal, true);
          if (result.outcome !== 'removed') failed = true;
        } catch {
          failed = true;
        }
        // A logical failure is never a physical-close proof. No signal/replay.
        if (active) await active.close;
      }
      if (failed) throw failure();
    })();
    physicalRetirement = disposal.then(
      () => undefined,
      () => undefined,
    );
  }
  return disposal;
}
/** Bounded quit decision retains the SAME underlying exact physical retirement. */
export async function waitForPublicationHelperRetirement(
  timeoutMs = 5_000,
): Promise<'closed' | 'pending'> {
  void disposePublicationHelper().catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      physicalRetirement!.then(() => 'closed' as const),
      new Promise<'pending'>((resolve) => {
        timer = setTimeout(() => resolve('pending'), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
