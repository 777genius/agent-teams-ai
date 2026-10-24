import * as Sentry from '@sentry/electron/main';
import { app, BrowserWindow, ipcMain, session } from 'electron';
import { loadMainSentryArtifactPolicy } from '../../../src/main/sentryArtifactPolicy.js';
import { sentryArtifactGuardIntegration } from '../../../src/shared/utils/sentryArtifactPolicy.js';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  filterSafeSentryIntegrations,
  redactSentryEvent,
} from '../../../src/shared/utils/sentryConfig.js';
import {
  EXPECTED,
  PRESERVE_ARTIFACTS,
  NEIGHBORS,
  fixtureKey,
  RELEASE,
  structural,
  type FixtureKey,
  validateChain,
  type Chain,
} from './contract.js';
import type { Event } from '@sentry/electron/main';

const appRoot = app.getAppPath();
const artifactPolicy = PRESERVE_ARTIFACTS ? loadMainSentryArtifactPolicy() : null;
if (PRESERVE_ARTIFACTS) assert.ok(artifactPolicy, 'Application main inventory did not load');
const output = join(dirname(appRoot), 'evidence');
const requireFixture = createRequire(join(appRoot, 'fixture-main.cjs'));
const sdkEntry = requireFixture.resolve('@sentry/electron/main');
const sdkRequire = createRequire(sdkEntry);
const core = sdkRequire('@sentry/core') as {
  SDK_VERSION: string;
  parseEnvelope(value: string): [{ event_id?: string }, [unknown, Event][]];
};
assert.equal(core.SDK_VERSION, '10.42.0');
app.setPath('userData', join(dirname(appRoot), 'home', 'user-data'));
app.setPath('sessionData', join(dirname(appRoot), 'home', 'session-data'));
app.commandLine.appendSwitch('disable-background-networking');
const stages = new Map<string, Event>();
const sent = new Set<FixtureKey>();
const captureFailures: string[] = [];
function failCapture(operation: string, error: unknown): void {
  if (captureFailures.length < 8)
    captureFailures.push((operation + ': ' + String(error)).slice(0, 512));
  // Latch in memory before persistence or rethrow; SDK callbacks may swallow either failure.
  writeFileSync(join(output, 'capture-failures.json'), JSON.stringify(captureFailures, null, 2));
}
function observe<T>(operation: string, action: () => T): T {
  try {
    return action();
  } catch (error) {
    failCapture(operation, error);
    throw error;
  }
}
function healthyCapture(): void {
  assert.deepEqual(captureFailures, [], 'Persistent SDK observation failure');
}
let browserRequestsBlocked = 0;
let window: BrowserWindow | undefined;
let resolveComplete: () => void = () => undefined;
const complete = new Promise<void>((resolve) => {
  resolveComplete = resolve;
});
function save(stage: string, event: Event): void {
  const key = fixtureKey(event);
  if (!key) return;
  assert.ok(!stages.has(`${key}-${stage}`), `Duplicate SDK capture stage: ${key}-${stage}`);
  const copy = structural(event);
  stages.set(`${key}-${stage}`, copy);
  writeFileSync(join(output, `${key}-${stage}.json`), JSON.stringify(copy, null, 2) + '\n');
}
function observer(name: string, stage: string) {
  return {
    name,
    processEvent(event: Event) {
      return observe('main ' + stage, () => {
        save(stage, event);
        return event;
      });
    },
  };
}
ipcMain.on('fixture.failure', ({ sender }, message: unknown) => {
  if (sender !== window?.webContents) return;
  failCapture(
    'renderer callback',
    typeof message === 'string' ? message : 'invalid failure notification'
  );
});
ipcMain.on('fixture.snapshot', ({ sender }, payload: { stage: string; event: Event }) => {
  if (sender !== window?.webContents) return;
  observe('owned renderer snapshot', () => {
    assert.ok(['early', 'beforeSend', 'afterRedactor'].includes(payload.stage));
    save(`renderer-${payload.stage}`, payload.event);
  });
});
// Observe bytes without replacing/mutating the SDK's own Classic IPC listener.
ipcMain.on('sentry-ipc.envelope', ({ sender }, body: string | Uint8Array) => {
  if (sender !== window?.webContents) return;
  observe('owned Classic IPC envelope', () => {
    const bytes = typeof body === 'string' ? body : Buffer.from(body).toString('utf8');
    if (core.parseEnvelope(bytes)[1].some(([, event]) => fixtureKey(event) === 'renderer'))
      writeFileSync(join(output, 'renderer-ipc.envelope'), bytes);
  });
});
Sentry.init({
  dsn: 'https://fixture@127.0.0.1/1',
  release: RELEASE,
  environment: 'development',
  ipcMode: Sentry.IPCMode.Classic,
  sendDefaultPii: false,
  initialScope: { tags: { 'fixture.process': 'main' } },
  tracesSampleRate: 0,
  sendClientReports: false,
  skipOpenTelemetrySetup: true,
  integrations: (defaults) => [
    observer('FixtureBeforeNormalizePaths', 'early'),
    ...(PRESERVE_ARTIFACTS ? [sentryArtifactGuardIntegration(artifactPolicy)] : []),
    ...filterSafeSentryIntegrations(defaults),
    observer('FixtureAfterNormalizePaths', 'afterNormalize'),
  ],
  beforeSend(event) {
    return observe('main beforeSend', () => {
      save('beforeSend', event);
      const redacted = redactSentryEvent(event, artifactPolicy) as typeof event;
      save('afterRedactor', redacted);
      return redacted;
    });
  },
  transport: (options) =>
    Sentry.createTransport(options, async (request) =>
      observe('SDK transport serialization', () => {
        const body =
          typeof request.body === 'string'
            ? request.body
            : Buffer.from(request.body).toString('utf8');
        const parsed = core.parseEnvelope(body);
        for (const [, event] of parsed[1]) {
          const key = fixtureKey(event);
          if (!key) continue;
          writeFileSync(join(output, `${key}-final.envelope`), body);
          save('transport', event);
          sent.add(key);
        }
        if (sent.size === 3) resolveComplete();
        return { statusCode: 200 };
      })
    ),
});
if (PRESERVE_ARTIFACTS) Sentry.getCurrentScope().setExtra('fixture_neighbors', NEIGHBORS);
function validate(): Chain {
  healthyCapture();
  const chain = Object.fromEntries(stages) as Chain;
  const ipcEnvelope = core.parseEnvelope(
    readFileSync(join(output, 'renderer-ipc.envelope'), 'utf8')
  );
  const ipc = ipcEnvelope[1].filter(([, event]) => fixtureKey(event) === 'renderer');
  assert.equal(ipc.length, 1, 'Exactly one real renderer IPC event');
  assert.equal(ipcEnvelope[0].event_id, ipc[0]![1].event_id, 'IPC header event identity');
  chain['renderer-ipc'] = structural(ipc[0]![1]) as Chain[string];
  for (const key of ['main', 'worker', 'renderer']) {
    const envelope = core.parseEnvelope(
      readFileSync(join(output, `${key}-final.envelope`), 'utf8')
    );
    const final = envelope[1].filter(([, event]) => fixtureKey(event) === key);
    assert.equal(final.length, 1, 'Exactly one serialized final event per capture');
    assert.equal(envelope[0].event_id, final[0]![1].event_id, 'Final header event identity');
    assert.deepEqual(structural(final[0]![1]), chain[`${key}-transport`]);
  }
  validateChain(chain, appRoot, PRESERVE_ARTIFACTS);
  healthyCapture();
  return chain;
}
async function run(): Promise<void> {
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const cancel = !details.url.startsWith(pathToFileURL(appRoot + '/').href);
    if (cancel) browserRequestsBlocked++;
    callback({ cancel });
  });
  for (const [file, name] of [
    ['main.cjs', 'syntheticMain'],
    ['worker.cjs', 'syntheticWorker'],
  ]) {
    const probe = requireFixture(join(appRoot, 'dist-electron/main', file!)) as Record<
      string,
      () => void
    >;
    try {
      probe[name!]!();
    } catch (error) {
      Sentry.captureException(error);
    }
  }
  window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(appRoot, 'fixture-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  await window.loadFile(join(appRoot, 'out/renderer/index.html'));
  await window.webContents.executeJavaScript('window.dispatchEvent(new Event("synthetic"))');
  await Promise.race([
    complete,
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () =>
          reject(new Error('SDK fixture timed out waiting for all three real transport events')),
        30_000
      )
    ),
  ]);
  assert.equal(await Sentry.flush(3000), true, 'SDK flush did not complete');
  healthyCapture();
  const chain = validate();
  if (process.env.SENTRY_FIXTURE_DUPLICATE_OBSERVATION === '1') {
    writeFileSync(
      join(output, 'observation-base.json'),
      JSON.stringify(
        { appRoot, chain, artifactMode: PRESERVE_ARTIFACTS ? 'preserve' : 'baseline' },
        null,
        2
      )
    );
    const probe = requireFixture(join(appRoot, EXPECTED[0].relativeFile)) as {
      syntheticMain(): void;
    };
    try {
      probe.syntheticMain();
    } catch (error) {
      Sentry.captureException(error);
    }
    assert.equal(await Sentry.flush(3000), true, 'Duplicate observation flush did not complete');
    healthyCapture();
    throw new Error('Duplicate actual SDK capture failed to latch observation failure');
  }
  healthyCapture();
  writeFileSync(
    join(output, 'sdk-receipt.json'),
    JSON.stringify(
      {
        electronSdk: '7.10.0',
        coreSdk: core.SDK_VERSION,
        electron: process.versions.electron,
        platform: process.platform,
        appRoot,
        captured: [...sent],
        chain,
        inputByteProof: JSON.parse(
          readFileSync(join(dirname(appRoot), 'input-byte-proof.json'), 'utf8')
        ),
        expected: EXPECTED,
        boundary:
          'actual Electron renderer -> unchanged preload bridge -> real Classic IPC -> main SDK -> memory transport',
        currentRedactorCorruptsValidIds: !PRESERVE_ARTIFACTS,
        artifactMode: PRESERVE_ARTIFACTS ? 'preserve' : 'baseline',
        artifactPairsPreserved: PRESERVE_ARTIFACTS,
        captureFailures,
        transport: 'in-memory callback; no HTTP request implementation',
        backendUploadTested: false,
        browserRequestsBlocked,
        preloadCoverage: 'uncovered',
        windowsFixture: 'not-tested',
      },
      null,
      2
    )
  );
  healthyCapture();
}
void run()
  .then(() => {
    // app.exit closes the owned windows with this status before window-all-closed can quit.
    app.exit(0);
  })
  .catch((error) => {
    writeFileSync(
      join(output, 'failure.json'),
      JSON.stringify(
        {
          message: String(error),
          stack: error instanceof Error ? error.stack : null,
          captureFailures,
        },
        null,
        2
      )
    );
    // app.exit closes the owned windows with this status before window-all-closed can quit.
    app.exit(1);
  });
