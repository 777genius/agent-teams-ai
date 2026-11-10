import {
  parseSentryArtifactInventory,
  type SentryArtifactTarget,
  type SentryBuildIdentity,
  type SentryRuntimeArtifact,
  type SentryRuntimeInventory,
} from './sentryArtifactInventory';

type RecordValue = Record<string, unknown>;
export function sentryRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export interface SentryArtifactRoots {
  /** Exact application-owned file URL prefix, including its trailing slash. */
  fileUrl: string;
  /** Native path prefix obtained from Electron app.getAppPath, never from an event. */
  nativePath?: string;
  nativeSeparator?: '/' | '\\';
  rawTargets?: readonly SentryArtifactTarget[];
}
export interface SentryArtifactPolicy {
  artifact: (locator: unknown) => SentryRuntimeArtifact | null;
  frame: (frame: RecordValue) => SentryRuntimeArtifact | null;
  image: (image: RecordValue) => SentryRuntimeArtifact | null;
}
/** Generate exact spellings from admitted rows and trusted roots; never normalize incoming URLs. */
export function createSentryArtifactPolicy(
  inventories: readonly SentryRuntimeInventory[],
  expected: SentryBuildIdentity,
  roots: SentryArtifactRoots
): SentryArtifactPolicy | null {
  if (
    !expected.buildId ||
    !expected.gitSha ||
    !roots.fileUrl.startsWith('file:///') ||
    !roots.fileUrl.endsWith('/') ||
    /[?#\\\0]/.test(roots.fileUrl)
  )
    return null;
  const spellings = new Map<string, SentryRuntimeArtifact>();
  for (const input of inventories) {
    const inventory = parseSentryArtifactInventory(JSON.stringify(input), expected);
    if (!inventory) return null;
    for (const row of inventory.artifacts) {
      if (row.target === 'preload') continue;
      const locators = [row.locator];
      const rawAllowed = !roots.rawTargets || roots.rawTargets.includes(row.target);
      if (rawAllowed) locators.push(roots.fileUrl + row.relativeFile);
      if (rawAllowed && roots.nativePath && roots.nativeSeparator)
        locators.push(
          roots.nativePath +
            roots.nativeSeparator +
            row.relativeFile.split('/').join(roots.nativeSeparator)
        );
      for (const locator of locators) {
        const previous = spellings.get(locator);
        if (
          previous &&
          (previous.debugId !== row.debugId || previous.relativeFile !== row.relativeFile)
        )
          return null;
        spellings.set(locator, row);
      }
    }
  }
  if (!spellings.size) return null;
  const artifact = (locator: unknown) =>
    typeof locator === 'string' ? (spellings.get(locator) ?? null) : null;
  const frame = (value: RecordValue) => {
    const locators = [value.filename, value.abs_path].filter((locator) => locator !== undefined);
    if (!locators.length) return null;
    const rows = locators.map(artifact);
    const first = rows[0];
    return first &&
      rows.every(
        (row) =>
          row !== null && row.relativeFile === first.relativeFile && row.debugId === first.debugId
      )
      ? first
      : null;
  };
  return Object.freeze({
    artifact,
    frame,
    image: (value: RecordValue) => {
      const row = artifact(value.code_file);
      return value.type === 'sourcemap' && row && value.debug_id === row.debugId ? row : null;
    },
  });
}
/** Both required sidecars are one main-process admission boundary; relay rows are canonical only. */
export function createMainSentryArtifactPolicy(
  main: SentryRuntimeInventory | null,
  renderer: SentryRuntimeInventory | null,
  expected: SentryBuildIdentity,
  roots: SentryArtifactRoots
): SentryArtifactPolicy | null {
  if (!main || !renderer) return null;
  const admitted = [main, renderer].map((inventory) =>
    parseSentryArtifactInventory(JSON.stringify(inventory), expected)
  );
  for (const [index, inventory] of admitted.entries()) {
    const owner = index === 0 ? 'main' : 'renderer';
    if (
      !inventory ||
      inventory.artifacts.some((row) => row.target !== owner) ||
      Object.entries(inventory.coverage).some(
        ([target, status]) => target !== owner && status !== 'uncovered'
      )
    )
      return null;
  }
  return createSentryArtifactPolicy([main, renderer], expected, { ...roots, rawTargets: ['main'] });
}
/** These are the only structural frame positions admitted by the final redactor. */
export function isSentryFramePath(path: readonly string[], arrays: readonly number[]): boolean {
  return (
    path.length === 6 &&
    arrays.includes(2) &&
    arrays.includes(5) &&
    (path[0] === 'exception' || path[0] === 'threads') &&
    path[1] === 'values' &&
    /^\d+$/.test(path[2] ?? '') &&
    path[3] === 'stacktrace' &&
    path[4] === 'frames' &&
    /^\d+$/.test(path[5] ?? '')
  );
}
export function isSentryImagePath(path: readonly string[], arrays: readonly number[]): boolean {
  return (
    path.length === 3 &&
    arrays.includes(2) &&
    path[0] === 'debug_meta' &&
    path[1] === 'images' &&
    /^\d+$/.test(path[2] ?? '')
  );
}
// Exact runtime pseudo-files, not a `node:` prefix exception or artifact authorization.
// Keep this list bounded: unknown pseudo-files still fail closed.
const SAFE_RUNTIME_FILENAMES = new Set([
  'node:events',
  'node:timers',
  'node:internal/async_hooks',
  'node:internal/event_target',
  'node:internal/main/run_main_module',
  'node:internal/modules/cjs/loader',
  'node:internal/modules/esm/loader',
  'node:internal/modules/esm/module_job',
  'node:internal/modules/run_main',
  'node:internal/process/execution',
  'node:internal/process/task_queues',
  'node:internal/timers',
  'node:internal/worker',
  'node:internal/worker/io',
  'node:electron/js2c/browser_init',
  'node:electron/js2c/renderer_init',
]);
function hasSafeRuntimeFilename(frame: RecordValue): boolean {
  return (
    typeof frame.filename === 'string' &&
    SAFE_RUNTIME_FILENAMES.has(frame.filename) &&
    (frame.abs_path === undefined || frame.abs_path === frame.filename)
  );
}
/** Before NormalizePaths/applyDebugMeta: remove unconfirmed raw spellings and transient IDs. */
export function guardSentryArtifactEvent<T>(event: T, policy: SentryArtifactPolicy | null): T {
  if (!sentryRecord(event)) return event;
  const result: RecordValue = { ...event };
  for (const section of ['exception', 'threads']) {
    const container = event[section];
    if (!sentryRecord(container)) {
      if (container !== undefined) delete result[section];
      continue;
    }
    if (!Array.isArray(container.values)) {
      const copy = { ...container };
      delete copy.values;
      result[section] = copy;
      continue;
    }
    result[section] = {
      ...container,
      values: container.values.map((value: unknown) => {
        if (!sentryRecord(value)) return value;
        if (!sentryRecord(value.stacktrace)) {
          const copy = { ...value };
          delete copy.stacktrace;
          return copy;
        }
        if (!Array.isArray(value.stacktrace.frames)) {
          const copy = { ...value.stacktrace };
          delete copy.frames;
          return { ...value, stacktrace: copy };
        }
        return {
          ...value,
          stacktrace: {
            ...value.stacktrace,
            frames: value.stacktrace.frames.map((input: unknown) => {
              if (!sentryRecord(input)) return input;
              const frame: RecordValue = { ...input };
              const row = policy?.frame(input);
              const runtimeFilename = hasSafeRuntimeFilename(input);
              for (const key of ['filename', 'abs_path']) {
                if (row && input[key] !== undefined) frame[key] = row.locator;
                else if (key !== 'filename' || !runtimeFilename) delete frame[key];
              }
              if (!row || input.debug_id !== row.debugId) delete frame.debug_id;
              return frame;
            }),
          },
        };
      }),
    };
  }
  const meta = event.debug_meta;
  if (sentryRecord(meta) && !Array.isArray(meta.images)) {
    const copy = { ...meta };
    delete copy.images;
    result.debug_meta = copy;
  }
  if (sentryRecord(meta) && Array.isArray(meta.images)) {
    result.debug_meta = {
      ...meta,
      images: meta.images.flatMap((image: unknown) => {
        if (!sentryRecord(image) || image.type !== 'sourcemap') return [image];
        const row = policy?.image(image);
        return row ? [{ ...image, code_file: row.locator, debug_id: row.debugId }] : [];
      }),
    };
  }
  return result as T;
}
export function sentryArtifactGuardIntegration(policy: SentryArtifactPolicy | null) {
  return {
    name: 'ApplicationArtifactGuard',
    processEvent: <T>(event: T): T => guardSentryArtifactEvent(event, policy),
  };
}
