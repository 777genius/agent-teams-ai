import * as Sentry from '@sentry/electron/renderer';
import { loadRendererSentryArtifactPolicy } from '../../../src/renderer/sentryArtifactPolicy.js';
import { sentryArtifactGuardIntegration } from '../../../src/shared/utils/sentryArtifactPolicy.js';
import {
  filterSafeSentryIntegrations,
  redactSentryEvent,
} from '../../../src/shared/utils/sentryConfig.js';
import { fixtureKey, RELEASE, structural, PRESERVE_ARTIFACTS, NEIGHBORS } from './contract.js';
function observe<T>(operation: string, action: () => T): T {
  try {
    return action();
  } catch (error) {
    window.fixtureCapture.failure((operation + ': ' + String(error)).slice(0, 512));
    throw error;
  }
}
const artifactPolicy = PRESERVE_ARTIFACTS ? loadRendererSentryArtifactPolicy() : null;
if (PRESERVE_ARTIFACTS && !artifactPolicy) {
  window.fixtureCapture.failure('Application renderer inventory did not load');
  throw new Error('Application renderer inventory did not load');
}
Sentry.init({
  release: RELEASE,
  environment: 'development',
  sendDefaultPii: false,
  tracesSampleRate: 0,
  integrations: (defaults) => [
    {
      name: 'FixtureEarlyRendererObserver',
      processEvent(event) {
        return observe('renderer early', () => {
          if (fixtureKey(event)) window.fixtureCapture.snapshot('early', structural(event));
          return event;
        });
      },
    },
    ...(PRESERVE_ARTIFACTS ? [sentryArtifactGuardIntegration(artifactPolicy)] : []),
    ...filterSafeSentryIntegrations(defaults),
  ],
  beforeSend(event) {
    return observe('renderer beforeSend', () => {
      if (fixtureKey(event)) window.fixtureCapture.snapshot('beforeSend', structural(event));
      const redacted = redactSentryEvent(event, artifactPolicy) as typeof event;
      if (fixtureKey(event)) window.fixtureCapture.snapshot('afterRedactor', structural(redacted));
      return redacted;
    });
  },
});
// Electron 7.10.0 renderer init deletes initialScope; set the genuine scope after init.
Sentry.getCurrentScope().setTag('fixture.process', 'renderer');
if (PRESERVE_ARTIFACTS) Sentry.getCurrentScope().setExtra('fixture_neighbors', NEIGHBORS);
// Original producer index listens for this event; its actual dynamic chunk throws unhandled.
// Main dispatches after did-finish-load so the original application module is already running.
