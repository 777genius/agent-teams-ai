/** Literal IDs from independently retained, real locked-plugin producer output. */
export const EXPECTED = [
  { relativeFile: 'dist-electron/main/main.cjs', debugId: 'f9ade985-88de-43f0-905a-4de989b52f57' },
  {
    relativeFile: 'dist-electron/main/worker.cjs',
    debugId: '86f3eabd-8372-4f5d-9084-9fdf970d7f01',
  },
  {
    relativeFile: 'out/renderer/assets/dynamic-DijexZqW.js',
    debugId: '28400e46-bb24-4a22-b91b-c2266ec22b71',
  },
  {
    relativeFile: 'out/renderer/assets/index-CymqvycE.js',
    debugId: '47825fba-04de-4f60-8738-6ebdb88e86ac',
  },
] as const;
export const RELEASE = 'agent-teams-ai@inventory-sandbox';
export const IDENTITY = {
  release: RELEASE,
  buildId: 'inventory-sandbox',
  gitSha: '1234567890abcdef1234567890abcdef12345678',
} as const;
declare const __FIXTURE_PRESERVE_ARTIFACTS__: boolean;
export const PRESERVE_ARTIFACTS =
  typeof __FIXTURE_PRESERVE_ARTIFACTS__ === 'boolean' && __FIXTURE_PRESERVE_ARTIFACTS__;
export const NEIGHBORS = {
  uuid: EXPECTED[0].debugId,
  filename: '/Users/sdk-sandbox/private.log',
  debug_id: EXPECTED[1].debugId,
  code_file: '/home/sdk-sandbox/private.log',
};
export const MESSAGES = ['synthetic-main', 'synthetic-worker', 'synthetic-dynamic'] as const;
export type FixtureKey = 'main' | 'worker' | 'renderer';
type ExceptionValue = { exception?: { values?: readonly { value?: string }[] } };
export function fixtureKey(event: ExceptionValue): FixtureKey | null {
  const value = event.exception?.values?.[0]?.value;
  return value === MESSAGES[0]
    ? 'main'
    : value === MESSAGES[1]
      ? 'worker'
      : value === MESSAGES[2]
        ? 'renderer'
        : null;
}
export function structural<
  T extends {
    event_id?: string;
    exception?: unknown;
    debug_meta?: unknown;
    tags?: unknown;
    extra?: unknown;
  },
>(event: T): T {
  return JSON.parse(
    JSON.stringify({
      event_id: event.event_id,
      exception: event.exception,
      debug_meta: event.debug_meta,
      tags: event.tags,
      extra: event.extra,
    })
  ) as T;
}
export interface FixtureBridge {
  failure: (message: string) => void;
  snapshot: (stage: 'early' | 'beforeSend' | 'afterRedactor', event: unknown) => void;
}
declare global {
  interface Window {
    fixtureCapture: FixtureBridge;
  }
}

/** SDK-independent structural DTO: each value comes from a genuine recorded SDK stage. */
export interface Snapshot {
  event_id?: string;
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  exception?: {
    values?: {
      value?: string;
      stacktrace?: { frames?: { filename?: string; debug_id?: string }[] };
    }[];
  };
  debug_meta?: { images?: { type: string; code_file?: string; debug_id?: string }[] };
}
export type Chain = Record<string, Snapshot>;
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function frames(event: Snapshot) {
  return event.exception?.values?.flatMap((value) => value.stacktrace?.frames ?? []) ?? [];
}
/** Independently literal associations and full chain, including serialized-envelope stages. */
export function validateChain(chain: Chain, appRoot: string, preserve = false): void {
  const raw = (file: string, renderer: boolean) =>
    renderer
      ? new URL('file://' + appRoot.split('/').map(encodeURIComponent).join('/') + '/' + file).href
      : appRoot + '/' + file;
  const ids = new Set<string>();
  for (const key of ['main', 'worker', 'renderer'] as const) {
    const relay = key === 'renderer';
    const names = relay
      ? [
          'renderer-early',
          'renderer-beforeSend',
          'renderer-afterRedactor',
          'ipc',
          'early',
          'afterNormalize',
          'beforeSend',
          'afterRedactor',
          'transport',
        ]
      : ['early', 'afterNormalize', 'beforeSend', 'afterRedactor', 'transport'];
    const first = chain[key + '-' + names[0]];
    check(first && /^[a-f0-9]{32}$/.test(first.event_id ?? ''), key + ': missing SDK event_id');
    check(!ids.has(first.event_id!), key + ': reused event_id');
    ids.add(first.event_id!);
    const rows = relay ? EXPECTED.slice(2) : [EXPECTED[key === 'main' ? 0 : 1]];
    for (const stage of names) {
      const event = chain[key + '-' + stage];
      check(event && fixtureKey(event) === key, key + ': missing/wrong stage ' + stage);
      check(event.event_id === first.event_id, key + ': changed event_id at ' + stage);
      check(
        event.tags?.['fixture.process'] === (relay ? 'renderer' : 'main'),
        key + ': wrong fixture process scope at ' + stage
      );
      if (
        relay &&
        ['early', 'afterNormalize', 'beforeSend', 'afterRedactor', 'transport'].includes(stage)
      )
        check(
          event.tags?.['event.process'] === 'renderer',
          'Missing renderer relay process scope at ' + stage
        );
      const transient =
        stage === 'renderer-early' || (!relay && ['early', 'afterNormalize'].includes(stage));
      const normalized = !relay
        ? stage !== 'early'
        : preserve
          ? stage !== 'renderer-early'
          : ['afterNormalize', 'beforeSend', 'afterRedactor', 'transport'].includes(stage);
      const corrupted =
        !preserve &&
        (relay
          ? !['renderer-early', 'renderer-beforeSend'].includes(stage)
          : ['afterRedactor', 'transport'].includes(stage));
      const redacted = relay
        ? !['renderer-early', 'renderer-beforeSend'].includes(stage)
        : ['afterRedactor', 'transport'].includes(stage);
      if (preserve && redacted)
        check(
          JSON.stringify(event.extra?.fixture_neighbors) ===
            JSON.stringify({
              uuid: '[redacted]',
              filename: '/Users/[redacted]/[redacted-path]',
              debug_id: '[redacted]',
              code_file: '/home/[redacted]/[redacted-path]',
            }),
          key + ': neighbouring privacy data survived ' + stage
        );
      const images = event.debug_meta?.images?.filter((image) => image.type === 'sourcemap') ?? [];
      if (!transient) check(images.length === rows.length, key + ': lost/extra image at ' + stage);
      for (const row of rows) {
        const locator = normalized ? 'app:///' + row.relativeFile : raw(row.relativeFile, relay);
        const matchingFrames = frames(event).filter((frame) => frame.filename === locator);
        check(
          matchingFrames.length > 0,
          key + ': missing exact frame at ' + stage + ': ' + locator
        );
        if (transient)
          check(
            matchingFrames.some((frame) => frame.debug_id === row.debugId),
            key + ': missing transient ID'
          );
        else {
          check(
            matchingFrames.every((frame) => frame.debug_id === undefined),
            key + ': transient ID survived applyDebugMeta'
          );
          const pairs = images.filter((image) => image.code_file === locator);
          check(
            pairs.length === 1 && pairs[0]?.debug_id === (corrupted ? '[redacted]' : row.debugId),
            key + ': changed pair at ' + stage
          );
        }
      }
    }
  }
}
